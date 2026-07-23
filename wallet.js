// Buyer prepaid wallet.
//
// Instead of a CryptoBot invoice per campaign, a buyer tops up a wallet once
// (a USDT check/invoice, same method as before) and campaigns are paid from
// that balance instantly. Top-ups are pending until the invoice is paid, then
// reconciled into the balance.
const { loadJSON, saveJSON } = require('./database.js');

const minTopup = () => Number(process.env.MIN_TOPUP) || 5; // $ (live: applies on Save)
const { round2 } = require('./round.js');

function loadWallets() {
    const r = loadJSON('wallets.json', {});
    return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}
function saveWallets(w) { saveJSON('wallets.json', w); }
function ensure(w, id) { if (!w[id]) w[id] = { balance: 0, topups: [] }; if (!Array.isArray(w[id].topups)) w[id].topups = []; return w[id]; }

function balanceOf(buyerId) { return round2(loadWallets()[buyerId]?.balance || 0); }

function credit(buyerId, amount) {
    const w = loadWallets(); const wa = ensure(w, buyerId);
    wa.balance = round2((wa.balance || 0) + (Number(amount) || 0));
    saveWallets(w); return wa.balance;
}
// Owner-only: set the wallet balance to an exact value (returns it).
function setBalance(buyerId, value) {
    const w = loadWallets(); const wa = ensure(w, buyerId);
    wa.balance = round2(Number(value) || 0);
    saveWallets(w); return wa.balance;
}
// Returns the new balance, or null if insufficient funds.
function debit(buyerId, amount) {
    const amt = round2(amount);
    const w = loadWallets(); const wa = ensure(w, buyerId);
    if (round2(wa.balance || 0) < amt) return null;
    wa.balance = round2((wa.balance || 0) - amt);
    saveWallets(w); return wa.balance;
}
// Keep every pending top-up (needed for reconciliation) plus the most recent
// settled ones (only shown as history); drop older settled receipts so the
// array can't grow without bound.
const KEEP_SETTLED_TOPUPS = 50;
function pruneTopups(list) {
    const arr = Array.isArray(list) ? list : [];
    const pending = arr.filter((t) => t.status === 'pending');
    const settled = arr.filter((t) => t.status !== 'pending');
    return settled.length > KEEP_SETTLED_TOPUPS
        ? [...pending, ...settled.slice(-KEEP_SETTLED_TOPUPS)]
        : arr;
}
function addTopup(buyerId, rec) {
    const w = loadWallets(); const wa = ensure(w, buyerId);
    wa.topups.push(rec);
    wa.topups = pruneTopups(wa.topups);
    saveWallets(w);
}

// Credit any pending top-ups whose invoice is now paid. isPaidFn(invoiceId) →
// Promise<boolean>.
async function reconcileTopups(buyerId, isPaidFn) {
    const wa0 = loadWallets()[buyerId];
    if (!wa0 || !Array.isArray(wa0.topups)) return 0;
    // Phase 1 (async): find which pending invoices are now paid. The isPaidFn
    // await yields the event loop, so we must NOT hold a wallets snapshot across
    // it — a concurrent debit/credit would be clobbered by our later save.
    const paid = new Set();
    for (const t of wa0.topups) {
        if (t.status === 'pending' && t.invoiceId && await isPaidFn(t.invoiceId).catch(() => false)) paid.add(t.invoiceId);
    }
    if (!paid.size) return 0;
    // Phase 2 (synchronous, atomic): re-load fresh and apply, so nothing written
    // during the await above is lost.
    const w = loadWallets(); const wa = ensure(w, buyerId);
    let credited = 0;
    for (const t of wa.topups) {
        if (t.status === 'pending' && t.invoiceId && paid.has(t.invoiceId)) {
            t.status = 'paid'; t.paidAt = Date.now();
            wa.balance = round2((wa.balance || 0) + (Number(t.amount) || 0));
            credited += Number(t.amount) || 0;
        }
    }
    if (credited > 0) saveWallets(w);
    return round2(credited);
}

// Pending top-ups for one provider (e.g. 'nowpayments') — used to reconcile against
// the gateway as a webhook fallback.
function pendingByProvider(buyerId, provider) {
    const wa = loadWallets()[buyerId];
    return (wa?.topups || []).filter((t) => t.status === 'pending' && t.provider === provider);
}

// Mark a specific pending top-up paid and credit it (idempotent). `match` is a set
// of fields to match on the top-up record, e.g. { orderId } or { invoiceId }.
// Returns the credited amount (0 if already paid / not found).
function settlePending(buyerId, match) {
    const w = loadWallets(); const wa = ensure(w, buyerId);
    let credited = 0;
    for (const t of wa.topups) {
        if (t.status !== 'pending') continue;
        const hit = Object.keys(match).every((k) => t[k] != null && String(t[k]) === String(match[k]));
        if (hit) {
            t.status = 'paid'; t.paidAt = Date.now();
            wa.balance = round2((wa.balance || 0) + (Number(t.amount) || 0));
            credited += Number(t.amount) || 0;
        }
    }
    if (credited > 0) saveWallets(w);
    return round2(credited);
}

// Attach fields to a pending top-up matched by orderId (e.g. the gateway payment id
// once the first webhook arrives) so later reconciliation can query the gateway.
function updatePending(buyerId, orderId, patch) {
    const w = loadWallets(); const wa = ensure(w, buyerId);
    let changed = false;
    for (const t of wa.topups) {
        if (t.status === 'pending' && String(t.orderId) === String(orderId)) { Object.assign(t, patch); changed = true; }
    }
    if (changed) saveWallets(w);
    return changed;
}

function recentTopups(buyerId, limit = 20) {
    const wa = loadWallets()[buyerId];
    return (wa?.topups || []).slice(-limit).reverse()
        .map((t) => ({ amount: round2(t.amount), status: t.status, createdAt: t.createdAt || 0, paidAt: t.paidAt || 0 }));
}

// Total prepaid money sitting on all buyer wallets (topped up, not yet spent).
function totalHeld() {
    const w = loadWallets();
    return round2(Object.values(w).reduce((a, x) => a + (Number(x?.balance) || 0), 0));
}

module.exports = { get MIN_TOPUP() { return minTopup(); }, balanceOf, credit, debit, setBalance, addTopup, reconcileTopups, pendingByProvider, settlePending, updatePending, recentTopups, totalHeld, round2 };

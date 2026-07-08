// Buyer prepaid wallet.
//
// Instead of a CryptoBot invoice per campaign, a buyer tops up a wallet once
// (a USDT check/invoice, same method as before) and campaigns are paid from
// that balance instantly. Top-ups are pending until the invoice is paid, then
// reconciled into the balance.
const { loadJSON, saveJSON } = require('./database.js');

const MIN_TOPUP = Number(process.env.MIN_TOPUP) || 5; // $
const round2 = (n) => +((Number(n) || 0).toFixed(2));

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
// Returns the new balance, or null if insufficient funds.
function debit(buyerId, amount) {
    const amt = round2(amount);
    const w = loadWallets(); const wa = ensure(w, buyerId);
    if (round2(wa.balance || 0) < amt) return null;
    wa.balance = round2((wa.balance || 0) - amt);
    saveWallets(w); return wa.balance;
}
function addTopup(buyerId, rec) {
    const w = loadWallets(); const wa = ensure(w, buyerId);
    wa.topups.push(rec); saveWallets(w);
}

// Credit any pending top-ups whose invoice is now paid. isPaidFn(invoiceId) →
// Promise<boolean>.
async function reconcileTopups(buyerId, isPaidFn) {
    const w = loadWallets(); const wa = w[buyerId];
    if (!wa || !Array.isArray(wa.topups)) return 0;
    let credited = 0;
    for (const t of wa.topups) {
        if (t.status === 'pending' && t.invoiceId && await isPaidFn(t.invoiceId).catch(() => false)) {
            t.status = 'paid'; t.paidAt = Date.now();
            wa.balance = round2((wa.balance || 0) + (Number(t.amount) || 0));
            credited += Number(t.amount) || 0;
        }
    }
    if (credited > 0) saveWallets(w);
    return round2(credited);
}

function recentTopups(buyerId, limit = 20) {
    const wa = loadWallets()[buyerId];
    return (wa?.topups || []).slice(-limit).reverse()
        .map((t) => ({ amount: round2(t.amount), status: t.status, createdAt: t.createdAt || 0, paidAt: t.paidAt || 0 }));
}

module.exports = { MIN_TOPUP, balanceOf, credit, debit, addTopup, reconcileTopups, recentTopups, round2 };

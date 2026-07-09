// Investor cabinet.
//
// An investor tops up an investment account (USDT, same top-up flow as the buyer
// wallet) and "buys" future invites of a server at a discount to retail: $9 per
// 100 ($0.09/invite) vs the $10/100 the service sells them for. As that server
// delivers paid joins (its invites get sold), the investor's invites fill up in
// FIFO order across ALL investors on that server, and each sold invite returns
// $0.09 + 10% = $0.099 to their account. There is no deadline — the return is
// realized purely as the invites actually sell.
//
// Everything money-facing is derived on read from the position ledger + the paid
// join log (verified.json), so balances are always exact and there is no sweep:
//   available = topups(paid) − Σ bought(qty·$0.09) + Σ sold·$0.099 − withdrawn
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');
const cards = require('./cards.js');

// If a server loses the bot or its last active verification card, its undelivered
// invites are refunded to investors at the $9/100 buy price — but only after this
// grace period, in case the server comes back. Set INVEST_REFUND_GRACE_HOURS.
const GRACE_MS = (Number(process.env.INVEST_REFUND_GRACE_HOURS) || 24) * 3600000;

const round2 = (n) => +((Number(n) || 0).toFixed(2));
const round4 = (n) => +((Number(n) || 0).toFixed(4));

const BUY_PER_100 = Number(process.env.INVEST_BUY_PER_100) || 9;     // $ investor pays per 100
const SELL_PER_100 = Number(process.env.JOIN_SALE_PRICE) || 10;      // $ service resells per 100
const RETURN_RATE = Number.isFinite(Number(process.env.INVEST_RETURN_RATE)) ? Number(process.env.INVEST_RETURN_RATE) : 0.10;
const BUY_PER_INVITE = round4(BUY_PER_100 / 100);                    // $0.09
const RET_PER_INVITE = round4(BUY_PER_INVITE * (1 + RETURN_RATE));   // $0.099
// Dedicated minimum for the investment account; falls back to the shared
// MIN_TOPUP, then $5. Set INVEST_MIN_TOPUP in Railway to change it.
const MIN_TOPUP = Number(process.env.INVEST_MIN_TOPUP) || Number(process.env.MIN_TOPUP) || 5;
const MIN_BUY = Number(process.env.INVEST_MIN_INVITES) || 100;
// A buy-in must cover at least this many days of the server's sales, so an
// investor can't buy a tiny slice of a fast server. Set INVEST_MIN_DAYS in Railway.
const MIN_DAYS = Number(process.env.INVEST_MIN_DAYS) || 30;
// A server auto-appears in the investor list once it sells at least this many
// verified invites per day; it drops off (for everyone but existing holders)
// when it falls below. Set INVEST_MIN_DAILY in Railway.
const MIN_DAILY = Number(process.env.INVEST_MIN_DAILY) || 10;

// A server's sales rate — verified invites per day, averaged over the last 7 days.
function serverDailyRate(serverId, verified, now = Date.now()) {
    let week = 0;
    for (const u of (Array.isArray(verified) ? verified : [])) {
        if (u && u.adKey && String(u.guildId) === String(serverId) && (Number(u.timestamp) || 0) > now - 604800000) week++;
    }
    return week / 7;
}
// Minimum invites to buy on a server = daily rate × MIN_DAYS (floor MIN_BUY).
function serverMinInvites(serverId, verified) {
    return Math.max(MIN_BUY, Math.ceil(serverDailyRate(serverId, verified) * MIN_DAYS));
}
// Is a server open for buy-in right now? Auto: daily rate ≥ MIN_DAILY. The owner
// whitelist can also force a below-threshold server open.
function isServerInvestable(serverId, verified) {
    return serverDailyRate(serverId, verified) >= MIN_DAILY || isServerEnabled(serverId);
}

function load() { const r = loadJSON('investors.json', {}); return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {}; }
function save(o) { saveJSON('investors.json', o); }

// Owner-curated whitelist of servers investors may buy invites of. A server can
// only be added while it has an active verification card (checked by the API).
function loadEnabledServers() { const r = loadJSON('investservers.json', []); return Array.isArray(r) ? r.map(String) : []; }
function saveEnabledServers(list) { const uniq = [...new Set((Array.isArray(list) ? list : []).map(String))]; saveJSON('investservers.json', uniq); return uniq; }
function isServerEnabled(id) { return loadEnabledServers().includes(String(id)); }
function addEnabledServer(id) { const l = loadEnabledServers(); if (!l.includes(String(id))) l.push(String(id)); return saveEnabledServers(l); }
function removeEnabledServer(id) { return saveEnabledServers(loadEnabledServers().filter((x) => x !== String(id))); }

// Owner-side manual credit of an investment account (bypasses CryptoBot).
function manualTopup(userId, amount) {
    const amt = round2(amount);
    if (!(amt > 0)) return { ok: false, error: 'bad-amount' };
    const all = load(); const u = ensure(all, userId);
    u.topups.push({ amount: amt, status: 'paid', manual: true, createdAt: Date.now(), paidAt: Date.now() });
    save(all);
    return { ok: true, amount: amt };
}
function ensure(o, id) {
    if (!o[id]) o[id] = { topups: [], positions: [], withdrawn: 0 };
    const u = o[id];
    if (!Array.isArray(u.topups)) u.topups = [];
    if (!Array.isArray(u.positions)) u.positions = [];
    if (!Number.isFinite(Number(u.withdrawn))) u.withdrawn = 0;
    return u;
}

// Timestamps of paid joins (sold invites) delivered by a server — grouped by the
// card's own server (verified.json guildId), so several cards on one server
// aggregate into ONE server total, never double-counted.
function serverJoinTimes(serverId, verified) {
    const out = [];
    for (const u of (Array.isArray(verified) ? verified : [])) {
        if (u && u.adKey && String(u.guildId) === String(serverId)) out.push(Number(u.timestamp) || 0);
    }
    out.sort((a, b) => a - b);
    return out;
}

// Allocate a server's sold invites to positions, FIFO across ALL investors:
// each sold invite goes to the earliest-bought position that (a) was bought
// before the join and (b) isn't full yet. Returns Map<positionId, fillTimes[]>.
function allocateServer(serverId, all, verified) {
    const positions = [];
    for (const uid of Object.keys(all)) {
        for (const p of (all[uid].positions || [])) if (String(p.serverId) === String(serverId)) positions.push(p);
    }
    positions.sort((a, b) => (a.boughtAt || 0) - (b.boughtAt || 0) || String(a.id).localeCompare(String(b.id)));
    const fills = new Map(positions.map((p) => [p.id, []]));
    if (!positions.length) return fills;
    for (const t of serverJoinTimes(serverId, verified)) {
        for (const p of positions) {
            if ((p.boughtAt || 0) >= t) continue;
            const arr = fills.get(p.id);
            if (arr.length >= (Number(p.qty) || 0)) continue;
            arr.push(t); break;
        }
    }
    return fills;
}

// A server is "occupied" while any investor still has unsold invites there —
// only one investor at a time. Returns who occupies it and an ETA (seconds) to
// free = total outstanding invites ÷ the server's daily sales rate.
function occupancyOf(serverId, verified, all = load()) {
    const positions = [];
    for (const uid of Object.keys(all)) for (const p of (all[uid].positions || [])) if (String(p.serverId) === String(serverId)) positions.push({ p, uid });
    if (!positions.length) return { occupants: new Set(), totalOutstanding: 0, etaSec: null };
    const fills = allocateServer(serverId, all, verified);
    const occupants = new Set(); let totalOutstanding = 0;
    for (const { p, uid } of positions) {
        const sold = (fills.get(p.id) || []).length;
        const out = Math.max(0, (Number(p.qty) || 0) - sold);
        if (out > 0) { occupants.add(uid); totalOutstanding += out; }
    }
    const daily = serverDailyRate(serverId, verified);
    const etaSec = (daily > 0 && totalOutstanding > 0) ? Math.ceil((totalOutstanding / daily) * 86400) : null;
    return { occupants, totalOutstanding, etaSec };
}

// Total unsold (outstanding) invites across all investors on a server. Used at
// join-delivery time: while this is > 0, the next paid join fills an investor
// invite, so its revenue funds the investor's return (the shareholder split for
// it already happened at buy-in) and the normal per-join payShares is skipped.
function serverOutstanding(serverId, verified) {
    const all = load();
    const fills = allocateServer(serverId, all, verified);
    let out = 0;
    for (const uid of Object.keys(all)) for (const p of (all[uid].positions || [])) if (String(p.serverId) === String(serverId)) out += Math.max(0, (Number(p.qty) || 0) - (fills.get(p.id) || []).length);
    return out;
}

// The service's per-invite net profit distributed to shares at buy-in, given
// the server's actual partner payout rate ($/100). Over the full lifecycle:
// resale revenue − partner payout − acquiring − the investor's profit.
function buyinProfitPerInvite(partnerPer100 = 5, acquiringRate = 0.03) {
    const sell = SELL_PER_100 / 100;
    const partner = (Number(partnerPer100) || 5) / 100;
    const investorProfit = BUY_PER_INVITE * RETURN_RATE;
    return Math.max(0, sell - partner - partner * acquiringRate - investorProfit);
}

// The investor's live account: liquid balance + lifetime figures.
function accountOf(userId, verified) {
    const all = load();
    const u = all[userId] || { topups: [], positions: [], withdrawn: 0 };
    const topupsPaid = (u.topups || []).filter((t) => t.status === 'paid').reduce((a, t) => a + (Number(t.amount) || 0), 0);
    const invested = (u.positions || []).reduce((a, p) => a + (Number(p.qty) || 0) * BUY_PER_INVITE, 0);

    let owned = 0, sold = 0, returns = 0;
    const byServer = {};
    for (const p of (u.positions || [])) { (byServer[p.serverId] ||= []).push(p); owned += Number(p.qty) || 0; }
    for (const serverId of Object.keys(byServer)) {
        const fills = allocateServer(serverId, all, verified);
        for (const p of byServer[serverId]) { const n = (fills.get(p.id) || []).length; sold += n; returns += n * RET_PER_INVITE; }
    }
    const withdrawn = Number(u.withdrawn) || 0;
    const available = round2(topupsPaid - invested + returns - withdrawn);
    return {
        available: Math.max(0, available),
        invested: round2(invested), returned: round2(returns), withdrawn: round2(withdrawn),
        profit: round2(returns - sold * BUY_PER_INVITE),
        owned, sold, outstanding: owned - sold
    };
}

function addTopup(userId, rec) { const all = load(); const u = ensure(all, userId); u.topups.push(rec); save(all); }
async function reconcileTopups(userId, isPaidFn) {
    const all = load(); const u = all[userId];
    if (!u || !Array.isArray(u.topups)) return 0;
    let credited = 0;
    for (const t of u.topups) {
        if (t.status === 'pending' && t.invoiceId && await isPaidFn(t.invoiceId).catch(() => false)) {
            t.status = 'paid'; t.paidAt = Date.now(); credited += Number(t.amount) || 0;
        }
    }
    if (credited > 0) save(all);
    return round2(credited);
}
function recentTopups(userId, limit = 10) {
    const u = load()[userId];
    return (u?.topups || []).slice(-limit).reverse()
        .map((t) => ({ amount: round2(t.amount), status: t.status, createdAt: t.createdAt || 0 }));
}

// Buy `qty` future invites of a server, paid from the investment account.
function buy(userId, serverId, qty, verified) {
    qty = Math.floor(Number(qty) || 0);
    if (!/^\d{17,20}$/.test(String(serverId))) return { ok: false, error: 'bad-server' };
    const minQty = serverMinInvites(serverId, verified);
    if (qty < minQty) return { ok: false, error: 'min-qty', min: minQty };
    const occ = occupancyOf(serverId, verified);
    if (occ.totalOutstanding > 0 && !occ.occupants.has(String(userId))) return { ok: false, error: 'occupied', etaSec: occ.etaSec };
    const cost = round2(qty * BUY_PER_INVITE);
    const acc = accountOf(userId, verified);
    if (acc.available < cost) return { ok: false, error: 'insufficient', need: cost, have: acc.available };
    const all = load(); const u = ensure(all, userId);
    u.positions.push({ id: crypto.randomBytes(8).toString('hex'), serverId: String(serverId), qty, price: BUY_PER_INVITE, boughtAt: Date.now() });
    save(all);
    return { ok: true, cost, qty };
}

// Move liquid balance to the partner's main balance (settings.json).
function withdraw(userId, amount, verified) {
    const acc = accountOf(userId, verified);
    const amt = (amount === undefined || amount === null || amount === '') ? acc.available : round2(amount);
    if (!(amt > 0)) return { ok: false, error: 'nothing' };
    if (amt > acc.available + 1e-6) return { ok: false, error: 'insufficient', have: acc.available };
    const all = load(); const u = ensure(all, userId);
    u.withdrawn = round2((Number(u.withdrawn) || 0) + amt);
    save(all);
    const settings = loadJSON('settings.json', {});
    if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };
    settings[userId].balance = round2((Number(settings[userId].balance) || 0) + amt);
    saveJSON('settings.json', settings);
    return { ok: true, amount: amt, partnerBalance: settings[userId].balance };
}

// ---- Broken-server refund (bot removed / last active card deleted) ----
function loadBroken() { const r = loadJSON('investbroken.json', {}); return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {}; }
function saveBroken(o) { saveJSON('investbroken.json', o); }

// A server is broken for investment if no fleet bot is on it, or it has no
// active (non-deleted) verification card.
function serverBroken(serverId, clients) {
    const botPresent = (Array.isArray(clients) ? clients : []).some((c) => c.guilds?.cache?.has(String(serverId)));
    const hasActiveCard = cards.loadCards().some((c) => !c.deletedAt && String(c.guildId) === String(serverId));
    return !botPresent || !hasActiveCard;
}

// Refund every investor's UNDELIVERED invites on a server: freeze each position
// at what actually sold, so the outstanding principal ($0.09/invite) is released
// back to their investment account (available balance is derived from qty).
function refundServer(serverId, verified) {
    const all = load();
    const fills = allocateServer(serverId, all, verified);
    let changed = false, refundedInvites = 0; const hit = new Set();
    for (const uid of Object.keys(all)) {
        for (const p of (all[uid].positions || [])) {
            if (String(p.serverId) !== String(serverId)) continue;
            const sold = (fills.get(p.id) || []).length;
            const out = Math.max(0, (Number(p.qty) || 0) - sold);
            if (out > 0) { p.qty = sold; p.refundedAt = Date.now(); p.refundReason = 'server-broken'; refundedInvites += out; hit.add(uid); changed = true; }
        }
    }
    if (changed) save(all);
    return { refundedInvites, investors: hit.size };
}

// Periodic: track broken servers that still have outstanding invites; refund
// once a server has been broken for the whole grace period; clear the mark if
// it recovers or its invites are all sold.
function sweepBrokenServers(clients, verifiedList) {
    const verified = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const all = load();
    const serverIds = new Set();
    for (const uid of Object.keys(all)) for (const p of (all[uid].positions || [])) serverIds.add(String(p.serverId));
    const broken = loadBroken();
    const now = Date.now(); let changed = false;
    for (const serverId of serverIds) {
        const fills = allocateServer(serverId, all, verified);
        let out = 0;
        for (const uid of Object.keys(all)) for (const p of (all[uid].positions || [])) if (String(p.serverId) === String(serverId)) out += Math.max(0, (Number(p.qty) || 0) - (fills.get(p.id) || []).length);
        if (out <= 0) { if (broken[serverId]) { delete broken[serverId]; changed = true; } continue; }
        if (serverBroken(serverId, clients)) {
            if (!broken[serverId]) { broken[serverId] = now; changed = true; }
            else if (now - broken[serverId] >= GRACE_MS) {
                const r = refundServer(serverId, verified);
                console.log(`[INVEST] refunded ${r.refundedInvites} undelivered invites on broken server ${serverId} to ${r.investors} investor(s)`);
                delete broken[serverId]; changed = true;
            }
        } else if (broken[serverId]) { delete broken[serverId]; changed = true; }
    }
    for (const sid of Object.keys(broken)) if (!serverIds.has(sid)) { delete broken[sid]; changed = true; }
    if (changed) saveBroken(broken);
}

function startInvestSweep(clients) {
    const every = Number(process.env.INVEST_SWEEP_MS) || 60 * 60 * 1000; // hourly
    const tick = () => { try { sweepBrokenServers(clients); } catch (e) { console.error('[INVEST] sweep error:', e.message); } };
    setInterval(tick, every);
    setTimeout(tick, 120 * 1000);
    console.log(`[INVEST] broken-server refund sweep every ${Math.round(every / 60000)}m (grace ${Math.round(GRACE_MS / 3600000)}h)`);
}

// Server list with per-server sold-invite throughput + this investor's position.
function serversFor(userId, verified, now = Date.now()) {
    const all = load();
    const byServer = {};
    for (const u of (Array.isArray(verified) ? verified : [])) {
        if (u && u.adKey && u.guildId) (byServer[u.guildId] ||= []).push(Number(u.timestamp) || 0);
    }
    const win = (times) => {
        let h = 0, d = 0, w = 0;
        for (const t of times) { if (t > now - 3600000) h++; if (t > now - 86400000) d++; if (t > now - 604800000) w++; }
        return { hour: h, day: d, week: w, total: times.length };
    };
    const myPos = {};
    for (const p of (all[userId]?.positions || [])) (myPos[p.serverId] ||= []).push(p);
    const enabled = new Set(loadEnabledServers());
    const broken = loadBroken();

    const out = [];
    // Any server with activity, plus owner-enabled and any the investor holds.
    const serverIds = new Set([...Object.keys(byServer), ...enabled, ...Object.keys(myPos)]);
    for (const serverId of serverIds) {
        const flow = win(byServer[serverId] || []);
        const investable = (flow.week / 7) >= MIN_DAILY || enabled.has(serverId);
        let mine = null;
        if (myPos[serverId]) {
            const fills = allocateServer(serverId, all, verified);
            let owned = 0, sold = 0; const soldTimes = [];
            for (const p of myPos[serverId]) { owned += Number(p.qty) || 0; const ft = fills.get(p.id) || []; sold += ft.length; for (const t of ft) soldTimes.push(t); }
            const ew = win(soldTimes);
            mine = {
                owned, sold, outstanding: owned - sold,
                invested: round2(owned * BUY_PER_INVITE),
                earned: round2(sold * RET_PER_INVITE),
                earnedWin: { hour: round2(ew.hour * RET_PER_INVITE), day: round2(ew.day * RET_PER_INVITE), week: round2(ew.week * RET_PER_INVITE) }
            };
        }
        // One investor per server: locked for you if someone else still holds
        // unsold invites here.
        const occ = occupancyOf(serverId, verified, all);
        const occupiedByYou = occ.occupants.has(String(userId));
        const lockedForYou = occ.totalOutstanding > 0 && !occupiedByYou;

        // Show it if it's investable right now, or the investor holds a position.
        if (!investable && !mine) continue;
        const brokenSince = broken[serverId] || 0;
        out.push({
            serverId, flow, mine, enabled: enabled.has(serverId), investable,
            minInvites: Math.max(MIN_BUY, Math.ceil((flow.week / 7) * MIN_DAYS)),
            occupied: lockedForYou, occupiedByYou, occupiedEtaSec: lockedForYou ? occ.etaSec : null,
            brokenSince, refundEtaSec: brokenSince ? Math.max(0, Math.ceil((GRACE_MS - (now - brokenSince)) / 1000)) : null
        });
    }
    out.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || b.flow.week - a.flow.week || b.flow.total - a.flow.total);
    return out;
}

module.exports = {
    BUY_PER_100, SELL_PER_100, RETURN_RATE, BUY_PER_INVITE, RET_PER_INVITE, MIN_TOPUP, MIN_BUY, MIN_DAYS, MIN_DAILY,
    serverMinInvites, serverDailyRate, isServerInvestable, occupancyOf, serverOutstanding, buyinProfitPerInvite,
    serverBroken, refundServer, sweepBrokenServers, startInvestSweep,
    accountOf, addTopup, reconcileTopups, recentTopups, buy, withdraw, serversFor,
    loadEnabledServers, saveEnabledServers, isServerEnabled, addEnabledServer, removeEnabledServer, manualTopup
};

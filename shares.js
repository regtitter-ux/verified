// Revenue shares ("Доли").
//
// The service sells join-check verifications at JOIN_SALE_PRICE per 100
// (default $10 → $0.10 per confirmed join). For each confirmed join the
// service profit = that $0.10 minus what the partner was actually paid for
// the join (their join-bid, possibly boosted). That profit is split among
// shareholders by percentage and credited straight to their bot balance —
// from there the normal payout flow takes over (withdrawal request at $10,
// or auto-payout if enabled).
//
// By default one holder owns 100%. The owner manages holders from the admin
// panel (PUT /admin/shares).
const { loadJSON, saveJSON } = require('./database.js');
const { maybeAutoWithdraw } = require('./payouts.js');

const salePer100 = () => Number(process.env.JOIN_SALE_PRICE) || 10;
const revenuePerJoin = () => salePer100() / 100;         // $ earned per confirmed join (live: applies on Save)
// Crypto Pay acquiring fee (~3%) charged on top of every partner payout —
// a real cost that must come out of profit before it's split by shares.
const acquiringRate = () => Number.isFinite(Number(process.env.ACQUIRING_RATE)) ? Number(process.env.ACQUIRING_RATE) : 0.03;
const DEFAULT_HOLDER = process.env.SHARES_DEFAULT_HOLDER || '833442190427684914';
const KEEP_DAYS = 40;                                       // daily buckets kept for the dashboard windows

const round2 = (n) => +(Number(n) || 0).toFixed(2);
const round4 = (n) => +(Number(n) || 0).toFixed(4);
const dayNumberOf = (ts) => Math.floor(ts / 86400000);

// Current share config; falls back to a single 100% default holder when the
// file is empty/missing so the split always has a recipient.
function loadShares() {
    const cfg = loadJSON('shares.json', {});
    if (!cfg || typeof cfg !== 'object' || !Object.keys(cfg).length) {
        return { [DEFAULT_HOLDER]: { pct: 100 } };
    }
    return cfg;
}

function pruneBuckets(earnings, today) {
    for (const uid of Object.keys(earnings)) {
        for (const d of Object.keys(earnings[uid])) {
            if (Number(d) < today - KEEP_DAYS) delete earnings[uid][d];
        }
    }
    return earnings;
}

// Distribute one confirmed join's service profit to shareholders. Credits
// whole cents to each holder's balance (carrying the sub-cent remainder in
// `pending` so micro-splits aren't lost to rounding), records exact earnings
// for the dashboard, then runs each credited holder's payout flow.
async function payShares(clients, partnerAmount, opts = {}) {
    // Back-compat: a bare number in the 3rd slot used to be nowMs.
    if (typeof opts === 'number') opts = { nowMs: opts };
    // Net profit = actual revenue − partner payout − acquiring fee. Manager
    // sales simply bring less revenue ($9/100 instead of $10/100), so profit
    // (and the share split) is naturally lower — no separate commission.
    const amt = Number(partnerAmount) || 0;
    const revenue = Number.isFinite(Number(opts.revenuePerJoin)) ? Number(opts.revenuePerJoin) : revenuePerJoin();
    return distributeProfit(clients, revenue - amt - amt * acquiringRate(), opts.nowMs);
}

// Split a lump of service profit across shareholders by percentage (the core of
// payShares, reusable for one-off distributions — e.g. an investor buy-in whose
// revenue is recognized up-front rather than per delivered join).
async function distributeProfit(clients, profit, nowMs) {
    profit = Number(profit) || 0;
    if (!(profit > 0)) return; // costs ≥ what we charge → no profit to split
    const now = Number(nowMs) || Date.now();
    const today = dayNumberOf(now);

    const shares = loadShares();
    const settings = loadJSON('settings.json');
    const earnings = loadJSON('shareearnings.json', {});
    const toWithdraw = [];
    const credited = {}; // uid -> exact profit share this holder received

    // Guard: shareholder percentages are meant to sum to ≤100 (the house keeps the
    // remainder). If a misconfiguration pushes the total OVER 100, paying pct/100
    // each would distribute MORE than the profit — creating money out of nothing.
    // Scale all shares down proportionally so the total payout never exceeds the
    // profit; under 100 is left untouched (the house simply keeps the rest).
    let totalPct = 0;
    for (const cfg of Object.values(shares)) totalPct += Math.max(0, Number(cfg.pct) || 0);
    const scale = totalPct > 100 ? 100 / totalPct : 1;
    if (scale < 1) console.error(`[SHARES] shareholder pct sums to ${totalPct}% (>100) — scaling payouts by ${scale.toFixed(4)} so profit isn't over-distributed. Fix the share config.`);

    for (const [uid, cfg] of Object.entries(shares)) {
        const pct = Number(cfg.pct) || 0;
        if (pct <= 0) continue;
        const exact = profit * (pct * scale / 100);
        if (exact <= 0) continue;
        credited[uid] = round4(exact);

        // Exact ledger — all-time cumulative + per-day bucket (dashboard).
        cfg.earned = round4((Number(cfg.earned) || 0) + exact);
        if (!earnings[uid]) earnings[uid] = {};
        earnings[uid][today] = round4((Number(earnings[uid][today]) || 0) + exact);

        // Balance credit with sub-cent carry.
        const pending = (Number(cfg.pending) || 0) + exact;
        const cents = Math.floor(pending * 100) / 100;
        if (cents >= 0.01) {
            if (!settings[uid]) settings[uid] = { advText: '', serverAds: {}, partners: [] };
            settings[uid].balance = round2((Number(settings[uid].balance) || 0) + cents);
            cfg.pending = round4(pending - cents);
            toWithdraw.push(uid);
        } else {
            cfg.pending = round4(pending);
        }
    }

    saveJSON('shares.json', shares);
    saveJSON('shareearnings.json', pruneBuckets(earnings, today));
    saveJSON('settings.json', settings);

    for (const uid of toWithdraw) await maybeAutoWithdraw(clients, uid).catch(() => null);
    return credited;
}

// Reverse a previously-distributed profit, fairly: `perUid` maps shareholder →
// amount to claw back (already computed pro-rata by the caller). Debits the
// holder's balance (may go negative, like a sponsor-leave clawback) and reduces
// their earned ledger. Used when an investor's undelivered invites are refunded
// on a broken server — the buy-in profit for those invites is taken back.
function clawbackProfit(perUid, nowMs) {
    const entries = Object.entries(perUid || {}).filter(([, a]) => Number(a) > 0);
    if (!entries.length) return 0;
    const today = dayNumberOf(Number(nowMs) || Date.now());
    const shares = loadShares();
    const settings = loadJSON('settings.json');
    const earnings = loadJSON('shareearnings.json', {});
    let total = 0;
    for (const [uid, amtRaw] of entries) {
        const amt = round4(amtRaw);
        // The balance was credited only in whole cents (floor + sub-cent carry in
        // distributeProfit), so claw back in the same domain — floor, not round —
        // to never deduct more cents than were actually added.
        const debit = Math.floor(amt * 100) / 100;
        if (settings[uid]) settings[uid].balance = round2((Number(settings[uid].balance) || 0) - debit);
        if (shares[uid]) shares[uid].earned = round4(Math.max(0, (Number(shares[uid].earned) || 0) - amt));
        if (earnings[uid]) earnings[uid][today] = round4((Number(earnings[uid][today]) || 0) - amt);
        total = round4(total + amt);
    }
    saveJSON('shares.json', shares);
    saveJSON('shareearnings.json', earnings);
    saveJSON('settings.json', settings);
    return total;
}

module.exports = { get SALE_PRICE_PER_100(){return salePer100();}, get REVENUE_PER_JOIN(){return revenuePerJoin();}, get ACQUIRING_RATE(){return acquiringRate();}, DEFAULT_HOLDER, loadShares, payShares, distributeProfit, clawbackProfit, dayNumberOf };

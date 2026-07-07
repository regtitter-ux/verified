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

const SALE_PRICE_PER_100 = Number(process.env.JOIN_SALE_PRICE) || 10;
const REVENUE_PER_JOIN = SALE_PRICE_PER_100 / 100;         // $ earned per confirmed join
// Crypto Pay acquiring fee (~3%) charged on top of every partner payout —
// a real cost that must come out of profit before it's split by shares.
const ACQUIRING_RATE = Number.isFinite(Number(process.env.ACQUIRING_RATE)) ? Number(process.env.ACQUIRING_RATE) : 0.03;
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
    const revenue = Number.isFinite(Number(opts.revenuePerJoin)) ? Number(opts.revenuePerJoin) : REVENUE_PER_JOIN;
    const profit = revenue - amt - amt * ACQUIRING_RATE;
    if (!(profit > 0)) return; // costs ≥ what we charge → no profit to split
    const now = Number(opts.nowMs) || Date.now();
    const today = dayNumberOf(now);

    const shares = loadShares();
    const settings = loadJSON('settings.json');
    const earnings = loadJSON('shareearnings.json', {});
    const toWithdraw = [];

    for (const [uid, cfg] of Object.entries(shares)) {
        const pct = Number(cfg.pct) || 0;
        if (pct <= 0) continue;
        const exact = profit * (pct / 100);
        if (exact <= 0) continue;

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
}

module.exports = { SALE_PRICE_PER_100, REVENUE_PER_JOIN, ACQUIRING_RATE, DEFAULT_HOLDER, loadShares, payShares, dayNumberOf };

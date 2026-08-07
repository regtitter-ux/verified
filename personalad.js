// Personal server ads — an owner-set FILLER shown on their own verification cards
// only when NO other order is eligible (any real campaign overrides it). It's a
// NO-CHECK ad: the user is verified WITHOUT a join, and the partner earns PER CLICK
// at their calibrated conversion rate (service-funded; there's no external buyer).
//
// To avoid losing sub-cent per-click amounts to rounding, payment is STATISTICAL —
// exactly like the no-check order model: each UNIQUE clicker converts with
// probability = the card's conversion, and a conversion pays one full join bid. Over
// many clicks the partner earns ≈ joinBid × conversion per click.
//
// Config is a PER-SERVER setting in siteconfig (like nsfwServers / cpcCalibrated):
// personalAdCpc[gid] (on), personalAdUnlimited[gid], personalAdLimit[gid] (max counted
// clicks). Dedup + counters live in personalads.json. The per-click money is credited
// to the PARTNER (the card owner whose server shows the ad).
const { loadJSON, mutate } = require('./database.js');
const { round2 } = require('./round.js');

const FILE = 'personalads.json';

// This server's personal-ad CPC config, read off siteconfig, keyed by guild.
function cfg(gid) {
    const sc = loadJSON('siteconfig.json', {});
    const g = String(gid || '');
    return {
        cpc: Boolean(sc.personalAdCpc && sc.personalAdCpc[g]),
        unlimited: Boolean(sc.personalAdUnlimited && sc.personalAdUnlimited[g]),
        limit: Math.max(0, Math.floor(Number(sc.personalAdLimit && sc.personalAdLimit[g]) || 0))
    };
}

function stats(gid) {
    const rec = (loadJSON(FILE, {}) || {})[String(gid || '')] || {};
    return { clicks: Number(rec.clicks) || 0, paidCents: Number(rec.paidCents) || 0 };
}

// Should the personal CPC ad still SHOW here? CPC on AND (unlimited OR under the limit).
function canShow(gid) {
    const c = cfg(gid);
    if (!c.cpc) return false;
    if (c.unlimited) return true;
    if (c.limit <= 0) return false;                 // a 0 limit with unlimited off = don't show
    return stats(gid).clicks < c.limit;
}

// Count a click and decide its pay. Dedup per (user, server) so one person can't farm
// it, and stop at the limit. Returns the dollars to credit the partner (a full join
// bid on a statistical conversion, else 0). 0 also for dup / limit / CPC off — the
// caller still grants access regardless. Caller moves the money via ledger.credit.
function claimClick(gid, userId, conv, joinBidDollars, nowMs) {
    const g = String(gid || ''), u = String(userId || '');
    const c = cfg(gid);
    if (!c.cpc || !g || !u) return 0;
    let creditDollars = 0;
    mutate(FILE, (all) => {
        if (!all[g] || typeof all[g] !== 'object') all[g] = { users: {}, clicks: 0, paidCents: 0 };
        const rec = all[g];
        if (!rec.users) rec.users = {};
        if (rec.users[u]) return false;                                   // already counted this user → no double pay
        if (!c.unlimited && !((Number(rec.clicks) || 0) < c.limit)) return false;   // limit reached
        rec.users[u] = Number(nowMs) || Date.now();
        rec.clicks = (Number(rec.clicks) || 0) + 1;
        // Statistical payout: this clicker "converts" with probability = conversion.
        const cv = Number(conv) || 0;
        if (cv > 0 && Math.random() < cv) {
            creditDollars = round2(Number(joinBidDollars) || 0);
            rec.paidCents = (Number(rec.paidCents) || 0) + Math.round(creditDollars * 100);
        }
    }, {});
    return creditDollars;
}

module.exports = { cfg, stats, canShow, claimClick };

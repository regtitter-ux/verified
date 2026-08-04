// Per-card CONVERSION calibration for the CPC (pay-per-click) model.
//
// For a verification card we measure conversion = (join-check joins) ÷ (unique
// clickers) over the last SAMPLE join-check joins. That ratio is the fraction of
// people who, after clicking Verify and being shown the ad, actually joined the
// sponsor. It lets us pay per CLICK on a no-join-check ad exactly what the partner
// would have earned per JOIN: rate_per_click = rate_per_join × conversion.
//
// The number is derived ENTIRELY from the stats the service already keeps
// (verified.json join-check joins + cardclicks.json clicks), so it's live from day
// one — nothing to collect from scratch — and it keeps re-computing off the latest
// SAMPLE joins as new join-check ads run. Enabled per SERVER by the owner (the
// cpcCalibrated toggle in the server-settings modal); off servers keep the normal
// pay-per-join flow untouched.
const { loadJSON } = require('./database.js');

const SAMPLE = 100;                      // conversion looks at the last N join-check joins
const CLICK_TTL = 7 * 86400000;          // clicks are retained ~7d (cards.js CLICK_TTL)
// On a calibrated server this fraction of shows STAYS join-check (to keep measuring
// the real conversion); the rest run no-check and pay per click. 0.15 = 15% calibration.
const CALIB_RATE = (() => { const v = Number(process.env.CPC_CALIBRATION_RATE); return (Number.isFinite(v) && v > 0 && v <= 1) ? v : 0.15; })();
// Live calibration share: owner can tune it from the admin panel (siteconfig.cpcCalibRate),
// falling back to the env default. Bounded to (0,1] — never let it hit 0 (would stop
// measuring conversion entirely) or exceed 1.
function calibRate() {
    const cfg = loadJSON('siteconfig.json', {});
    const v = Number(cfg && cfg.cpcCalibRate);
    return (Number.isFinite(v) && v > 0 && v <= 1) ? v : CALIB_RATE;
}

// Is a NO-CHECK show permitted for this (partner server, ad) pair? Both manual
// levers must be on — the partner server is CPC-calibrated (serverEnabled) AND the
// specific ad/campaign opted into no-check (campaignOptedIn) — AND a conversion
// exists to price the click. The per-show coin-flip (calibRate) happens in the
// handler; this is the yes/no gate that must pass before a virtual join can pay.
function noCheckEligible(serverEnabled, campaignOptedIn, conv) {
    return Boolean(serverEnabled) && Boolean(campaignOptedIn) && conv != null;
}

// Owner toggle: is the CPC-calibrated mode on for this partner server (guild)?
function enabledFor(guildId) {
    const cfg = loadJSON('siteconfig.json', {});
    const m = (cfg && typeof cfg.cpcCalibrated === 'object' && !Array.isArray(cfg.cpcCalibrated)) ? cfg.cpcCalibrated : null;
    return Boolean(m && m[String(guildId)]);
}

// Conversion from the last SAMPLE join-check joins and the UNIQUE clickers over the
// SAME window. The window starts at the oldest of the last SAMPLE joins but never
// earlier than the click-retention horizon, so joins and clicks always cover one
// aligned period (otherwise, with joins older than the click data, clicks would be
// undercounted and conversion overstated). Unique clickers (not raw click events) is
// the right denominator: a no-check ad verifies each user on the first click, so a
// paid click == one distinct user.
//   joinTs      — timestamps of this card's join-check joins (adKey, NOT the bonus extra-ad)
//   clickEvents — [{ u, t }] click records for this card
// Returns { conv, joins, clickers } — conv is null until there's at least one join
// and one clicker (caller falls back to the normal per-join flow / network average).
function fromSamples(joinTs, clickEvents, nowMs) {
    const now = Number(nowMs) || Date.now();
    const joins = (Array.isArray(joinTs) ? joinTs : []).map((t) => Number(t) || 0).filter((t) => t > 0).sort((a, b) => b - a);
    if (!joins.length) return { conv: null, joins: 0, clickers: 0 };
    const lastN = joins.slice(0, SAMPLE);
    const windowStart = Math.max(lastN[lastN.length - 1], now - CLICK_TTL);
    const joinsInWin = lastN.filter((t) => t >= windowStart).length;
    const clickers = new Set();
    for (const c of (Array.isArray(clickEvents) ? clickEvents : [])) {
        // Skip no-check (nc) clicks: conversion must be measured ONLY on calibration
        // (join-check) shows, or including no-check clicks — which produce no join-
        // check joins — would drag it toward zero (a self-referential feedback loop).
        if (c && !c.nc && (Number(c.t) || 0) >= windowStart && c.u) clickers.add(String(c.u));
    }
    const cWin = clickers.size;
    if (!joinsInWin || !cWin) return { conv: null, joins: joinsInWin, clickers: cWin };
    // A clicker can convert at most once, so conversion is bounded by 1.
    const conv = Math.min(1, joinsInWin / cWin);
    return { conv: +conv.toFixed(4), joins: joinsInWin, clickers: cWin };
}

// The pay-per-click rate that matches per-join earnings, in the same $/100 unit the
// rest of the service uses: ratePer100Clicks = joinRatePer100 × conversion. Per-click
// is that ÷ 100. Returns 0 when conversion isn't established yet.
function ratePer100Clicks(conv, joinRatePer100) {
    const c = Number(conv);
    const j = Number(joinRatePer100) || 0;
    if (!Number.isFinite(c) || c <= 0 || j <= 0) return 0;
    return +(j * c).toFixed(4);
}
const ratePerClick = (conv, joinRatePer100) => +((ratePer100Clicks(conv, joinRatePer100)) / 100).toFixed(6);

// Live conversion for one card, computed from the stored stats. join-check joins =
// counted (adKey) real joins, excluding the bonus extra-ad AND no-check virtual
// joins (marked noCheck). clicks skip no-check (nc) events inside fromSamples.
function forCard(guildId, roleId, creatorId, nowMs) {
    const v = loadJSON('verified.json', []);
    const cl = loadJSON('cardclicks.json', []);
    const ck = `${guildId || ''}:${roleId || ''}:${creatorId || ''}`;
    const joinTs = [];
    for (const u of (Array.isArray(v) ? v : [])) {
        if (!u || u.creatorId !== creatorId || String(u.guildId) !== String(guildId)) continue;
        if ((u.roleId || null) !== (roleId || null)) continue;
        if (!u.adKey || u.viaExtra || u.noCheck) continue;
        joinTs.push(Number(u.timestamp) || 0);
    }
    const clicks = (Array.isArray(cl) ? cl : []).filter((e) => e && e.k === ck).map((e) => ({ u: e.u, t: e.t, nc: e.nc }));
    return fromSamples(joinTs, clicks, nowMs);
}

module.exports = { SAMPLE, CALIB_RATE, calibRate, enabledFor, noCheckEligible, fromSamples, forCard, ratePer100Clicks, ratePerClick };

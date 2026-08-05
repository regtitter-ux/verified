// calibtrack.js — accurate calibration conversion via DIRECT member tracking.
//
// The OLD calibration used a forced-join ad (2-click join-check): it counted only
// users who BOTH joined the sponsor AND came back for the confirming second click,
// dropping ~half of real joiners and understating conversion — the same reason an
// order's counter reads ~2× below what invite-tracker bots show on the server.
//
// The NEW calibration shows a NO-CHECK ad (the user is verified without any join)
// and, because our bot is already on the test sponsor server, observes who ACTUALLY
// joins and leaves via gateway member events — attributing each real join to the
// calibration click that led to it. That is the TRUE conversion of a no-check ad,
// measured per server.
//
// MEASUREMENT ONLY — no money moves here. The per-card conversion it produces is
// what the no-check (CPC) pay-per-click rate is priced from (see conversion.forCard).
const { loadJSON, mutate } = require('./database.js');

const FILE = 'calibtrack.json';
const TTL = 14 * 86400000;   // clicks + joins retained ~14d (attribution + denominator window)

function norm(d) {
    return {
        clicks: (d && Array.isArray(d.clicks)) ? d.clicks : [],
        joins: (d && Array.isArray(d.joins)) ? d.joins : []
    };
}
const load = () => norm(loadJSON(FILE, {}));
const FALLBACK = { clicks: [], joins: [] };

// A user engaged with the calibration ad on `calibGuild` (verified WITHOUT a join).
// One click per (user, calibGuild) — keep the latest; prune stale rows.
function recordClick(userId, calibGuild, sponsor, nowMs) {
    const u = String(userId || ''), g = String(calibGuild || ''), sp = String(sponsor || '');
    if (!u || !g || !sp) return;
    const now = Number(nowMs) || Date.now();
    mutate(FILE, (d) => {
        if (!Array.isArray(d.clicks)) d.clicks = [];
        if (!Array.isArray(d.joins)) d.joins = [];
        d.clicks = d.clicks.filter((c) => c && c.t > now - TTL && !(c.u === u && c.g === g));
        d.clicks.push({ u, g, sp, t: now });
        d.joins = d.joins.filter((j) => j && j.t > now - TTL);
    }, FALLBACK);
}

// A real member joined a sponsor. Attribute it to the most recent calibration click
// by this user for this sponsor (within the window), recording ONE net join per
// (user, sponsor) — a genuine re-join after a tracked leave counts again. Returns
// the calibGuild it was attributed to, or null (joined without a calibration click).
function onJoin(userId, sponsor, nowMs) {
    const u = String(userId || ''), sp = String(sponsor || '');
    if (!u || !sp) return null;
    const now = Number(nowMs) || Date.now();
    let attributed = null;
    mutate(FILE, (d) => {
        if (!Array.isArray(d.clicks)) d.clicks = [];
        if (!Array.isArray(d.joins)) d.joins = [];
        // Already an active (not-left) join for this user+sponsor → don't double-count.
        if (d.joins.some((j) => j && j.u === u && j.sp === sp && !j.left)) return false;
        const click = d.clicks
            .filter((c) => c && c.u === u && c.sp === sp && c.t > now - TTL)
            .sort((a, b) => b.t - a.t)[0];
        if (!click) return false;   // joined without a calibration click → not ours
        attributed = click.g;
        d.joins.push({ u, g: click.g, sp, t: now, left: 0 });
    }, FALLBACK);
    return attributed;
}

// A member left a sponsor → mark their active tracked join as left (drops out of the
// net conversion, exactly like the order counter's net-stays basis).
function onLeave(userId, sponsor, nowMs) {
    const u = String(userId || ''), sp = String(sponsor || '');
    if (!u || !sp) return;
    const now = Number(nowMs) || Date.now();
    mutate(FILE, (d) => {
        if (!Array.isArray(d.joins)) return false;
        let changed = false;
        for (const j of d.joins) { if (j && j.u === u && j.sp === sp && !j.left) { j.left = now; changed = true; } }
        if (!changed) return false;
    }, FALLBACK);
}

// Net real joins attributed to this calibration server (joined, not left) — unique users.
function netJoins(calibGuild) {
    const g = String(calibGuild || '');
    const seen = new Set();
    for (const j of load().joins) { if (j && j.g === g && !j.left) seen.add(j.u); }
    return seen.size;
}
// Unique users who engaged with the calibration ad on this server (denominator).
function clickers(calibGuild) {
    const g = String(calibGuild || '');
    const seen = new Set();
    for (const c of load().clicks) { if (c && c.g === g) seen.add(c.u); }
    return seen.size;
}
// True no-check conversion for this server: net real joins ÷ clickers (0..1), or null
// until there's at least one click and one tracked join.
function conversionFor(calibGuild) {
    const j = netJoins(calibGuild), c = clickers(calibGuild);
    if (!c || !j) return null;
    return +Math.min(1, j / c).toFixed(4);
}
// Has this server ever been calibrated with the member-tracking method (any clicks)?
function hasData(calibGuild) {
    const g = String(calibGuild || '');
    return load().clicks.some((c) => c && c.g === g);
}

module.exports = { recordClick, onJoin, onLeave, netJoins, clickers, conversionFor, hasData };

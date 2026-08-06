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
// One click per (user, calibGuild) — keep the latest; prune stale rows. `meta` carries
// what's needed to PAY the partner when the real join is later observed: creatorId
// (card owner), roleId, channelId, campaignId.
function recordClick(userId, calibGuild, sponsor, meta, nowMs) {
    const u = String(userId || ''), g = String(calibGuild || ''), sp = String(sponsor || '');
    if (!u || !g || !sp) return;
    const now = Number(nowMs) || Date.now();
    const m = meta || {};
    const r = m.roleId ? String(m.roleId) : null, cr = String(m.creatorId || '');
    mutate(FILE, (d) => {
        if (!Array.isArray(d.clicks)) d.clicks = [];
        if (!Array.isArray(d.joins)) d.joins = [];
        // Dedup per CARD (user + guild + role + creator), not per guild — a user can
        // click different cards on the same server; each card measures its own conversion.
        d.clicks = d.clicks.filter((c) => c && c.t > now - TTL && !(c.u === u && c.g === g && (c.r || null) === r && String(c.cr || '') === cr));
        d.clicks.push({ u, g, sp, t: now, cr, r, ch: m.channelId ? String(m.channelId) : null, cid: String(m.campaignId || '') });
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
        attributed = { g: click.g, cr: click.cr || '', r: click.r || null, ch: click.ch || null, cid: click.cid || '' };
        // Stamp the card (role + creator) on the join so conversion is measured PER CARD.
        d.joins.push({ u, g: click.g, r: click.r || null, cr: click.cr || '', sp, t: now, left: 0 });
    }, FALLBACK);
    return attributed;
}

// Calibration clicks that don't yet have an ACTIVE tracked join — used by the
// reconcile sweep to catch real joins the GuildMemberAdd event missed (bot restart,
// intent gap), so the partner is still paid for them.
function unattributed() {
    const { clicks, joins } = load();
    const active = new Set();
    for (const j of joins) { if (j && !j.left) active.add(j.u + '|' + j.sp); }
    const out = [];
    for (const c of clicks) {
        if (c && c.u && c.sp && !active.has(c.u + '|' + c.sp)) {
            out.push({ u: c.u, g: c.g, sp: c.sp, cr: c.cr || '', r: c.r || null, ch: c.ch || null, cid: c.cid || '', t: Number(c.t) || 0 });
        }
    }
    return out;
}

// A member left a sponsor → mark their active tracked join as left (drops out of the
// net conversion, exactly like the order counter's net-stays basis).
// Returns the card {g, r, cr} of the join it marked left (for the live log), or null.
function onLeave(userId, sponsor, nowMs) {
    const u = String(userId || ''), sp = String(sponsor || '');
    if (!u || !sp) return null;
    const now = Number(nowMs) || Date.now();
    let card = null;
    mutate(FILE, (d) => {
        if (!Array.isArray(d.joins)) return false;
        let changed = false;
        for (const j of d.joins) {
            if (j && j.u === u && j.sp === sp && !j.left) {
                j.left = now;
                if (!card) card = { g: j.g, r: j.r || null, cr: j.cr || '' };
                changed = true;
            }
        }
        if (!changed) return false;
    }, FALLBACK);
    return card;
}

// Scope match: pass roleIds+creator to measure ONE CARD (guild + its role(s) + owner);
// omit roleIds (undefined/null) to measure the WHOLE SERVER (all its cards pooled —
// used for the calibration delivery counter). roleIds may be a single id or an array.
function inScope(rec, guild, roleIds, creator) {
    if (String(rec.g || '') !== String(guild || '')) return false;
    if (roleIds == null) return true;                                   // server-level
    if (String(rec.cr || '') !== String(creator || '')) return false;
    const set = Array.isArray(roleIds) ? roleIds : [roleIds];
    return set.some((r) => (rec.r || null) === (r || null));
}
// Net real joins (joined, not left) — unique users — for a card or the whole server.
function netJoins(guild, roleIds, creator) {
    const seen = new Set();
    for (const j of load().joins) { if (j && !j.left && inScope(j, guild, roleIds, creator)) seen.add(j.u); }
    return seen.size;
}
// Unique users who engaged with the calibration ad (denominator) — card or server.
function clickers(guild, roleIds, creator) {
    const seen = new Set();
    for (const c of load().clicks) { if (c && inScope(c, guild, roleIds, creator)) seen.add(c.u); }
    return seen.size;
}
// True no-check conversion: net real joins ÷ clickers (0..1), or null until there's at
// least one click and one tracked join. Per card when roleIds+creator given, else server.
function conversionFor(guild, roleIds, creator) {
    const j = netJoins(guild, roleIds, creator), c = clickers(guild, roleIds, creator);
    if (!c || !j) return null;
    return +Math.min(1, j / c).toFixed(4);
}
// Any calibration clicks for this card (or server)?
function hasData(guild, roleIds, creator) {
    return load().clicks.some((c) => c && inScope(c, guild, roleIds, creator));
}

// One-time migration: join records written BEFORE conversion went per-card carry no
// role/creator, so per-card queries miss them (every card falls back to the network
// average — the "0 joins / same % on every card" symptom). Stamp each old join with
// the card from the user's click for that sponsor. Idempotent (skips already-stamped);
// safe to call at every startup.
function migrateJoins() {
    mutate(FILE, (d) => {
        if (!Array.isArray(d.joins) || !Array.isArray(d.clicks)) return false;
        let changed = false;
        for (const j of d.joins) {
            if (!j || j.r !== undefined) continue;   // already card-stamped
            const click = d.clicks
                .filter((c) => c && c.u === j.u && c.sp === j.sp)
                .sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0))[0];
            j.r = click ? (click.r || null) : null;
            j.cr = click ? (click.cr || '') : '';
            changed = true;
        }
        if (!changed) return false;
    }, FALLBACK);
}

// Network-wide calibration conversion: pooled net real joins ÷ clickers across ALL
// calibrated servers. The fallback for a card that hasn't been calibrated yet — so
// conversion still comes ONLY from calibration, never from passive sponsor ads.
function networkAvg() {
    const { clicks, joins } = load();
    const joined = new Set();
    for (const j of joins) { if (j && !j.left && j.u && j.g) joined.add(j.u + '|' + j.g); }
    const clk = new Set();
    for (const c of clicks) { if (c && c.u && c.g) clk.add(c.u + '|' + c.g); }
    if (!clk.size || !joined.size) return null;
    return +Math.min(1, joined.size / clk.size).toFixed(4);
}

module.exports = { recordClick, onJoin, onLeave, netJoins, clickers, conversionFor, hasData, networkAvg, unattributed, migrateJoins };

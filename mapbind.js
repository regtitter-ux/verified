// Map bindings — an owner-curated "my destination link → source servers" route.
//
// When a binding is RUNNING, its destination invite is shown as a NO-CHECK filler on
// the chosen SOURCE guilds, but ONLY when no paid campaign is eligible there (a real
// order always overrides it — the pick is lowest priority, see index.js). The user is
// verified WITHOUT a join; a join is counted STATISTICALLY: each unique clicker on a
// source "converts" with probability = that source's calibrated conversion, so over
// many clicks the delivered count ≈ clicks × conversion (hence the ≤15% counter error
// surfaced in the UI). Each statistical join DEBITS the binding owner's balance (the
// "buyer") by pricePer100/100 — the same wallet model a public self-serve version will
// use. price 0 = house (runs free, still counts joins).
//
// This path is NETWORK-FREE by design (the show-ad keystone): the destination guild is
// resolved from the stored record, never via an invite lookup on the click path. The
// invite→guild resolution happens once at create/change time in the API layer.
//
// Storage: bindings.json, an object keyed by binding id. All writes go through
// database.mutate (atomic deep-copy save). Money moves via ledger.debit in index.js —
// this module only decides the amount and keeps the counters, exactly like personalad.
const crypto = require('crypto');
const { loadJSON, mutate } = require('./database.js');
const { round2 } = require('./round.js');

const FILE = 'bindings.json';
const RECENT_TTL = 7 * 24 * 60 * 60 * 1000;   // keep join timestamps 7d for hour/day/week windows
const RECENT_CAP = 5000;                       // hard cap on the per-binding ring
const USER_TTL = 30 * 24 * 60 * 60 * 1000;     // forget a deduped clicker after 30d

function newId() { return crypto.randomBytes(9).toString('hex'); }
function now(nowMs) { return Number(nowMs) || Date.now(); }

function loadAll() {
    const all = loadJSON(FILE, {});
    return all && typeof all === 'object' ? all : {};
}

// A binding's per-join price in dollars (pricePer100 is cents-free dollars per 100 joins).
function perJoin(b) { return round2((Number(b && b.pricePer100) || 0) / 100); }

// Public projection for the admin UI — counters + config, never the raw users map.
function view(b) {
    if (!b || typeof b !== 'object') return null;
    const recent = Array.isArray(b.recent) ? b.recent : [];
    const t = Date.now();
    const win = (ms) => recent.reduce((n, ts) => (t - ts <= ms ? n + 1 : n), 0);
    return {
        id: b.id,
        ownerId: b.ownerId || '',
        invite: b.invite || '',
        destGuildId: b.destGuildId || '',
        destName: b.destName || '',
        destIcon: b.destIcon || '',
        sources: Array.isArray(b.sources) ? b.sources.slice() : [],
        running: Boolean(b.running),
        limit: Math.max(0, Math.floor(Number(b.limit) || 0)),
        delivered: Math.max(0, Math.floor(Number(b.delivered) || 0)),
        pricePer100: Math.max(0, Number(b.pricePer100) || 0),
        spentUsd: round2(Number(b.spentUsd) || 0),
        stoppedReason: b.stoppedReason || null,
        joins: { hour: win(3600e3), day: win(86400e3), week: win(7 * 86400e3) },
        history: Array.isArray(b.linkHistory) ? b.linkHistory.slice(-50) : [],
        createdAt: b.createdAt || 0,
        updatedAt: b.updatedAt || 0
    };
}

function list() {
    const all = loadAll();
    return Object.keys(all).map((id) => view(all[id])).filter(Boolean)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function get(id) { return view(loadAll()[String(id || '')]); }

// Create a binding. dest{guildId,name,icon} come from the API's one-time invite resolve.
function create(ownerId, invite, dest, nowMs) {
    const id = newId();
    const t = now(nowMs);
    mutate(FILE, (all) => {
        all[id] = {
            id, ownerId: String(ownerId || ''), invite: String(invite || ''),
            destGuildId: dest && dest.guildId ? String(dest.guildId) : '',
            destName: dest && dest.name ? String(dest.name) : '',
            destIcon: dest && dest.icon ? String(dest.icon) : '',
            sources: [], running: false, limit: 0, delivered: 0, pricePer100: 0, spentUsd: 0,
            users: {}, recent: [], linkHistory: [], stoppedReason: null,
            createdAt: t, updatedAt: t
        };
    });
    return get(id);
}

function remove(id) {
    const g = String(id || '');
    let ok = false;
    mutate(FILE, (all) => { if (all[g]) { delete all[g]; ok = true; } else return false; });
    return ok;
}

// Patch a binding. A changed invite pushes the previous link onto linkHistory with its
// live span, and resets stoppedReason. dest is re-resolved by the caller on invite change.
function update(id, patch, nowMs) {
    const g = String(id || '');
    const t = now(nowMs);
    let ok = false;
    mutate(FILE, (all) => {
        const b = all[g];
        if (!b) return false;
        if (patch.invite != null && String(patch.invite) !== b.invite) {
            if (b.invite) {
                b.linkHistory = Array.isArray(b.linkHistory) ? b.linkHistory : [];
                b.linkHistory.push({ invite: b.invite, destGuildId: b.destGuildId || '', destName: b.destName || '', from: b.updatedAt || b.createdAt || t, to: t });
                if (b.linkHistory.length > 100) b.linkHistory = b.linkHistory.slice(-100);
            }
            b.invite = String(patch.invite);
            if (patch.dest) { b.destGuildId = String(patch.dest.guildId || ''); b.destName = String(patch.dest.name || ''); b.destIcon = String(patch.dest.icon || ''); }
        }
        if (Array.isArray(patch.sources)) b.sources = patch.sources.map(String).filter((s) => /^\d{17,20}$/.test(s));
        if (patch.limit != null) b.limit = Math.max(0, Math.floor(Number(patch.limit) || 0));
        if (patch.pricePer100 != null) b.pricePer100 = Math.max(0, Number(patch.pricePer100) || 0);
        if (patch.running != null) { b.running = Boolean(patch.running); if (b.running) b.stoppedReason = null; else if (!b.stoppedReason) b.stoppedReason = 'manual'; }
        b.updatedAt = t;
        ok = true;
    });
    return ok ? get(id) : null;
}

// Is this binding still deliverable? running, and (no limit OR under it).
function deliverable(b) {
    if (!b || !b.running) return false;
    const limit = Math.max(0, Math.floor(Number(b.limit) || 0));
    if (limit > 0 && (Number(b.delivered) || 0) >= limit) return false;
    return true;
}

// Pick a running binding that covers this SOURCE guild (network-free, cache-free). When
// several match, the oldest wins (stable, testable). Returns the view or null.
function pickForSource(sourceGid) {
    const g = String(sourceGid || '');
    if (!g) return null;
    const all = loadAll();
    const hit = Object.keys(all).map((id) => all[id])
        .filter((b) => b && deliverable(b) && Array.isArray(b.sources) && b.sources.includes(g) && b.destGuildId && b.destGuildId !== g)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    return hit ? view(hit) : null;
}

// Count a statistical join for a binding and decide the owner debit. Dedup per (binding,
// user); one unique clicker is one Bernoulli trial at `conv`. A HIT costs perJoin(b)
// dollars — but only if the owner can afford it (ownerBalance) and the limit isn't hit;
// otherwise the binding auto-stops ('funds' / 'limit') and nothing is counted. Returns
// the dollars for the caller to ledger.debit from the owner (0 on miss/dup/stop).
function claimJoin(bindingId, userId, conv, ownerBalance, nowMs) {
    const g = String(bindingId || ''), u = String(userId || '');
    const t = now(nowMs);
    let debit = 0;
    mutate(FILE, (all) => {
        const b = all[g];
        if (!b || !u) return false;
        if (!deliverable(b)) return false;
        if (!b.users) b.users = {};
        // prune stale dedup entries opportunistically
        for (const k of Object.keys(b.users)) { if (t - (Number(b.users[k]) || 0) > USER_TTL) delete b.users[k]; }
        if (b.users[u]) return false;                                   // already counted this clicker
        b.users[u] = t;
        const cv = Number(conv) || 0;
        const hit = cv > 0 && Math.random() < cv;
        if (!hit) return;                                               // recorded the trial; it just didn't convert
        const cost = perJoin(b);
        // Can't afford this join → stop the binding, don't count it.
        if (cost > (Number(ownerBalance) || 0) + 1e-9) { b.running = false; b.stoppedReason = 'funds'; return; }
        const limit = Math.max(0, Math.floor(Number(b.limit) || 0));
        b.delivered = (Number(b.delivered) || 0) + 1;
        b.spentUsd = round2((Number(b.spentUsd) || 0) + cost);
        b.recent = Array.isArray(b.recent) ? b.recent : [];
        b.recent.push(t);
        b.recent = b.recent.filter((ts) => t - ts <= RECENT_TTL);
        if (b.recent.length > RECENT_CAP) b.recent = b.recent.slice(-RECENT_CAP);
        if (limit > 0 && b.delivered >= limit) { b.running = false; b.stoppedReason = 'limit'; }
        debit = cost;
    });
    return debit;
}

module.exports = { list, get, create, update, remove, pickForSource, claimJoin, deliverable, view, perJoin, FILE };

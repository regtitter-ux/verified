// Shared DMALL server availability (can a broadcast actually run on the server), keyed by
// guildId. Set by the per-click server-check and broadcast to every open picker via SSE, so a
// status change (available ⇄ unavailable) shows up for all users in real time. Flat-JSON store.
const { loadJSON, mutate } = require('./database.js');
const FILE = 'dmallserverstatus.json';

function load() { const r = loadJSON(FILE, {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; }

// true / false / null (never checked).
function isAvailable(gid) { const s = load()[String(gid || '')]; return s ? !!s.available : null; }

// The cached availability if it was checked within ttlMs, else undefined (→ re-check). Keeps
// rapid/multi-user clicks from hammering the operator while still re-checking after the TTL.
function recent(gid, ttlMs) { const s = load()[String(gid || '')]; return (s && (Date.now() - (s.checkedAt || 0) < ttlMs)) ? !!s.available : undefined; }

// Store the status; returns true if it CHANGED (so the caller can broadcast just real changes).
function set(gid, available) {
    const g = String(gid || ''); let changed = false;
    mutate(FILE, (o) => { const prev = o[g] ? !!o[g].available : null; if (prev !== !!available) changed = true; o[g] = { available: !!available, checkedAt: Date.now() }; });
    return changed;
}

// A broadcast actually FAILED to deliver on this server → mark unavailable + stamp failedAt, so
// a cooldown keeps it blocked even if a bots-pool re-check would (misleadingly) say it's fine.
function markFailure(gid) {
    const g = String(gid || ''); let changed = false;
    mutate(FILE, (o) => { const prev = o[g] ? !!o[g].available : null; if (prev !== false) changed = true; o[g] = { available: false, checkedAt: Date.now(), failedAt: Date.now() }; });
    return changed;
}
function recentFailure(gid, ttlMs) { const s = load()[String(gid || '')]; return !!(s && s.failedAt && (Date.now() - s.failedAt < ttlMs)); }

function availabilityMap() { const o = load(); const m = {}; for (const [k, v] of Object.entries(o)) m[k] = !!(v && v.available); return m; }

module.exports = { FILE, isAvailable, recent, set, markFailure, recentFailure, availabilityMap };

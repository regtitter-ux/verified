// Per-partner activity log for the partner cabinet: every verification grant
// (paid or not, with the reason it wasn't paid), every clawback debit and every
// verification removal. Persisted, queryable, and bounded per partner.
//
// Shape: partnerlog.json = { [creatorId]: [ event, … ] } where event =
//   { ts, type, reason, amount, userId, guildId, roleId }
//   type   : 'grant' | 'debit' | 'unverify'
//   reason : 'paid' | 'no_ad' | 'dup_join' | 'already_verified' | 'left'
const { loadJSON, saveJSON } = require('./database.js');

const MAX_PER_PARTNER = Number(process.env.PARTNER_LOG_MAX) || 500;

function load() {
    const r = loadJSON('partnerlog.json', {});
    return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}
function save(o) { saveJSON('partnerlog.json', o); }

// Append one event for a partner (synchronous load-mutate-save = atomic in the
// single-threaded event loop). Bounded so the array can't grow without limit.
function logEvent(creatorId, entry) {
    const cid = String(creatorId || '');
    if (!/^\d{17,20}$/.test(cid) || !entry || !entry.type) return;
    const all = load();
    if (!Array.isArray(all[cid])) all[cid] = [];
    all[cid].push({
        ts: Date.now(),
        type: String(entry.type),
        reason: entry.reason ? String(entry.reason) : null,
        amount: Number(entry.amount) || 0,
        userId: entry.userId ? String(entry.userId) : null,
        guildId: entry.guildId ? String(entry.guildId) : null,
        roleId: entry.roleId ? String(entry.roleId) : null
    });
    if (all[cid].length > MAX_PER_PARTNER) all[cid] = all[cid].slice(-MAX_PER_PARTNER);
    save(all);
}

// All of one partner's events, newest-first (the partner cabinet view).
function forPartner(creatorId) {
    const arr = load()[String(creatorId || '')];
    return (Array.isArray(arr) ? arr : []).slice().reverse();
}

// Every partner's events flattened, newest-first, each tagged with its partner
// (the admin cross-partner view).
function allEvents() {
    const all = load();
    const out = [];
    for (const cid of Object.keys(all)) for (const e of (all[cid] || [])) out.push({ ...e, creatorId: cid });
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out;
}

// Shared filtering used by both the partner and admin endpoints.
// opts: { type, reason, server, user, partner, since, sort, limit }
function applyFilters(events, opts = {}) {
    let out = Array.isArray(events) ? events : [];
    if (opts.type) out = out.filter((e) => e.type === opts.type);
    if (opts.reason) out = out.filter((e) => e.reason === opts.reason);
    if (opts.server) out = out.filter((e) => e.guildId === opts.server);
    if (opts.user) out = out.filter((e) => e.userId === opts.user);
    if (opts.partner) out = out.filter((e) => e.creatorId === opts.partner);
    if (opts.since) out = out.filter((e) => (e.ts || 0) >= opts.since);
    if (opts.sort === 'oldest') out = out.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const limit = Number(opts.limit) || 300;
    return out.slice(0, limit);
}

module.exports = { logEvent, forPartner, allEvents, applyFilters, MAX_PER_PARTNER };

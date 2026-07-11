// Per-partner activity log for the partner cabinet: every verification grant
// (paid or not, with the reason it wasn't paid), every clawback debit and every
// verification removal. Persisted, queryable, and bounded per partner.
//
// Shape: partnerlog.json = { [creatorId]: [ event, … ] } where event =
//   { ts, type, reason, amount, userId, guildId, roleId, srcId }
//   type   : 'grant' | 'debit' | 'unverify'
//   reason : 'paid' | 'no_ad' | 'dup_join' | 'already_verified' | 'left'
//   srcId  : stable identity of the underlying fact (joinlink id, verified-entry
//            key, …). Every event that CAN be re-derived (live logging + startup
//            backfill) carries one, so the two can never produce two log lines
//            for the same fact. Timestamps are display-only, never an identity.
const { loadJSON, saveJSON } = require('./database.js');

const MAX_PER_PARTNER = Number(process.env.PARTNER_LOG_MAX) || 500;

function load() {
    const r = loadJSON('partnerlog.json', {});
    return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}
function save(o) { saveJSON('partnerlog.json', o); }

// Identity of an event. srcId-bearing events dedup on (type, srcId) — robust to
// timestamp drift between the live and backfill paths. Events with no srcId
// (none today; all emitters pass one) fall back to a full-tuple key.
function eventKey(e) {
    return e && e.srcId ? `${e.type}|${e.srcId}` : `${e.ts}|${e.type}|${e.reason}|${e.userId}|${e.guildId}`;
}

// Append one event for a partner (synchronous load-mutate-save = atomic in the
// single-threaded event loop). Idempotent on srcId: the same underlying fact is
// never logged twice — protects against gateway re-delivery, retries, and the
// backfill overlapping already-live-logged events. Bounded per partner.
function logEvent(creatorId, entry) {
    const cid = String(creatorId || '');
    if (!/^\d{17,20}$/.test(cid) || !entry || !entry.type) return;
    const all = load();
    if (!Array.isArray(all[cid])) all[cid] = [];
    const ev = {
        ts: Date.now(),
        type: String(entry.type),
        reason: entry.reason ? String(entry.reason) : null,
        amount: Number(entry.amount) || 0,
        userId: entry.userId ? String(entry.userId) : null,
        guildId: entry.guildId ? String(entry.guildId) : null,
        roleId: entry.roleId ? String(entry.roleId) : null,
        srcId: entry.srcId ? String(entry.srcId) : null
    };
    if (ev.srcId) {
        const key = eventKey(ev);
        if (all[cid].some((x) => eventKey(x) === key)) return; // already recorded
    }
    all[cid].push(ev);
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

// One-time backfill so the log isn't empty for history that happened before it
// existed. Paid grants + clawback debits + verification removals are derived
// from joinlinks.json (the payment ledger); unpaid grants from verified.json's
// noAd entries (never in joinlinks). Idempotent: guarded by a marker and
// deduped by event key, so a re-run can't double up.
// The reasons the source rebuild owns (derivable from the ledger). Everything
// else in the log — dup_join, already_verified — is live-only and is preserved.
const SOURCE_REASONS = new Set(['paid', 'no_ad', 'left', 'ads_off', 'server_off', 'all_hidden', 'already_member', 'capped', 'no_inventory']);

function backfillIfNeeded() {
    try {
        const meta = loadJSON('partnerlogmeta.json', {});
        if (meta && meta.rebuiltV2) return;

        const joinlinks = loadJSON('joinlinks.json', []);
        const verified = loadJSON('verified.json', []);
        const src = {};
        const add = (cid, ev) => { if (/^\d{17,20}$/.test(String(cid || ''))) (src[cid] ||= []).push(ev); };

        for (const r of (Array.isArray(joinlinks) ? joinlinks : [])) {
            if (!r || !r.creatorId || !r.id) continue;
            const ts = Number(r.ts) || 0;
            const base = { userId: r.userId || null, guildId: r.cardGuildId || null, roleId: r.roleId || null };
            add(r.creatorId, { ts, type: 'grant', reason: 'paid', amount: Number(r.amount) || 0, srcId: String(r.id), ...base });
            if (r.status === 'left') {
                const lt = Number(r.leftAt) || ts;
                add(r.creatorId, { ts: lt, type: 'debit', reason: 'left', amount: Number(r.amount) || 0, srcId: String(r.id), ...base });
                add(r.creatorId, { ts: lt, type: 'unverify', reason: 'left', amount: 0, srcId: String(r.id), ...base });
            }
        }
        for (const u of (Array.isArray(verified) ? verified : [])) {
            if (!u || !u.creatorId || !u.noAd) continue; // paid grants come from joinlinks
            add(u.creatorId, { ts: Number(u.timestamp) || 0, type: 'grant', reason: u.noAdReason || 'no_ad', amount: 0, userId: u.id || null, guildId: u.guildId || null, roleId: u.roleId || null, srcId: `v:${u.id}:${u.guildId}:${u.roleId || ''}` });
        }

        // Rebuild each partner's log: canonical source-derived events (srcId-keyed)
        // + the live-only entries we don't own. Deduped by identity. This seeds
        // history AND atomically removes any earlier timestamp-dup log lines.
        const all = load();
        let added = 0;
        for (const cid of new Set([...Object.keys(all), ...Object.keys(src)])) {
            const keptLive = (Array.isArray(all[cid]) ? all[cid] : []).filter((e) => e && !SOURCE_REASONS.has(e.reason));
            const merged = [...keptLive, ...(src[cid] || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
            const seen = new Set(); const out = [];
            for (const e of merged) { const k = eventKey(e); if (seen.has(k)) continue; seen.add(k); out.push(e); }
            all[cid] = out.slice(-MAX_PER_PARTNER);
            added += (src[cid] || []).length;
        }
        save(all);
        saveJSON('partnerlogmeta.json', { ...(meta || {}), backfilled: true, rebuiltV2: true, at: Date.now(), added });
        console.log(`[PARTNERLOG] rebuilt from source: ${added} derived event(s) across ${Object.keys(src).length} partner(s); duplicates removed`);
    } catch (e) {
        console.error('[PARTNERLOG] rebuild error:', e.message);
    }
}

module.exports = { logEvent, forPartner, allEvents, applyFilters, backfillIfNeeded, MAX_PER_PARTNER };

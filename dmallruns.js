// DMALL run tracking. The operator's run object does NOT echo the requested message
// count (only messages_sent / estimated), and its /runs list is account-wide (all
// operators). So we keep our own tiny map runId → { buyerId, serverId, count, lotId,
// charge, createdAt } to (a) show "sent / requested" and (b) show only the CALLER'S runs.
const { loadJSON, mutate } = require('./database.js');
const FILE = 'dmallruns.json';

function load() { const r = loadJSON(FILE, {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; }
function save(runId, data) {
    const id = String(runId || ''); if (!id) return;
    mutate(FILE, (o) => { o[id] = { ...(o[id] || {}), ...data, id }; });
}
function get(runId) { return load()[String(runId || '')] || null; }
function forBuyer(buyerId) {
    const o = load();
    return Object.values(o).filter((v) => v && String(v.buyerId || '') === String(buyerId || ''))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
// Runs where this user is the LOT OWNER (someone else bought a broadcast to their server) —
// their "sales", newest first. creatorId is stamped only when buyer ≠ lot owner.
function forCreator(creatorId) {
    const o = load();
    return Object.values(o).filter((v) => v && String(v.creatorId || '') === String(creatorId || ''))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Per-SERVER lifetime stats, keyed by guildId (serverId) — so they survive lot delete/recreate
// (dmallruns rows are keyed by runId and carry serverId). A "successful" broadcast delivered ≥1.
// Returns a map { [serverId]: { runs, delivered } } (all rows), or one server's stats via forServer.
function statsByServer() {
    const o = load();
    const out = {};
    for (const r of Object.values(o)) {
        const gid = r && String(r.serverId || '');
        const del = Math.max(0, Number(r && r.delivered) || 0);
        if (!gid || del <= 0) continue;
        if (!out[gid]) out[gid] = { runs: 0, delivered: 0 };
        out[gid].runs += 1; out[gid].delivered += del;
    }
    return out;
}
function forServer(gid) { return statsByServer()[String(gid || '')] || { runs: 0, delivered: 0 }; }

// Settled-run outcomes for one server: ok = delivered ≥1, failed = delivered 0. Used to decide
// if a server is "dead" (repeatedly failed, never delivered) vs simply new/untested.
function serverOutcomes(gid) {
    const o = load(); let ok = 0, failed = 0;
    for (const r of Object.values(o)) {
        if (!r || String(r.serverId || '') !== String(gid || '') || !r.settled) continue;
        if ((Number(r.delivered) || 0) > 0) ok++; else failed++;
    }
    return { ok, failed };
}

// Messages this user SOLD: delivered on runs against THEIR lots that someone else bought.
// run.creatorId is stamped only when the buyer ≠ the lot owner (own-server broadcasts don't
// count as a sale), so summing delivered where creatorId matches is exactly "sold". Complements
// forBuyer's delivered total ("bought").
function soldFor(creatorId) {
    const o = load(); let delivered = 0, runs = 0;
    for (const r of Object.values(o)) {
        if (!r || String(r.creatorId || '') !== String(creatorId || '')) continue;
        const del = Math.max(0, Number(r.delivered) || 0);
        delivered += del; if (del > 0) runs += 1;
    }
    return { delivered, runs };
}

// Has this buyer ever ordered a broadcast to this server? (Eligibility to leave a review —
// "bought any amount of messages on this server", regardless of how many were delivered.)
function boughtOn(serverId, buyerId) {
    const sid = String(serverId || ''), uid = String(buyerId || '');
    if (!sid || !uid) return false;
    return Object.values(load()).some((r) => r && String(r.serverId || '') === sid && String(r.buyerId || '') === uid);
}

module.exports = { FILE, load, save, get, forBuyer, forCreator, statsByServer, forServer, serverOutcomes, soldFor, boughtOn };

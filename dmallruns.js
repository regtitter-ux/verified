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

module.exports = { FILE, load, save, get, forBuyer, statsByServer, forServer };

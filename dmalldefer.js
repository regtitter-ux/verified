// Deferred DMALL delivery queue: when an order would push a server past the 24h
// send cap, the over-cap remainder is parked here (already PAID upfront as `prepaid`)
// and dripped back out into new runs by the resume sweep as the 24h window frees up.
// Flat JSON via database.mutate (single-writer, like the rest of the money model).
const crypto = require('node:crypto');
const database = require('./database.js');

const FILE = 'dmalldefer.json';

function load() { const d = database.loadJSON(FILE, { items: [] }); return (d && Array.isArray(d.items)) ? d : { items: [] }; }

// All pending deferred orders, oldest first (FIFO).
function list() { return load().items.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
function forServer(gid) { return list().filter((x) => String(x.serverId) === String(gid) && (Number(x.remaining) || 0) > 0); }
function hasServer(gid) { return forServer(gid).length > 0; }

// Park a remainder. `prepaid` is the buyer's already-charged money for these messages.
function add({ buyerId, serverId, remaining, prepaid, body, creatorId, creatorPrice, fee, createdAt }) {
    const item = {
        id: crypto.randomUUID(), buyerId: String(buyerId || ''), serverId: String(serverId || ''),
        remaining: Math.max(0, Math.floor(Number(remaining) || 0)), prepaid: +((Number(prepaid) || 0)).toFixed(2),
        body: body || null, creatorId: creatorId || '', creatorPrice: Number(creatorPrice) || 0, fee: Number(fee) || 0,
        createdAt: createdAt || Date.now(),
    };
    if (item.remaining <= 0) return item;
    database.mutate(FILE, (d) => { if (!Array.isArray(d.items)) d.items = []; d.items.push(item); }, { items: [] });
    return item;
}

// Consume `sent` messages worth `charge` from a deferred item (after a leg is launched).
// Removes the item once fully drained. Returns the updated remaining.
function consume(id, sent, charge) {
    let rem = 0;
    database.mutate(FILE, (d) => {
        const it = (d.items || []).find((x) => x.id === id); if (!it) return;
        it.remaining = Math.max(0, (Number(it.remaining) || 0) - Math.max(0, Math.floor(sent)));
        it.prepaid = +Math.max(0, (Number(it.prepaid) || 0) - Math.max(0, Number(charge) || 0)).toFixed(2);
        rem = it.remaining;
        if (it.remaining <= 0) d.items = d.items.filter((x) => x.id !== id);
    }, { items: [] });
    return rem;
}

module.exports = { FILE, load, list, forServer, hasServer, add, consume };

// Ticket mutes (staff moderation): a muted user can't open new tickets or reply to existing
// ones. Flat JSON via database.mutate. until = epoch ms, or -1 for a permanent mute.
const database = require('./database.js');
const FILE = 'dmallticketmutes.json';

function load() { const d = database.loadJSON(FILE, {}); return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}; }

// minutes: 0 or falsy → permanent.
function mute(userId, minutes) {
    const id = String(userId || ''); if (!id) return;
    const until = Number(minutes) > 0 ? Date.now() + Number(minutes) * 60_000 : -1;
    database.mutate(FILE, (d) => { d[id] = until; }, {});
}
function unmute(userId) {
    const id = String(userId || '');
    database.mutate(FILE, (d) => { delete d[id]; }, {});
}
function isMuted(userId) {
    const rec = load()[String(userId || '')];
    if (rec === undefined) return false;
    if (rec === -1) return true;
    return Number(rec) > Date.now();
}

module.exports = { FILE, load, mute, unmute, isMuted };

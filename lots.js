// Auction "lots": each lot sells a number of `stays`. The owner launches one from
// the admin panel; the bot opens a channel where people bid by posting a number.
// A bid that isn't outbid for the win window wins and the channel closes. This
// module is the persistent store (bid history + results); the Discord side
// (channel creation, message monitoring, timers) lives in lotmon.js.
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');

function load() { const r = loadJSON('lots.json', { lots: [] }); return (r && Array.isArray(r.lots)) ? r : { lots: [] }; }
function save(o) { saveJSON('lots.json', o); }

// Owner-editable message the bot posts when a lot opens. Placeholders:
//   {stays} = number of stays, {sb} = starting price, {ob} = min bid increment.
const DEFAULT_TEMPLATE =
    '# 💹 Lot: {stays} stays\n' +
    '**Starting price: ＄{sb}** · **minimal increase: ＄{ob}**\n\n' +
    'Post your bid as a number in the chat. If no one outbids it for 15 minutes, it wins and the lot closes.';
function getTemplate() { const t = load().template; return (typeof t === 'string' && t.trim()) ? t : DEFAULT_TEMPLATE; }
function setTemplate(text) { const db = load(); db.template = (text == null ? '' : String(text)).slice(0, 2000); save(db); return getTemplate(); }
function renderTemplate(stays, start, step) {
    return getTemplate().replace(/\{stays\}/g, String(stays)).replace(/\{sb\}/g, String(start)).replace(/\{ob\}/g, String(step));
}

// Owner-editable name of the channel the bot opens for a lot. Same {stays}
// placeholder as the message = number of stays. Discord itself lowercases and
// swaps spaces for dashes on text channels, so what you type is a hint, not exact.
const DEFAULT_CHANNEL_NAME = '💹﹒{stays}-stays';
function getChannelName() { const n = load().channelName; return (typeof n === 'string' && n.trim()) ? n : DEFAULT_CHANNEL_NAME; }
function setChannelName(text) { const db = load(); db.channelName = (text == null ? '' : String(text)).slice(0, 100); save(db); return getChannelName(); }
function renderChannelName(stays) {
    return getChannelName().replace(/\{stays\}/g, String(stays)).slice(0, 100).trim() || `${stays}-stays`;
}

function list() { return load().lots.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
function byId(id) { return load().lots.find((l) => l.id === id) || null; }
function activeByChannel(channelId) { return load().lots.find((l) => l.channelId === String(channelId) && l.status === 'active') || null; }
function activeLots() { return load().lots.filter((l) => l.status === 'active'); }

function create(rec) {
    const db = load();
    const lot = {
        id: crypto.randomBytes(6).toString('hex'),
        status: 'active',
        stays: 0, start: 0, step: 0,
        guildId: null, channelId: null, botId: null,
        highest: 0, highestBidder: null, lastMsgId: null, lastBidAt: 0,
        bids: [], createdAt: Date.now(), closedAt: null, winnerId: null, winnerBid: 0,
        ...rec
    };
    db.lots.push(lot);
    save(db);
    return lot;
}

function update(id, patch) {
    const db = load();
    const l = db.lots.find((x) => x.id === id);
    if (!l) return null;
    Object.assign(l, patch);
    save(db);
    return l;
}

// Append a winning-so-far bid and advance the highest.
function addBid(id, bid) {
    const db = load();
    const l = db.lots.find((x) => x.id === id);
    if (!l) return null;
    l.bids.push(bid);
    l.highest = bid.amount;
    l.highestBidder = bid.userId;
    l.lastBidAt = bid.ts;
    save(db);
    return l;
}

module.exports = { load, save, list, byId, activeByChannel, activeLots, create, update, addBid, getTemplate, setTemplate, renderTemplate, DEFAULT_TEMPLATE, getChannelName, setChannelName, renderChannelName, DEFAULT_CHANNEL_NAME };

// Public DMALL chat: a single shared room, Discord-style (newest at the bottom).
// Ported from the vibecheckbot chat. Storage is a flat JSON file on the Railway
// volume via database.mutate (single-writer, like everything else here). We keep
// only the last MAX messages — older ones fall off on insert.
const crypto = require('node:crypto');
const database = require('./database.js');

const FILE = 'dmallchat.json';
const MAX_CHAT = 100;

function load() {
    const d = database.loadJSON(FILE, { messages: [] });
    return (d && Array.isArray(d.messages)) ? d : { messages: [] };
}

// Last MAX messages (oldest first, newest last).
function list() {
    return load().messages.slice(-MAX_CHAT);
}

function get(id) {
    return load().messages.find((m) => m.id === String(id)) || null;
}

// Append a message and trim to the last MAX. Returns the stored message.
// reply = { userId, name, text } | null (a ping + snippet of the answered message).
function post({ userId, name, avatar, body, reply }) {
    const msg = {
        id: crypto.randomUUID(),
        userId: String(userId || ''),
        name: name || null,
        avatar: avatar || null,
        body: String(body || ''),
        reply: reply || null,
        at: new Date().toISOString(),
    };
    database.mutate(FILE, (d) => {
        if (!Array.isArray(d.messages)) d.messages = [];
        // Collapse accidental bursts: identical text+reply from the same user within 3s
        // (the classic bad-network double-send) — keep the first, drop the echo.
        const last = d.messages[d.messages.length - 1];
        if (last && last.userId === msg.userId && last.body === msg.body
            && JSON.stringify(last.reply || null) === JSON.stringify(msg.reply || null)
            && (Date.parse(msg.at) - Date.parse(last.at)) < 3000) return false;
        d.messages.push(msg);
        if (d.messages.length > MAX_CHAT) d.messages = d.messages.slice(-MAX_CHAT);
    }, { messages: [] });
    return msg;
}

// Delete one message by id. Returns true if it was present.
function del(id) {
    let removed = false;
    database.mutate(FILE, (d) => {
        const before = d.messages.length;
        d.messages = d.messages.filter((m) => m.id !== String(id));
        removed = d.messages.length !== before;
    }, { messages: [] });
    return removed;
}

// Delete every message from a user (moderation). Returns the count removed.
function delByUser(userId) {
    let n = 0;
    database.mutate(FILE, (d) => {
        const before = d.messages.length;
        d.messages = d.messages.filter((m) => m.userId !== String(userId));
        n = before - d.messages.length;
    }, { messages: [] });
    return n;
}

module.exports = { FILE, MAX_CHAT, load, list, get, post, del, delByUser };

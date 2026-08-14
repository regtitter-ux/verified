// DMALL support tickets. Users open tickets; any staff member can reply. Flat JSON
// via database.mutate (single-writer, like the rest of the store). Statuses:
//   open     — awaiting a staff reply (new ticket, or the user answered last)
//   answered — staff replied last, awaiting the user
//   closed   — resolved / closed (a new reply reopens it)
const crypto = require('node:crypto');
const database = require('./database.js');

const FILE = 'dmalltickets.json';
const MAX_MSGS = 300;
const SUBJECT_MAX = 140;
const BODY_MAX = 2000;

function load() { const d = database.loadJSON(FILE, {}); return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}; }
const clip = (s, n) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim().slice(0, n);

const ATT_MAX = 10;
function msg(authorId, authorName, staff, body, attachments) {
    return {
        id: crypto.randomUUID(), authorId: String(authorId || ''), authorName: authorName || null, staff: !!staff,
        body: clip(body, BODY_MAX), attachments: Array.isArray(attachments) ? attachments.slice(0, ATT_MAX) : [],
        at: new Date().toISOString(),
    };
}

// Public view of a ticket (optionally without the full message list, for lists).
function view(t, withMessages) {
    if (!t) return null;
    const last = t.messages && t.messages[t.messages.length - 1];
    const o = {
        id: t.id, userId: t.userId, userName: t.userName || null, subject: t.subject || '',
        status: t.status || 'open', createdAt: t.createdAt || 0, updatedAt: t.updatedAt || 0,
        messageCount: (t.messages || []).length,
        lastAt: last ? last.at : t.createdAt, lastStaff: last ? !!last.staff : false,
        staffReadAt: t.staffReadAt || 0, userReadAt: t.userReadAt || 0,
    };
    if (withMessages) o.messages = (t.messages || []).slice();
    return o;
}

function get(id, withMessages) { return view(load()[String(id || '')], withMessages); }
function raw(id) { return load()[String(id || '')] || null; }

// Everything, newest activity first.
function list(withMessages) { return Object.values(load()).map((t) => view(t, withMessages)).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
function forUser(userId) { return list().filter((t) => String(t.userId) === String(userId)); }

function create({ userId, userName, subject, body, attachments }) {
    const now = Date.now();
    const t = {
        id: crypto.randomUUID(), userId: String(userId || ''), userName: userName || null,
        subject: clip(subject, SUBJECT_MAX) || 'Ticket', status: 'open',
        createdAt: now, updatedAt: now, staffReadAt: 0, userReadAt: now,
        messages: [msg(userId, userName, false, body, attachments)],
    };
    database.mutate(FILE, (d) => { d[t.id] = t; });
    return view(t, true);
}

// Append a reply. staff=true when a staff member answers. Reopens a closed ticket.
// Returns the updated ticket view, or null if not found.
function reply(id, { authorId, authorName, staff, body, attachments }) {
    const b = clip(body, BODY_MAX);
    const att = Array.isArray(attachments) ? attachments.slice(0, ATT_MAX) : [];
    if (!b && !att.length) return null;   // a message must carry text or an attachment
    let out = null;
    database.mutate(FILE, (d) => {
        const t = d[String(id || '')]; if (!t) return false;
        if (!Array.isArray(t.messages)) t.messages = [];
        t.messages.push(msg(authorId, authorName, staff, b, att));
        if (t.messages.length > MAX_MSGS) t.messages = t.messages.slice(-MAX_MSGS);
        t.status = staff ? 'answered' : 'open';   // a reply reopens a closed ticket
        t.updatedAt = Date.now();
        if (staff) t.staffReadAt = Date.now(); else t.userReadAt = Date.now();
        out = t.id;
    });
    return out ? get(out, true) : null;
}

// Staff sets open/answered/closed; a user may only close their own ticket.
function setStatus(id, status, { byStaff, byUserId }) {
    const allowed = ['open', 'answered', 'closed'];
    if (!allowed.includes(status)) return null;
    let ok = false;
    database.mutate(FILE, (d) => {
        const t = d[String(id || '')]; if (!t) return false;
        if (!byStaff && !(status === 'closed' && String(t.userId) === String(byUserId))) return false;   // users may only close their own
        t.status = status; t.updatedAt = Date.now(); ok = true;
    });
    return ok ? get(id, true) : null;
}

// Delete a single message — only the author may delete their own (staff included; nobody may
// delete someone else's). Returns the updated ticket, or null if not found / not allowed.
function deleteMessage(ticketId, messageId, byUserId) {
    let out = null;
    database.mutate(FILE, (d) => {
        const t = d[String(ticketId || '')]; if (!t || !Array.isArray(t.messages)) return false;
        const m = t.messages.find((x) => x.id === String(messageId));
        if (!m || String(m.authorId) !== String(byUserId)) return false;   // own messages only
        t.messages = t.messages.filter((x) => x.id !== String(messageId));
        t.updatedAt = Date.now();
        out = t.id;
    });
    return out ? get(out, true) : null;
}

// Delete a whole ticket (staff moderation). Returns true if it existed.
function remove(id) {
    let ok = false;
    database.mutate(FILE, (d) => { if (d[String(id || '')]) { delete d[String(id || '')]; ok = true; } });
    return ok;
}

// How many NON-closed tickets a user currently has (open + answered) — for the per-user cap.
function openCountForUser(userId) {
    return Object.values(load()).filter((t) => t && String(t.userId) === String(userId) && t.status !== 'closed').length;
}

// Mark a ticket read for the viewer (staff or the owner).
function markRead(id, { staff }) {
    database.mutate(FILE, (d) => { const t = d[String(id || '')]; if (!t) return false; if (staff) t.staffReadAt = Date.now(); else t.userReadAt = Date.now(); });
}

// Is a ticket unread for the given side? (a newer message from the OTHER side than their last read)
function unreadForStaff(t) { return t.status !== 'closed' && !t.lastStaff && new Date(t.lastAt).getTime() > (t.staffReadAt || 0); }
function unreadForUser(t) { return t.lastStaff && new Date(t.lastAt).getTime() > (t.userReadAt || 0); }

const MAX_OPEN_PER_USER = 3;
module.exports = { FILE, load, get, raw, list, forUser, create, reply, setStatus, markRead, deleteMessage, remove, openCountForUser, view, unreadForStaff, unreadForUser, SUBJECT_MAX, BODY_MAX, MAX_OPEN_PER_USER };

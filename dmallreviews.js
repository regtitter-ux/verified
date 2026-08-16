// DMALL server reviews. Buyers who broadcast to a server can leave ONE star review
// (1–5) on that server's card; the lot owner can reply; admins can delete anything.
//
// Reviews are keyed by SERVER id, not by lot id — so deleting/recreating the lot never
// loses them (a re-listed server shows its old reviews). Flat JSON via database.mutate
// (single-writer, like the rest of the store).
//
//   dmallreviews.json = { [serverId]: [ review, … ] }
//   review = { id, userId, name, avatar, stars, text, at, editedAt|null,
//              reply: { text, at, editedAt|null } | null }
const crypto = require('node:crypto');
const database = require('./database.js');

const FILE = 'dmallreviews.json';
const TEXT_MAX = 200;    // hard cap on a review body (anti-abuse)
const REPLY_MAX = 500;   // owner replies can be a bit longer

function load() { const d = database.loadJSON(FILE, {}); return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}; }
// Normalize + bound a body: strip all control chars (incl. newlines/tabs) to spaces,
// collapse runs of whitespace, trim, then hard-cap the length. No abuse via hidden chars.
const clip = (s, n) => String(s == null ? '' : s).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const clampStars = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 0)));

// Public view of one review (safe shape). `viewerId`/`isOwner`/`isAdmin` decorate per-request
// flags the client uses to show edit/delete/reply controls.
function view(r, { viewerId, isOwner, isAdmin } = {}) {
    if (!r) return null;
    return {
        id: r.id, userId: r.userId || '', name: r.name || null, avatar: r.avatar || null,
        stars: clampStars(r.stars), text: String(r.text || ''),
        at: r.at || 0, editedAt: r.editedAt || 0,
        reply: r.reply ? { text: String(r.reply.text || ''), at: r.reply.at || 0, editedAt: r.reply.editedAt || 0 } : null,
        own: !!(viewerId && String(r.userId) === String(viewerId)),
        canDelete: !!(isAdmin || (viewerId && String(r.userId) === String(viewerId))),
        canReply: !!(isOwner || isAdmin),
    };
}

function rawList(serverId) { const a = load()[String(serverId || '')]; return Array.isArray(a) ? a : []; }

// Reviews for a server, newest first, but the viewer's OWN review pinned to the top.
function listFor(serverId, opts = {}) {
    const arr = rawList(serverId).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    if (opts.viewerId) arr.sort((a, b) => (String(b.userId) === String(opts.viewerId) ? 1 : 0) - (String(a.userId) === String(opts.viewerId) ? 1 : 0));
    return arr.map((r) => view(r, opts)).filter(Boolean);
}

function mineFor(serverId, userId) {
    const r = rawList(serverId).find((x) => String(x.userId) === String(userId || ''));
    return r ? view(r, { viewerId: userId }) : null;
}

// Average + count + per-star breakdown for the card badge.
function summary(serverId) {
    const arr = rawList(serverId);
    const count = arr.length;
    const breakdown = [0, 0, 0, 0, 0];
    let sum = 0;
    for (const r of arr) { const s = clampStars(r.stars); breakdown[s - 1]++; sum += s; }
    return { count, average: count ? +(sum / count).toFixed(1) : 0, breakdown };
}

// Create or update the caller's SINGLE review for this server. Returns the stored view.
function upsert(serverId, { userId, name, avatar, stars, text }) {
    const sid = String(serverId || ''); const uid = String(userId || '');
    const s = clampStars(stars); const body = clip(text, TEXT_MAX);
    if (!/^\d{17,20}$/.test(sid) || !/^\d{17,20}$/.test(uid)) return null;
    let out = null;
    database.mutate(FILE, (d) => {
        if (!Array.isArray(d[sid])) d[sid] = [];
        const now = Date.now();
        const existing = d[sid].find((x) => String(x.userId) === uid);
        if (existing) {
            existing.stars = s; existing.text = body; existing.editedAt = now;
            if (name != null) existing.name = name; if (avatar != null) existing.avatar = avatar;
            out = existing.id;
        } else {
            const r = { id: crypto.randomUUID(), userId: uid, name: name || null, avatar: avatar || null, stars: s, text: body, at: now, editedAt: 0, reply: null };
            d[sid].push(r); out = r.id;
        }
    });
    return out ? view(rawList(sid).find((x) => x.id === out), { viewerId: uid }) : null;
}

// Delete a review — its author, or an admin. Returns true if removed.
function remove(serverId, reviewId, { byUserId, isAdmin }) {
    const sid = String(serverId || '');
    let ok = false;
    database.mutate(FILE, (d) => {
        const arr = d[sid]; if (!Array.isArray(arr)) return false;
        const r = arr.find((x) => x.id === String(reviewId)); if (!r) return false;
        if (!isAdmin && String(r.userId) !== String(byUserId || '')) return false;
        d[sid] = arr.filter((x) => x.id !== String(reviewId));
        ok = true;
    });
    return ok;
}

// Owner/admin sets or edits the reply to a review. Empty text removes the reply.
function setReply(serverId, reviewId, text) {
    const sid = String(serverId || ''); const body = clip(text, REPLY_MAX);
    let out = null;
    database.mutate(FILE, (d) => {
        const arr = d[sid]; if (!Array.isArray(arr)) return false;
        const r = arr.find((x) => x.id === String(reviewId)); if (!r) return false;
        if (!body) { r.reply = null; out = r.id; return; }
        const now = Date.now();
        r.reply = r.reply ? { text: body, at: r.reply.at || now, editedAt: now } : { text: body, at: now, editedAt: 0 };
        out = r.id;
    });
    return out ? view(rawList(sid).find((x) => x.id === out)) : null;
}

module.exports = { FILE, TEXT_MAX, REPLY_MAX, load, listFor, mineFor, summary, upsert, remove, setReply, view };

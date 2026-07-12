// Admin action audit log.
//
// fundslog records money movements; this records WHO in the panel did WHAT —
// balance edits, share/rate changes, admin/manager grants, ad/kran toggles,
// card and feed edits, token rotation, bots added/removed from servers, etc.
// Kept so a multi-person team is accountable and abuse is traceable. Rolling,
// capped, stored on the volume.
const { loadJSON, saveJSON } = require('./database.js');

const KEEP = Number(process.env.AUDIT_KEEP) || 5000;

function loadAudit() { const r = loadJSON('auditlog.json', []); return Array.isArray(r) ? r : []; }

// `key` (optional) is a stable identity for the event so the one-time backfill
// can dedup against live-logged entries.
function logAction(userId, action, detail, key) {
    try {
        const list = loadAudit();
        const e = {
            ts: Date.now(),
            userId: String(userId || ''),
            action: String(action || ''),
            detail: detail == null ? '' : String(detail).slice(0, 500)
        };
        if (key) e.key = String(key);
        list.push(e);
        while (list.length > KEEP) list.shift();
        saveJSON('auditlog.json', list);
    } catch (e) { console.error('[AUDIT]', e.message); }
}

// Most-recent-first, capped.
function recent(limit = 300) {
    const l = loadAudit();
    return l.slice(-Math.max(0, limit)).reverse();
}

// One-time backfill so the log isn't empty for history that predates it: every
// verification card ever created/deleted (from cards.json) and every server a
// network bot is currently on (join time from the bot's own membership). Each
// event carries a member count and a server/card link where available.
// Idempotent: guarded by a marker and deduped by key against live entries.
function backfillOnce(clients, cards) {
    try {
        const meta = loadJSON('auditmeta.json', {});
        if (meta.auditBackfillV1) return;

        const guildInfo = (gid) => {
            for (const c of (Array.isArray(clients) ? clients : [])) {
                const g = c.guilds?.cache?.get(String(gid));
                if (g) return { name: g.name, count: g.memberCount };
            }
            return { name: null, count: null };
        };
        const fmtCount = (n) => (n == null ? '' : ` · ${Number(n).toLocaleString('en-US')} участников`);
        const link = (gid) => (gid ? ` · https://discord.com/channels/${gid}` : '');

        const derived = [];
        for (const c of (cards.loadCards() || [])) {
            const gi = guildInfo(c.guildId);
            const gname = gi.name || String(c.guildId || '?');
            if (c.createdAt) derived.push({ ts: c.createdAt, userId: c.creatorId || '', action: 'card.create', detail: `${gname} (${c.guildId || '?'})${fmtCount(gi.count)}${link(c.guildId)}`, key: `card.create|${c.messageId}` });
            if (c.deletedAt) derived.push({ ts: c.deletedAt, userId: c.deletedBy || 'system', action: 'card.delete', detail: `owner ${c.creatorId || '?'} · ${gname} (${c.guildId || '?'})${fmtCount(gi.count)}${link(c.guildId)}`, key: `card.delete|${c.messageId}` });
        }
        for (const c of (Array.isArray(clients) ? clients : [])) {
            const uname = c.user?.username || c.user?.id || 'bot';
            for (const g of (c.guilds?.cache?.values?.() || [])) {
                const ts = g.members?.me?.joinedTimestamp || 0;
                if (!ts) continue;
                derived.push({ ts, userId: 'discord', action: 'bot.join', detail: `${uname} → ${g.name} (${g.id})${fmtCount(g.memberCount)}${link(g.id)}`, key: `bot.join|${c.user?.id}|${g.id}` });
            }
        }

        const list = loadAudit();
        const seen = new Set(list.map((e) => e.key || `${e.ts}|${e.action}|${e.detail}`));
        let added = 0;
        for (const e of derived) {
            if (seen.has(e.key)) continue;
            seen.add(e.key);
            list.push({ ts: e.ts, userId: String(e.userId || ''), action: e.action, detail: String(e.detail).slice(0, 500), key: e.key });
            added++;
        }
        list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        while (list.length > KEEP) list.shift();
        saveJSON('auditlog.json', list);
        saveJSON('auditmeta.json', { ...meta, auditBackfillV1: true, at: Date.now(), added });
        console.log(`[AUDIT] backfilled ${added} historical event(s)`);
    } catch (e) { console.error('[AUDIT] backfill error:', e.message); }
}

module.exports = { logAction, recent, loadAudit, backfillOnce };

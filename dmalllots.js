// DMALL lots — a self-serve marketplace of servers for mass-DM broadcasts.
//
// A server owner adds the DMALL bot (client 1525863543310651442) to their server with
// admin, then creates a "lot": their server + a price per 1000 messages. DMALL users
// broadcast to that server and pay the LOT CREATOR'S price + the service fee ($1/1000).
// The creator, running DMALL on their OWN server, pays only the service fee.
//
// This module is the lot store + the bot-presence check (via the auth-bot token, linked
// from the auth-bot Railway service as AUTH_BOT_TOKEN). Storage is a flat JSON file,
// written only through database.mutate (the single-writer money invariant).
const crypto = require('crypto');
const { loadJSON, mutate } = require('./database.js');
const { round2 } = require('./round.js');

const FILE = 'dmalllots.json';
const SERVICE_FEE_PER_1K = Number(process.env.DMALL_SERVICE_FEE_PER_1K) || 1;   // $ per 1000 messages
// The bot the user adds to their server; on join it auto-adds the DMALL service account.
const DMALL_BOT_CLIENT_ID = (process.env.DMALL_BOT_CLIENT_ID || '1525863543310651442').trim();

function load() { const r = loadJSON(FILE, {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; }
function newId() { return 'lot_' + crypto.randomBytes(6).toString('hex'); }

// Total price a DMALL user pays per 1000 messages to broadcast to this lot's server.
function userPricePer1k(creatorPrice) { return round2((Number(creatorPrice) || 0) + SERVICE_FEE_PER_1K); }

function view(l) {
    if (!l) return null;
    return {
        id: l.id, creatorId: l.creatorId || '', serverId: l.serverId || '', serverName: l.serverName || '',
        memberCount: Number(l.memberCount) || 0,
        pricePer1k: Math.max(0, Number(l.pricePer1k) || 0),
        userPricePer1k: userPricePer1k(l.pricePer1k),
        serviceFeePer1k: SERVICE_FEE_PER_1K,
        private: Boolean(l.private),   // private lots are visible only to their creator
        createdAt: l.createdAt || 0
    };
}

function list() { return Object.values(load()).map(view).filter(Boolean).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
function get(id) { return view(load()[String(id || '')]); }

// Create a lot (the caller has already been verified: bot present on the server).
function create(creatorId, { serverId, serverName, memberCount, pricePer1k }) {
    const id = newId();
    const lot = {
        id, creatorId: String(creatorId || ''), serverId: String(serverId || ''),
        serverName: String(serverName || ''), memberCount: Math.max(0, Math.floor(Number(memberCount) || 0)),
        pricePer1k: Math.max(0, Number(pricePer1k) || 0), createdAt: Date.now()
    };
    mutate(FILE, (o) => { o[id] = lot; });
    return view(lot);
}

// Update a lot's price / privacy / owner — only its creator (or staff) may. The server can't
// change (it's the lot's identity). creatorId hands the lot to another user (its own creator can
// give it away; staff can reassign any lot). Returns the updated view, or null if not found/allowed.
function update(id, byId, isStaff, patch) {
    const g = String(id || '');
    let out = null;
    mutate(FILE, (o) => {
        const l = o[g];
        if (!l) return false;
        if (!isStaff && String(l.creatorId || '') !== String(byId || '')) return false;
        if (patch && patch.pricePer1k != null) l.pricePer1k = Math.max(0, Number(patch.pricePer1k) || 0);
        if (patch && patch.private != null) l.private = Boolean(patch.private);
        if (patch && patch.creatorId != null && /^\d{17,20}$/.test(String(patch.creatorId))) l.creatorId = String(patch.creatorId);
        out = { ...l };
    });
    return out ? view(out) : null;
}

// Remove a lot — only its creator (or staff) may.
function remove(id, byId, isStaff) {
    const g = String(id || '');
    let ok = false;
    mutate(FILE, (o) => {
        const l = o[g];
        if (!l) return false;
        if (!isStaff && String(l.creatorId || '') !== String(byId || '')) return false;
        delete o[g]; ok = true;
    });
    return ok;
}

// Is the DMALL bot present on this guild? Uses the auth-bot token (Discord GET /guilds).
// Returns { ok, name, members } or { ok:false, reason }.
async function botOnGuild(gid) {
    const tok = (process.env.AUTH_BOT_TOKEN || '').trim();
    if (!tok) return { ok: false, reason: 'no-token' };
    if (!/^\d{17,20}$/.test(String(gid || ''))) return { ok: false, reason: 'bad-gid' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
        const r = await fetch(`https://discord.com/api/v10/guilds/${gid}?with_counts=true`, { headers: { Authorization: 'Bot ' + tok }, signal: ctrl.signal });
        if (r.status === 200) { const g = await r.json().catch(() => ({})); return { ok: true, name: g.name || '', members: Number(g.approximate_member_count) || 0 }; }
        if (r.status === 404 || r.status === 403) return { ok: false, reason: 'not-member' };
        return { ok: false, reason: 'status-' + r.status };
    } catch (e) {
        return { ok: false, reason: (e && e.name === 'AbortError') ? 'timeout' : 'unreachable' };
    } finally { clearTimeout(timer); }
}

// Live guild presentation (name / member count / icon + banner CDN URLs) for a lot's server,
// via the auth-bot. Cached in-memory (10 min) so listing N lots doesn't hammer Discord.
// Icons/banners are requested as static PNG (animated a_ hashes render their first frame,
// avoiding broken .gif CDN assets). Returns null if unavailable.
const _guildCache = new Map();
const GUILD_TTL = 10 * 60 * 1000;
async function guildInfo(gid) {
    const g = String(gid || '');
    const c = _guildCache.get(g);
    if (c && Date.now() - c.at < GUILD_TTL) return c.info;
    const tok = (process.env.AUTH_BOT_TOKEN || '').trim();
    if (!tok || !/^\d{17,20}$/.test(g)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);   // don't let one slow guild stall the whole lot list
    let info = null;
    try {
        const r = await fetch(`https://discord.com/api/v10/guilds/${g}?with_counts=true`, { headers: { Authorization: 'Bot ' + tok }, signal: ctrl.signal });
        if (r.status === 200) {
            const d = await r.json().catch(() => ({}));
            info = {
                present: true,
                name: d.name || '',
                members: Number(d.approximate_member_count) || 0,
                icon: d.icon ? `https://cdn.discordapp.com/icons/${g}/${d.icon}.png?size=128` : '',
                banner: d.banner ? `https://cdn.discordapp.com/banners/${g}/${d.banner}.png?size=600` : ''
            };
        } else if (r.status === 404 || r.status === 403) {
            info = { present: false };   // the auth bot is no longer on the guild (kicked / removed)
        } else {
            return null;   // transient (5xx / rate limit) → unknown, don't cache
        }
        _guildCache.set(g, { at: Date.now(), info });
        return info;
    } catch (_) {
        return null;   // timeout / network → unknown
    } finally { clearTimeout(timer); }
}

// Prime / clear the guild-presence cache. Called on lot create so a freshly-added
// server is never hidden by a STALE `present:false` cached (10-min TTL) from before the
// bot was on the server: create's own live botOnGuild() already confirmed presence, but
// the lot list uses the cached guildInfo() and would otherwise drop the brand-new lot.
function primeGuild(gid, info) { _guildCache.set(String(gid || ''), { at: Date.now(), info }); }
function invalidateGuild(gid) { _guildCache.delete(String(gid || '')); }

module.exports = { FILE, SERVICE_FEE_PER_1K, DMALL_BOT_CLIENT_ID, userPricePer1k, list, get, create, update, remove, botOnGuild, guildInfo, primeGuild, invalidateGuild, view };

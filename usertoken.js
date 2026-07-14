// RESERVE join verifier — personal Discord USER account(s), joined to a buyer's
// server on request, whose membership data the network bots read via user token(s).
// Used ONLY as an INVISIBLE fallback for sponsor servers where no network bot is
// present; buyers never see it and the order cabinet stays bot-only. It does the
// SAME lightweight single-member reads the bots already do — just over user tokens.
//
// Multiple tokens are supported: set USER_TOKEN to several tokens separated by
// newlines/commas/spaces (via the admin panel or Railway). Every account's servers
// are pooled, and each server is verified through whichever account is in it.
//
// NOTE: automating a user account is against Discord's ToS and can get the account
// banned — operate at your own risk, on disposable accounts.
const https = require('https');
const config = require('./config.js');

// Current tokens, read live so panel edits apply without a restart.
function tokens() {
    return config.get('USER_TOKEN').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
}
const enabled = () => tokens().length > 0;

function apiGet(token, path) {
    return new Promise((resolve) => {
        const req = https.request({
            host: 'discord.com', path: '/api/v10' + path, method: 'GET',
            headers: { Authorization: token, 'Content-Type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { let json = null; try { json = data ? JSON.parse(data) : null; } catch { /* non-json */ } resolve({ status: res.statusCode || 0, json }); });
        });
        req.on('error', () => resolve({ status: 0, json: null }));
        req.setTimeout(12000, () => req.destroy());
        req.end();
    });
}

// guildId -> token that covers it. Refreshed lazily across all accounts.
let _cache = { at: 0, map: new Map() };
const TTL = 5 * 60 * 1000;
async function refresh(force = false) {
    const toks = tokens();
    if (!toks.length) { _cache = { at: Date.now(), map: new Map() }; return _cache.map; }
    if (!force && Date.now() - _cache.at < TTL) return _cache.map;
    const map = new Map();
    for (const tk of toks) {
        const { status, json } = await apiGet(tk, '/users/@me/guilds');
        if (status === 200 && Array.isArray(json)) {
            for (const g of json) { const id = String(g.id); if (!map.has(id)) map.set(id, tk); }
        } else if (status === 401) {
            console.error('[USERTOKEN] a token is unauthorized/expired — skipped');
        }
        // transient (0/429/5xx): skip this token this round.
    }
    // Avoid flapping to empty on a transient all-fail: keep the previous map then.
    _cache = { at: Date.now(), map: (map.size || !_cache.map.size) ? map : _cache.map };
    return _cache.map;
}

async function coveredGuildIds() { return new Set((await refresh()).keys()); }
async function coversGuild(guildId) { return (await refresh()).has(String(guildId)); }

// Is `userId` a member of `guildId`, via the account that covers that guild?
// true / false / null (couldn't tell — transient / not permitted). Returns null if
// no account covers the guild, so a 404 unambiguously means "not a member".
async function isMember(guildId, userId) {
    if (!enabled()) return null;
    const tk = (await refresh()).get(String(guildId));
    if (!tk) return null;
    const { status } = await apiGet(tk, `/guilds/${guildId}/members/${userId}`);
    if (status === 200) return true;
    if (status === 404) return false;   // Unknown Member
    return null;                         // 401/403/429/5xx/network — don't act
}

module.exports = { enabled, coveredGuildIds, coversGuild, isMember };

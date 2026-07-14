// RESERVE join verifier — a personal Discord USER account (joined to a buyer's
// server on request) whose membership data the network bots read via the user
// token. Used ONLY as an INVISIBLE fallback for sponsor servers where no network
// bot is present; buyers never see it and the order cabinet keeps showing the
// normal "add the bot" state. It performs the SAME lightweight single-member reads
// the bots already do — just through a user token instead of a gateway.
//
// NOTE: automating a user account is against Discord's ToS and can get the account
// banned — operate at your own risk. Configure with USER_TOKEN (the account token).
const https = require('https');

const TOKEN = (process.env.USER_TOKEN || '').trim();
const enabled = () => Boolean(TOKEN);

function apiGet(path) {
    return new Promise((resolve) => {
        const req = https.request({
            host: 'discord.com', path: '/api/v10' + path, method: 'GET',
            headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }
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

// Cached set of guild ids the account is currently a member of. Refreshed lazily.
let _cache = { at: 0, set: new Set() };
const TTL = 5 * 60 * 1000;
async function coveredGuildIds(force = false) {
    if (!enabled()) return new Set();
    if (!force && Date.now() - _cache.at < TTL) return _cache.set;
    const { status, json } = await apiGet('/users/@me/guilds');
    if (status === 200 && Array.isArray(json)) {
        _cache = { at: Date.now(), set: new Set(json.map((g) => String(g.id))) };
    } else {
        if (status === 401) console.error('[USERTOKEN] unauthorized — USER_TOKEN invalid/expired');
        // Keep the previous set on a transient failure; only stamp time so we don't hammer.
        _cache = { at: Date.now(), set: _cache.set };
    }
    return _cache.set;
}
async function coversGuild(guildId) { return (await coveredGuildIds()).has(String(guildId)); }

// Is `userId` a member of `guildId`, seen through the personal account?
// true / false / null (couldn't tell — transient / not permitted). Callers gate on
// coversGuild first, so a 404 unambiguously means "target user isn't a member".
async function isMember(guildId, userId) {
    if (!enabled()) return null;
    const { status } = await apiGet(`/guilds/${guildId}/members/${userId}`);
    if (status === 200) return true;
    if (status === 404) return false;   // Unknown Member
    return null;                         // 401/403/429/5xx/network — don't act
}

module.exports = { enabled, coveredGuildIds, coversGuild, isMember };

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
const reservegw = require('./reservegw.js');

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

// Prefer the gateway (persistent connection) when it's up — it's the reliable path
// for user-token membership; REST is the fallback.
async function coveredGuildIds() {
    if (reservegw.enabled() && reservegw.ready()) return reservegw.coveredGuildIds();
    return new Set((await refresh()).keys());
}
async function coversGuild(guildId) {
    if (reservegw.enabled() && reservegw.ready()) return reservegw.coversGuild(guildId);
    return (await refresh()).has(String(guildId));
}

// Is `userId` a member of `guildId`, via the account that covers that guild?
// true / false / null (couldn't tell). Tries the gateway first, then REST.
async function isMember(guildId, userId) {
    if (!enabled()) return null;
    if (reservegw.enabled() && reservegw.ready()) {
        const r = await reservegw.isMember(guildId, userId);
        if (r !== null) return r;           // gateway answered → trust it
        // gateway couldn't answer (guild not on this conn / timeout) → try REST
    }
    const tk = (await refresh()).get(String(guildId));
    if (!tk) return null;
    const { status } = await apiGet(tk, `/guilds/${guildId}/members/${userId}`);
    if (status === 200) return true;
    if (status === 404) return false;   // Unknown Member
    return null;                         // 401/403/429/5xx/network — don't act
}

// The account id is the base64 first segment of the token — enough to identify a
// bad entry in the panel without ever echoing the secret back.
function idFromToken(tk) {
    try {
        const id = Buffer.from(String(tk).split('.')[0], 'base64').toString('utf8').replace(/\D/g, '');
        return /^\d{17,20}$/.test(id) ? id : null;
    } catch { return null; }
}

// Check a raw USER_TOKEN value (newline/comma/space separated) against Discord
// before it's stored, so a dead token can't be saved and silently cover nothing.
// Returns { ok: [{ line, id, username }], bad: [{ line, id, reason }] }.
// Only 401 is a definitive "dead"; anything else is reported as unverifiable
// rather than quietly accepted.
async function validateTokens(raw) {
    const list = String(raw || '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    const ok = [], bad = [];
    for (let i = 0; i < list.length; i++) {
        const tk = list[i];
        const id = idFromToken(tk);
        const { status, json } = await apiGet(tk, '/users/@me');
        if (status === 200 && json && json.id) ok.push({ line: i + 1, id: json.id, username: json.username || null });
        else if (status === 401) bad.push({ line: i + 1, id, reason: 'невалиден или истёк' });
        else bad.push({ line: i + 1, id, reason: status === 0 ? 'не удалось проверить (сеть) — попробуй ещё раз' : `не удалось проверить (HTTP ${status})` });
    }
    return { ok, bad };
}

module.exports = { enabled, coveredGuildIds, coversGuild, isMember, validateTokens };

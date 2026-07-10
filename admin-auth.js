// Admin panel authentication — Discord OAuth2 + HMAC-signed, role-aware
// session cookies. Zero external deps (Node's built-in crypto + https).
//
// Env vars (Railway):
//   ADMIN_SESSION_SECRET   — long random string; signs session cookies.
//   DISCORD_CLIENT_ID      — the Discord application's client id.
//   DISCORD_CLIENT_SECRET  — that application's OAuth2 client secret.
//   ADMIN_OAUTH_REDIRECT   — the OAuth2 redirect registered in the Discord
//                            app, e.g. https://<api-host>/admin/oauth/callback
//   ADMIN_ORIGIN           — where to send the browser after login (the admin
//                            panel), default https://vemoni.info
//   ADMIN_OWNER_ID         — Discord id of the project owner (full access).
//
// Access model: the owner has everything; assigned admins (admins.json) have
// everything except Templates, Balances and the Crypto Pay top-up.
const crypto = require('crypto');
const https = require('https');
const { loadJSON, saveJSON } = require('./database.js');

const ADMIN_SESSION_SECRET = (process.env.ADMIN_SESSION_SECRET || '').trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').trim();
const OAUTH_REDIRECT = (process.env.ADMIN_OAUTH_REDIRECT || '').trim();
const ADMIN_ORIGIN = (process.env.ADMIN_API_ORIGIN || 'https://vemoni.info').trim().replace(/\/+$/, '');
const OWNER_ID = (process.env.ADMIN_OWNER_ID || '833442190427684914').trim();
const DEFAULT_ADMINS = ['604834976994689024'];
if (!process.env.ADMIN_OWNER_ID) console.warn('[SECURITY] ADMIN_OWNER_ID is not set — falling back to a hardcoded owner id. Set ADMIN_OWNER_ID to your own Discord id.');
if (process.env.OWNER_ID && process.env.ADMIN_OWNER_ID && process.env.OWNER_ID.trim() !== OWNER_ID) console.warn('[SECURITY] OWNER_ID (bot) and ADMIN_OWNER_ID (panel) differ — the bot and admin panel recognize different owners.');

const SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS) || 7 * 24 * 3600 * 1000; // 7 days (Discord re-auth is silent, so a shorter window limits stolen-cookie reuse)
const STATE_TTL_MS = 10 * 60 * 1000; // OAuth state good for 10 minutes
const SESSION_COOKIE = 'vemoni_admin';

const enabled = () => Boolean(ADMIN_SESSION_SECRET) && Boolean(DISCORD_CLIENT_ID) && Boolean(DISCORD_CLIENT_SECRET) && Boolean(OAUTH_REDIRECT);

// ---------- Roles ----------
function loadAdmins() {
    const raw = loadJSON('admins.json', null);
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.admins) ? raw.admins : null);
    if (!arr) return [...DEFAULT_ADMINS];
    return arr.filter((x) => /^\d{17,20}$/.test(String(x)));
}
function saveAdmins(list) {
    const clean = [...new Set((list || []).map((x) => String(x)).filter((x) => /^\d{17,20}$/.test(x) && x !== OWNER_ID))];
    saveJSON('admins.json', clean);
    return clean;
}
// 'owner' | 'admin' | null
function roleOf(userId) {
    const id = String(userId || '');
    if (id && id === OWNER_ID) return 'owner';
    if (loadAdmins().includes(id)) return 'admin';
    return null;
}

// ---------- Discord OAuth2 ----------
function oauthAuthorizeUrl(state) {
    // No `prompt` param: Discord silently redirects users who already granted
    // the app, and shows the one-tap consent screen to first-timers. Using
    // prompt=none would ERROR for anyone who never authorized the app before
    // (i.e. every new buyer) — locking them out of the order panel.
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT,
        response_type: 'code',
        scope: 'identify',
        state
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function discordRequest({ method, path, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const data = body || '';
        const req = https.request({
            host: 'discord.com', path: `/api${path}`, method,
            headers: { 'Content-Length': Buffer.byteLength(data), ...headers }
        }, (res) => {
            let buf = '';
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
                try {
                    const j = buf ? JSON.parse(buf) : {};
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
                    else reject(new Error(j.error_description || j.message || `discord ${res.statusCode}`));
                } catch (e) { reject(new Error('bad discord response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(12000, () => req.destroy(new Error('timeout')));
        if (data) req.write(data);
        req.end();
    });
}

// Exchange the OAuth code for the user's Discord id.
async function resolveOauthUser(code) {
    const form = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: OAUTH_REDIRECT
    }).toString();
    const token = await discordRequest({
        method: 'POST', path: '/oauth2/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form
    });
    const access = token.access_token;
    if (!access) throw new Error('no access_token');
    const me = await discordRequest({
        method: 'GET', path: '/users/@me',
        headers: { Authorization: `Bearer ${access}` }
    });
    if (!me.id) throw new Error('no user id');
    return me.id;
}

function adminOrigin() { return ADMIN_ORIGIN; }

// ---------- Signed state (CSRF for the OAuth round-trip) ----------
function sign(payload) {
    return crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex');
}
// State carries the login kind ('admin' | 'buyer') so one OAuth redirect
// serves both panels.
function issueState(kind = 'admin') {
    const payload = `${Date.now()}.${kind}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${sign(payload)}`;
}
// Returns the kind string on success, null otherwise (falsy → treated as
// invalid by existing boolean callers).
function verifyState(state) {
    if (!state) return null;
    const s = String(state);
    const i = s.lastIndexOf('.');
    if (i <= 0) return null;
    const payload = s.slice(0, i), mac = s.slice(i + 1);
    const expected = sign(payload);
    if (expected.length !== mac.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    const parts = payload.split('.');
    const ts = Number(parts[0]);
    if (!Number.isFinite(ts) || Date.now() - ts >= STATE_TTL_MS) return null;
    return parts[1] || 'admin';
}

// ---------- Session cookies (role-aware) ----------
// Payload: `<expires>.<userId>.<role>.<nonce>` signed with the session secret.
function issueSession(userId, role) {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(8).toString('hex');
    const payload = `${expires}.${userId}.${role}.${nonce}`;
    return `${payload}.${sign(payload)}`;
}

// Returns { userId, role } on a valid, unexpired token, else null.
function verifySession(token) {
    if (!enabled() || !token) return null;
    const s = String(token);
    const lastDot = s.lastIndexOf('.');
    if (lastDot <= 0) return null;
    const payload = s.slice(0, lastDot);
    const mac = s.slice(lastDot + 1);
    if (!payload || !mac) return null;
    const expected = sign(payload);
    if (expected.length !== mac.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    const [expiresStr, userId, roleInToken] = payload.split('.');
    const expires = Number(expiresStr);
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    // Re-resolve the role from current config so a demoted admin loses access
    // immediately, without waiting for the session to expire.
    const role = roleOf(userId);
    if (!role) return null;
    return { userId, role };
}

function readCookie(cookieHeader, name) {
    if (!cookieHeader) return '';
    for (const chunk of String(cookieHeader).split(';')) {
        const [k, ...v] = chunk.trim().split('=');
        if (k === name) {
            try { return decodeURIComponent(v.join('=')); } catch { return ''; }
        }
    }
    return '';
}
function readSessionCookie(cookieHeader) { return readCookie(cookieHeader, SESSION_COOKIE); }

function cookieHeaderFor(name, token, { clear = false } = {}) {
    const parts = [
        `${name}=${clear ? '' : encodeURIComponent(token)}`,
        'Path=/', 'HttpOnly', 'Secure', 'SameSite=None'
    ];
    if (clear) parts.push('Max-Age=0');
    else parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return parts.join('; ');
}
function sessionCookieHeader(token, opts) { return cookieHeaderFor(SESSION_COOKIE, token, opts); }

// ---------- Buyer sessions (any Discord user; no role required) ----------
const BUYER_COOKIE = 'vemoni_buyer';
function issueBuyerSession(userId) {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(8).toString('hex');
    const payload = `${expires}.${userId}.${nonce}`;
    return `${payload}.${sign(payload)}`;
}
function verifyBuyerSession(token) {
    if (!enabled() || !token) return null;
    const s = String(token);
    const lastDot = s.lastIndexOf('.');
    if (lastDot <= 0) return null;
    const payload = s.slice(0, lastDot), mac = s.slice(lastDot + 1);
    const expected = sign(payload);
    if (expected.length !== mac.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    const [expiresStr, userId] = payload.split('.');
    const expires = Number(expiresStr);
    if (!Number.isFinite(expires) || expires <= Date.now() || !/^\d{17,20}$/.test(userId || '')) return null;
    return { userId };
}
function readBuyerCookie(cookieHeader) { return readCookie(cookieHeader, BUYER_COOKIE); }
function buyerCookieHeader(token, opts) { return cookieHeaderFor(BUYER_COOKIE, token, opts); }

module.exports = {
    SESSION_COOKIE, BUYER_COOKIE, SESSION_TTL_MS, OWNER_ID,
    enabled, adminOrigin,
    oauthAuthorizeUrl, resolveOauthUser, issueState, verifyState,
    issueSession, verifySession, readSessionCookie, sessionCookieHeader,
    issueBuyerSession, verifyBuyerSession, readBuyerCookie, buyerCookieHeader,
    roleOf, loadAdmins, saveAdmins
};

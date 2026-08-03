// Residential proxy + a realistic client fingerprint for the RESERVE user
// account(s). Automating a user account from a datacenter IP with bare REST
// headers is the fastest way to get it flagged/disabled. This routes ALL reserve
// traffic — the gateway WebSocket AND the REST reads — through a residential proxy,
// and makes every request look like the real Discord web client (X-Super-Properties,
// User-Agent, locale) CONSISTENTLY across the gateway identify and the REST calls.
//
// Env:
//   RESERVE_PROXY  — a STICKY residential proxy for the reserve account(s)
//                    (http://user:pass@host:port). A user account should look like
//                    it lives on ONE stable residential IP, so prefer a sticky
//                    session — NOT the rotating invite proxy. Falls back to
//                    DISCORD_PROXY (residential, but may rotate) then to direct.
//   DISCORD_CLIENT_BUILD  — the current Discord web build number (copy it from the
//                    web client's X-Super-Properties). Keep it reasonably fresh; a
//                    stale/fixed build number slowly becomes a fingerprint.
//   DISCORD_CLIENT_LOCALE — default 'en-US'.
const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');

// A user account must appear to live on ONE stable residential IP. IPRoyal's base
// endpoint (geo.iproyal.com) ROTATES the exit IP on every new connection unless a
// sticky SESSION is requested inside the username — so a base-cred proxy makes the
// user token authenticate from a fresh IP on each REST call (and again on the
// gateway), which trips Discord's account-takeover protection: forced logout + a
// rotated token. That is the "юзер-бота выкидывает и сбрасывает токен" symptom.
//
// So we pin a sticky session automatically for IPRoyal when none is present, and —
// crucially with MULTIPLE reserve accounts — a DISTINCT session PER TOKEN, so each
// account keeps its own residential IP (two accounts sharing one IP is itself a
// flag) while one account stays on a single IP across REST + gateway. The invite
// proxy (proxy.js, DISCORD_PROXY) is a SEPARATE module and stays rotating on
// purpose — this only touches reserve.
//   RESERVE_PROXY_STICKY=off      → disable (revert to rotating) with no redeploy
//   RESERVE_PROXY_STICKY=1h       → custom IP lifetime (default 30m)
// Putting your own `_session-…` in the proxy username also bypasses this.
function proxyBase() { return (process.env.RESERVE_PROXY || process.env.DISCORD_PROXY || '').trim(); }

// Short, stable, non-reversible session id per token (never echoes the secret).
function sessionIdFor(token) {
    if (!token) return 'vmnreserve';
    return 'v' + crypto.createHash('sha1').update(String(token)).digest('hex').slice(0, 10);
}

// The proxy URL for a given token: the base with a per-account IPRoyal sticky
// session pinned, unless disabled / already set / non-IPRoyal / unset.
function proxyUrlFor(token) {
    const base = proxyBase();
    if (!base) return '';
    const cfg = (process.env.RESERVE_PROXY_STICKY || '').trim();
    if (/^(0|off|false|no)$/i.test(cfg)) return base;
    let u; try { u = new URL(base); } catch { return base; }
    if (!/(^|\.)iproyal\.com$/i.test(u.hostname)) return base;   // only IPRoyal uses this scheme
    if (/session-/i.test(u.username)) return base;               // operator already pinned one
    const lifetime = /^\d+[smhd]$/i.test(cfg) ? cfg : '30m';
    u.username = `${u.username}_session-${sessionIdFor(token)}_lifetime-${lifetime}`;
    let out = u.toString();
    if (out.endsWith('/') && !base.endsWith('/')) out = out.slice(0, -1); // keep the base's exact format
    return out;
}

// ---- realistic client fingerprint (shared by the gateway identify + REST) ----
const BUILD = Number(process.env.DISCORD_CLIENT_BUILD) || 355631;
const LOCALE = (process.env.DISCORD_CLIENT_LOCALE || 'en-US').trim();
const OS = 'Windows', BROWSER = 'Chrome', OS_VERSION = '10', BROWSER_VERSION = '131.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function clientProps() {
    return {
        os: OS, browser: BROWSER, device: '', system_locale: LOCALE,
        browser_user_agent: UA, browser_version: BROWSER_VERSION, os_version: OS_VERSION,
        referrer: '', referring_domain: '', referrer_current: '', referring_domain_current: '',
        release_channel: 'stable', client_build_number: BUILD, client_event_source: null,
    };
}
function identifyProperties() { return clientProps(); }
function superProps() { return Buffer.from(JSON.stringify(clientProps())).toString('base64'); }
function restHeaders(token) {
    const h = {
        'User-Agent': UA,
        'X-Super-Properties': superProps(),
        'X-Discord-Locale': LOCALE,
        'X-Debug-Options': 'bugReporterEnabled',
        'Accept-Language': LOCALE + ',en;q=0.9',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/channels/@me',
        'Content-Type': 'application/json',
    };
    if (token) h.Authorization = token;
    return h;
}

// ---- REST through the residential proxy (undici), one pooled dispatcher per
// resolved proxy URL (i.e. per account, so each token keeps its own IP). ----
const { ProxyAgent } = require('undici');
const _dispatchers = new Map();   // proxy URL -> ProxyAgent
let _loggedProxy = false;
function dispatcherFor(token) {
    const url = proxyUrlFor(token);
    if (!url) return null;
    let d = _dispatchers.get(url);
    if (d) return d;
    try {
        d = new ProxyAgent(url);
        _dispatchers.set(url, d);
        if (!_loggedProxy) { _loggedProxy = true; console.log('[RESERVE_PROXY] reserve traffic via proxy', url.replace(/\/\/[^@/]*@/, '//***@'), /session-/i.test(url) ? '(per-account sticky IP)' : '(ROTATING — set RESERVE_PROXY_STICKY or a sticky proxy)'); }
        return d;
    } catch (e) { console.error('[RESERVE_PROXY] dispatcher init failed:', e && e.message); return null; }
}
function usingProxy() { return Boolean(proxyBase()); }

// GET/POST discord.com/api/v10 + path with the client fingerprint. Returns
// { status, json }. When a proxy IS configured we NEVER fall back to a direct
// request — the user token must not touch the datacenter IP; if the per-account
// dispatcher can't be built the call returns status 0 and the caller degrades
// gracefully (fleet bots cover). No proxy configured → a direct request is fine.
async function restFetch(path, { token, method = 'GET', body, timeoutMs = 12000 } = {}) {
    const { fetch } = require('undici');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const opts = { method, signal: ac.signal, headers: restHeaders(token) };
    if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (proxyBase()) {
        const d = dispatcherFor(token);
        if (!d) { clearTimeout(t); return { status: 0, json: null }; } // proxy set but unbuildable → don't go direct
        opts.dispatcher = d;
    }
    try {
        const r = await fetch('https://discord.com/api/v10' + path, opts);
        let json = null; try { json = await r.json(); } catch { /* non-json body */ }
        return { status: r.status || 0, json };
    } catch { return { status: 0, json: null }; }
    finally { clearTimeout(t); }
}

// ---- Gateway WebSocket agent: CONNECT-tunnel the wss through the http proxy, no
// dependency. Returns an http.Agent whose createConnection tunnels + TLS-wraps to
// the target, or null when no proxy is configured (ws then connects directly).
// Takes the token so the gateway shares its account's sticky IP with that account's
// REST calls. ----
function wsAgent(token) {
    const url = proxyUrlFor(token);
    if (!url) return null;
    let pu; try { pu = new URL(url); } catch { return null; }
    const auth = pu.username ? ('Basic ' + Buffer.from(decodeURIComponent(pu.username) + ':' + decodeURIComponent(pu.password || '')).toString('base64')) : null;
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (opts, cb) => {
        const host = opts.host, port = opts.port || 443;
        const headers = { Host: `${host}:${port}` };
        if (auth) headers['Proxy-Authorization'] = auth;
        const creq = http.request({ host: pu.hostname, port: Number(pu.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers });
        creq.once('connect', (res, socket) => {
            if (res.statusCode !== 200) { try { socket.destroy(); } catch { /* ignore */ } cb(new Error('proxy CONNECT ' + res.statusCode)); return; }
            const tlsSock = tls.connect({ socket, servername: host }, () => cb(null, tlsSock));
            tlsSock.once('error', (e) => cb(e));
        });
        creq.once('error', (e) => cb(e));
        creq.end();
    };
    return agent;
}

// Boot-time confirmation of the reserve proxy posture (no token needed).
if (proxyBase()) {
    const stickyOff = /^(0|off|false|no)$/i.test((process.env.RESERVE_PROXY_STICKY || '').trim());
    let host = ''; try { host = new URL(proxyBase()).hostname; } catch { /* ignore */ }
    const iproyal = /(^|\.)iproyal\.com$/i.test(host);
    console.log('[RESERVE_PROXY] reserve proxy configured —',
        stickyOff ? 'sticky OFF (rotating IP — token may be flagged)'
        : iproyal ? 'per-account sticky IP ON'
        : 'non-IPRoyal host (sticky N/A — ensure it is a sticky residential proxy)');
}

module.exports = { usingProxy, restFetch, wsAgent, proxyUrlFor, sessionIdFor, identifyProperties, superProps, restHeaders, BUILD, UA, LOCALE };

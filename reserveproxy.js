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
const { URL } = require('url');

const rawUrl = (process.env.RESERVE_PROXY || process.env.DISCORD_PROXY || '').trim();

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

// ---- REST through the residential proxy (undici) ----
let dispatcher = null;
if (rawUrl) {
    try { dispatcher = new (require('undici').ProxyAgent)(rawUrl); console.log('[RESERVE_PROXY] reserve REST via proxy', rawUrl.replace(/\/\/[^@/]*@/, '//***@')); }
    catch (e) { console.error('[RESERVE_PROXY] REST proxy init failed — reserve REST DIRECT:', e && e.message); }
}
function usingProxy() { return Boolean(dispatcher); }

// GET/POST discord.com/api/v10 + path with the client fingerprint. Returns
// { status, json }. When a proxy IS configured we never silently fall back to a
// direct request — the user token must not touch the datacenter IP; a proxy
// failure returns status 0 and the caller degrades gracefully (fleet bots cover).
async function restFetch(path, { token, method = 'GET', body, timeoutMs = 12000 } = {}) {
    const { fetch } = require('undici');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const opts = { method, signal: ac.signal, headers: restHeaders(token) };
    if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (dispatcher) opts.dispatcher = dispatcher;
    try {
        const r = await fetch('https://discord.com/api/v10' + path, opts);
        let json = null; try { json = await r.json(); } catch { /* non-json body */ }
        return { status: r.status || 0, json };
    } catch { return { status: 0, json: null }; }
    finally { clearTimeout(t); }
}

// ---- Gateway WebSocket agent: CONNECT-tunnel the wss through the http proxy, no
// dependency. Returns an http.Agent whose createConnection tunnels + TLS-wraps to
// the target, or null when no proxy is configured (ws then connects directly). ----
function wsAgent() {
    if (!rawUrl) return null;
    let pu; try { pu = new URL(rawUrl); } catch { return null; }
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

module.exports = { usingProxy, restFetch, wsAgent, identifyProperties, superProps, restHeaders, BUILD, UA, LOCALE };

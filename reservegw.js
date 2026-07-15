// Reserve verifier over the Discord GATEWAY — a persistent WebSocket as the user
// account(s), a more reliable way to check membership than REST (which can 403 on
// user tokens). One connection per USER_TOKEN. Membership is answered via the
// "Request Guild Members" op (user_ids), and member leaves fire in real time.
//
// Enabled automatically when USER_TOKEN is set (disable with RESERVE_GATEWAY=0).
// If a connection can't be established, callers fall back to REST (usertoken.js) —
// so turning this on can only help or stay neutral.
//
// ToS note: a persistent user-account gateway connection is a stronger automation
// signal than occasional REST calls → higher ban risk. Operator's own risk.
const https = require('https');
const WebSocket = require('ws');
const config = require('./config.js');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=9&encoding=json';

function tokens() {
    return config.get('USER_TOKEN').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
}
function enabled() {
    if (!tokens().length) return false;
    const f = (config.get('RESERVE_GATEWAY') || '').trim();
    return !/^(0|false|no|off)$/i.test(f); // default ON when a token is present
}

const conns = new Map(); // token -> connection state
// guildId -> { id, name, icon } for the guilds the account(s) are in. These servers
// have no network bot, so this is the only place their name/icon is known.
const guildInfoMap = new Map();
let nonceCounter = 0;
let onLeaveCb = null;

// User-account gateways send guilds either flat ({ id, name, icon }) or, with the
// capabilities we identify with, nested ({ id, properties: { name, icon } }) —
// read both, or the name silently comes back empty.
function setInfo(g) {
    if (!g) return;
    const p = (g.properties && typeof g.properties === 'object') ? g.properties : g;
    const id = String(g.id || p.id || '');
    if (!id) return;
    const prev = guildInfoMap.get(id) || {};
    guildInfoMap.set(id, { id, name: p.name ?? prev.name ?? null, icon: p.icon ?? prev.icon ?? null });
}

// Belt-and-braces: REST always returns id+name+icon for the account's guilds, so
// fill in anything the gateway payload didn't carry. One request per connection.
function restGuilds(token) {
    return new Promise((resolve) => {
        const req = https.request({
            host: 'discord.com', path: '/api/v10/users/@me/guilds', method: 'GET',
            headers: { Authorization: token, 'Content-Type': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(12000, () => req.destroy());
        req.end();
    });
}
async function backfillNames(st) {
    const list = await restGuilds(st.token);
    if (!Array.isArray(list)) return;
    for (const g of list) setInfo(g);
    const named = [...st.guilds].filter((id) => guildInfoMap.get(id)?.name).length;
    console.log(`[RESERVE_GW] names resolved for ${named}/${st.guilds.size} guild(s)`);
}

function send(st, obj) {
    try { if (st.ws && st.ws.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}
function clearHb(st) { if (st.hbTimer) { clearInterval(st.hbTimer); st.hbTimer = null; } }

function identify(st) {
    send(st, {
        op: 2,
        d: {
            token: st.token,
            capabilities: 16381,
            properties: {
                os: 'Windows', browser: 'Chrome', device: '',
                system_locale: 'en-US',
                browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                browser_version: '120.0.0.0', os_version: '10',
                referrer: '', referring_domain: '', referrer_current: '', referring_domain_current: '',
                release_channel: 'stable', client_build_number: 250000, client_event_source: null
            },
            presence: { status: 'online', since: 0, activities: [], afk: false },
            compress: false,
            client_state: {
                guild_versions: {}, highest_last_message_id: '0', read_state_version: 0,
                user_guild_settings_version: -1, user_settings_version: -1,
                private_channels_version: '0', api_code_version: 0
            }
        }
    });
}

function connect(st) {
    if (st.closed) return;
    let ws;
    try { ws = new WebSocket(GATEWAY_URL); } catch { scheduleReconnect(st); return; }
    st.ws = ws;
    st.ready = false;
    ws.on('message', (data) => onMessage(st, data));
    ws.on('error', (e) => console.error('[RESERVE_GW] ws error:', e.message));
    ws.on('close', (code) => {
        clearHb(st); st.ready = false;
        if (code === 4004) { console.error('[RESERVE_GW] auth failed (bad USER_TOKEN) — connection disabled'); st.closed = true; return; }
        console.log(`[RESERVE_GW] closed (code ${code}) — reconnecting`);
        scheduleReconnect(st);
    });
}
function scheduleReconnect(st) {
    if (st.closed) return;
    const d = Math.min(st.reconnectDelay || 5000, 60000);
    setTimeout(() => connect(st), d);
    st.reconnectDelay = Math.min((st.reconnectDelay || 5000) * 2, 60000);
}

function onMessage(st, data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.s != null) st.seq = msg.s;
    switch (msg.op) {
        case 10: // Hello
            clearHb(st);
            st.hbTimer = setInterval(() => send(st, { op: 1, d: st.seq }), msg.d.heartbeat_interval);
            identify(st);
            break;
        case 1: send(st, { op: 1, d: st.seq }); break;   // heartbeat request
        case 11: break;                                   // heartbeat ack
        case 9: setTimeout(() => identify(st), 2500); break; // invalid session → re-identify
        case 7: try { st.ws.close(); } catch { /* ignore */ } break; // reconnect
        case 0: onDispatch(st, msg.t, msg.d); break;      // dispatch
    }
}

function onDispatch(st, t, d) {
    if (t === 'READY') {
        st.ready = true;
        st.reconnectDelay = 5000;
        st.guilds = new Set();
        for (const g of (d.guilds || [])) if (g && g.id) { st.guilds.add(String(g.id)); setInfo(g); }
        console.log(`[RESERVE_GW] ready — ${st.guilds.size} guild(s)`);
        backfillNames(st).catch((e) => console.error('[RESERVE_GW] name backfill failed:', e.message));
    } else if (t === 'GUILD_CREATE') {
        if (d && d.id) { st.guilds.add(String(d.id)); setInfo(d); }
    } else if (t === 'GUILD_UPDATE') {
        setInfo(d);
    } else if (t === 'GUILD_DELETE') {
        if (d && d.id && !d.unavailable) st.guilds.delete(String(d.id));
    } else if (t === 'GUILD_MEMBERS_CHUNK') {
        const p = st.pending.get(String(d.nonce));
        if (p) {
            st.pending.delete(String(d.nonce));
            clearTimeout(p.timer);
            const found = Array.isArray(d.members) && d.members.some((m) => m.user && String(m.user.id) === p.userId);
            const notFound = Array.isArray(d.not_found) && d.not_found.map(String).includes(p.userId);
            p.resolve(found ? true : (notFound ? false : null));
        }
    } else if (t === 'GUILD_MEMBER_REMOVE') {
        if (d && d.guild_id && d.user && onLeaveCb) {
            try { onLeaveCb(String(d.guild_id), String(d.user.id)); } catch { /* never break the socket */ }
        }
    }
}

// ---- public API ----
function drop(tk, st) {
    st.closed = true; clearHb(st);
    try { if (st.ws) st.ws.close(); } catch { /* ignore */ }
    conns.delete(tk);
}

// Reconcile live connections with the configured tokens: connect the new ones,
// drop the removed ones. Safe to call repeatedly — this is what makes a token
// change in the admin panel apply WITHOUT a restart.
function sync() {
    const want = new Set(enabled() ? tokens() : []);
    for (const [tk, st] of [...conns]) if (!want.has(tk)) drop(tk, st);
    let added = 0;
    for (const tk of want) {
        if (conns.has(tk)) continue;
        const st = { token: tk, ws: null, seq: null, hbTimer: null, ready: false, guilds: new Set(), pending: new Map(), reconnectDelay: 5000, closed: false };
        conns.set(tk, st);
        connect(st);
        added++;
    }
    if (added || !conns.size) console.log(`[RESERVE_GW] sync — ${conns.size} connection(s)${added ? ` (+${added} new)` : ''}`);
}
const start = sync;

function ready() { for (const st of conns.values()) if (st.ready) return true; return false; }

function coveredGuildIds() {
    const set = new Set();
    for (const st of conns.values()) if (st.ready) for (const g of st.guilds) set.add(g);
    return set;
}
function coversGuild(guildId) {
    const g = String(guildId);
    for (const st of conns.values()) if (st.ready && st.guilds.has(g)) return true;
    return false;
}

// true / false / null (couldn't tell). null → caller may fall back to REST.
function isMember(guildId, userId) {
    return new Promise((resolve) => {
        const g = String(guildId), u = String(userId);
        const st = [...conns.values()].find((c) => c.ready && c.guilds.has(g));
        if (!st) return resolve(null);
        const nonce = String(++nonceCounter);
        const timer = setTimeout(() => { st.pending.delete(nonce); resolve(null); }, 8000);
        st.pending.set(nonce, { userId: u, resolve, timer });
        send(st, { op: 8, d: { guild_id: g, user_ids: [u], limit: 0, presences: false, nonce } });
    });
}

function onLeave(cb) { onLeaveCb = cb; }

// { id, name, icon } for a reserve-covered guild (no bot is on it, so the fleet
// caches can't resolve its name/icon). Null when unknown.
function guildInfo(guildId) { return guildInfoMap.get(String(guildId)) || null; }

module.exports = { enabled, start, sync, ready, coveredGuildIds, coversGuild, isMember, onLeave, guildInfo };

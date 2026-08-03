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
const WebSocket = require('ws');
const config = require('./config.js');
const reserveproxy = require('./reserveproxy.js');

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=9&encoding=json';

function tokens() {
    return config.get('USER_TOKEN').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
}
function enabled() {
    if (!tokens().length) return false;
    const f = (config.get('RESERVE_GATEWAY') || '').trim();
    return !/^(0|false|no|off)$/i.test(f); // default ON when a token is present
}
// IDENTIFY capabilities bitfield. The real web client bumps this with new builds,
// so keep it env-tunable (paste the current value from your browser's identify to
// stay consistent with the build number — a mismatched pair is a fingerprint).
function capabilities() { const v = Number(config.get('RESERVE_CAPABILITIES')); return Number.isFinite(v) && v > 0 ? v : 16381; }

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
    // member_count rides on the gateway guild object; REST calls it
    // approximate_member_count (with_counts=true). Keep whichever we have.
    const n = Number(g.member_count ?? p.member_count ?? g.approximate_member_count ?? p.approximate_member_count);
    guildInfoMap.set(id, {
        id,
        name: p.name ?? prev.name ?? null,
        icon: p.icon ?? prev.icon ?? null,
        members: (Number.isFinite(n) && n > 0) ? n : (prev.members ?? null)
    });
}

// Belt-and-braces: REST always returns id+name+icon for the account's guilds, and
// with_counts adds the member count — fill in anything the gateway payload didn't
// carry. One request per connection.
async function restGuilds(token) {
    // Through the residential proxy with the client fingerprint (see reserveproxy.js).
    const { status, json } = await reserveproxy.restFetch('/users/@me/guilds?with_counts=true', { token });
    return (status === 200 && Array.isArray(json)) ? json : null;
}
async function backfillNames(st) {
    const list = await restGuilds(st.token);
    if (!Array.isArray(list)) return;
    for (const g of list) setInfo(g);
    const named = [...st.guilds].filter((id) => guildInfoMap.get(id)?.name).length;
    const counted = [...st.guilds].filter((id) => guildInfoMap.get(id)?.members).length;
    console.log(`[RESERVE_GW] names resolved for ${named}/${st.guilds.size} guild(s), member counts for ${counted}`);
}

function send(st, obj) {
    try { if (st.ws && st.ws.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}
function clearHb(st) {
    if (st.hbTimer) { clearInterval(st.hbTimer); st.hbTimer = null; }
    if (st.hbInit) { clearTimeout(st.hbInit); st.hbInit = null; }
}

// RESUME (op 6) an existing session instead of a fresh IDENTIFY. A real client
// always resumes after a transient drop; RESUME is NOT IDENTIFY-rate-limited, so
// this both looks human and avoids burning the shared IP's IDENTIFY budget (which
// was causing 4008s → the whole reserve getting disabled).
function resume(st) {
    send(st, { op: 6, d: { token: st.token, session_id: st.sessionId, seq: st.seq } });
}

function identify(st) {
    // A brand-new session — any stale session id no longer applies.
    st.sessionId = null; st.wantResume = false;
    send(st, {
        op: 2,
        d: {
            token: st.token,
            capabilities: capabilities(),
            // Shared with the REST fingerprint (reserveproxy.js) so the account looks
            // consistent across the gateway identify AND its REST calls.
            properties: reserveproxy.identifyProperties(),
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
    // Resume against the session's dedicated resume_gateway_url when we have a live
    // session to restore; otherwise the main gateway for a fresh login.
    const url = (st.wantResume && st.resumeUrl)
        ? (st.resumeUrl.replace(/\/+$/, '') + '/?v=9&encoding=json')
        : GATEWAY_URL;
    // Tunnel the gateway WebSocket through the residential proxy too — a user-account
    // gateway login from a datacenter IP is the strongest self-bot signal.
    try { const agent = reserveproxy.wsAgent(); ws = new WebSocket(url, agent ? { agent } : undefined); } catch { scheduleReconnect(st); return; }
    st.ws = ws;
    st.ready = false;
    ws.on('message', (data) => onMessage(st, data));
    ws.on('error', (e) => console.error('[RESERVE_GW] ws error:', e.message));
    ws.on('close', (code) => {
        clearHb(st); st.ready = false;
        if (code === 4004) { console.error('[RESERVE_GW] auth failed (bad USER_TOKEN) — connection disabled'); st.closed = true; return; }
        // Decide resume vs fresh identify for the NEXT connect. Most drops (1006,
        // 1000, 4000, and even 4008 rate-limits) keep the session resumable — RESUME
        // is cheaper and less bot-like than re-IDENTIFYing. Only these codes mean the
        // session is truly gone, so drop it and identify fresh next time.
        const NO_RESUME = new Set([4007, 4009, 4010, 4011, 4012, 4013, 4014]);
        if (NO_RESUME.has(code)) { st.sessionId = null; st.wantResume = false; }
        else if (st.sessionId) { st.wantResume = true; }
        // A session that stayed READY a while ended cleanly → reset the backoff. One
        // that dies within seconds of READY is flapping — keep escalating instead of
        // resetting (resetting on every brief READY made it reconnect every ~5s,
        // hammering the gateway and poisoning the shared egress IP's rate limit for
        // the WHOLE fleet — all bots then 4008'd too and none stayed ready).
        if (st.readyAt && Date.now() - st.readyAt > 60000) { st.reconnectDelay = 5000; st.rl4008 = 0; }
        // Gateway rate-limit (4008): back off hard, and give up after a few in a row —
        // Discord is persistently rejecting this connection, so stop trying rather than
        // keep burning the shared IP's gateway budget.
        if (code === 4008) {
            st.rl4008 = (st.rl4008 || 0) + 1;
            st.reconnectDelay = Math.max(st.reconnectDelay || 0, 60000);
            if (st.rl4008 >= 3) { console.error(`[RESERVE_GW] persistent gateway rate-limit (4008 ×${st.rl4008}) — disabling reserve to protect the fleet`); st.closed = true; return; }
        }
        console.log(`[RESERVE_GW] closed (code ${code}) — reconnecting in ~${Math.round(Math.min(st.reconnectDelay || 5000, 300000) / 1000)}s`);
        scheduleReconnect(st);
    });
}
function scheduleReconnect(st) {
    if (st.closed) return;
    const d = Math.min(st.reconnectDelay || 5000, 300000);
    setTimeout(() => connect(st), d);
    st.reconnectDelay = Math.min((st.reconnectDelay || 5000) * 2, 300000);
}

function onMessage(st, data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.s != null) st.seq = msg.s;
    switch (msg.op) {
        case 10: { // Hello — heartbeat (jittered first beat), then RESUME or IDENTIFY
            clearHb(st);
            const interval = msg.d.heartbeat_interval;
            // The gateway spec asks for a random jitter on the FIRST heartbeat; a
            // perfectly periodic beat from t=0 is a small but real bot tell.
            st.hbInit = setTimeout(() => {
                send(st, { op: 1, d: st.seq });
                st.hbTimer = setInterval(() => send(st, { op: 1, d: st.seq }), interval);
            }, Math.floor(interval * Math.random()));
            if (st.wantResume && st.sessionId && st.seq != null) resume(st); else identify(st);
            break;
        }
        case 1: send(st, { op: 1, d: st.seq }); break;   // heartbeat request
        case 11: break;                                   // heartbeat ack
        case 9: // Invalid Session — d:true = resumable, d:false = must re-identify fresh
            if (msg.d === true && st.sessionId && st.seq != null) {
                st.wantResume = true;
                setTimeout(() => resume(st), 1500 + Math.floor(Math.random() * 2500));
            } else {
                setTimeout(() => identify(st), 1500 + Math.floor(Math.random() * 2500));
            }
            break;
        case 7: try { st.ws.close(); } catch { /* ignore */ } break; // reconnect (session kept → resume)
        case 0: onDispatch(st, msg.t, msg.d); break;      // dispatch
    }
}

function onDispatch(st, t, d) {
    if (t === 'READY') {
        st.ready = true;
        st.readyAt = Date.now();   // backoff is reset only if THIS session proves stable (see the close handler)
        // Capture the session so future drops RESUME instead of re-IDENTIFYing.
        st.sessionId = d.session_id || null;
        if (d.resume_gateway_url) st.resumeUrl = d.resume_gateway_url;
        st.wantResume = Boolean(st.sessionId);
        st.guilds = new Set();
        for (const g of (d.guilds || [])) if (g && g.id) { st.guilds.add(String(g.id)); setInfo(g); }
        console.log(`[RESERVE_GW] ready — ${st.guilds.size} guild(s)`);
        backfillNames(st).catch((e) => console.error('[RESERVE_GW] name backfill failed:', e.message));
    } else if (t === 'RESUMED') {
        // Session restored on a reconnect — missed events were just replayed, so the
        // guild set is already current. No fresh IDENTIFY was spent.
        st.ready = true;
        st.readyAt = Date.now();
        st.wantResume = Boolean(st.sessionId);
        console.log('[RESERVE_GW] resumed session');
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
        const st = { token: tk, ws: null, seq: null, sessionId: null, resumeUrl: null, wantResume: false, hbTimer: null, hbInit: null, ready: false, guilds: new Set(), pending: new Map(), reconnectDelay: 5000, closed: false };
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

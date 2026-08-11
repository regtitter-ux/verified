// DMALL Broadcast-Operator client — the SERVER-SIDE half of the DMALL micro-service.
//
// We are an OPERATOR/client of an external broadcast service (discord-sensor.com). It
// executes the actual Discord DM sending with ITS bot pool; we drive it over HTTP with a
// secret operator key. That key (bop_…) is a server-to-server credential: it lives ONLY
// in env (DMALL_OP_KEY) and is NEVER sent to the browser — the buyer cabinet talks to our
// /order/dmall/op/* proxy, which injects the key here. (The doc is explicit: don't proxy
// the key into a client's browser.)
//
// This module is a thin, dependency-free HTTP client (global fetch) with a timeout and
// small typed wrappers per endpoint. All access control / wallet charging is done by the
// route layer in api.js — this file just talks to the operator.
const OP_BASE = (process.env.DMALL_OP_BASE || 'https://discord-sensor.com/api/admin/broadcasts').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.DMALL_OP_TIMEOUT_MS) || 25000;

function key() { return (process.env.DMALL_OP_KEY || '').trim(); }
function enabled() { return Boolean(key()); }

function buildQuery(query) {
    if (!query || typeof query !== 'object') return '';
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
        if (v == null || v === '') continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
}

// Low-level call. subpath is relative to OP_BASE (leading slash optional). Returns
// { ok, status, body } — body is the parsed JSON (or { error } on transport failure).
// Never throws; the caller inspects status/body.
async function call(method, subpath, { query, body, idempotencyKey } = {}) {
    if (!enabled()) return { ok: false, status: 503, body: { error: 'dmall-operator-not-configured', code: 'not_configured' } };
    const url = OP_BASE + (subpath.startsWith('/') ? subpath : `/${subpath}`) + buildQuery(query);
    const headers = { Authorization: `Bearer ${key()}`, Accept: 'application/json', 'User-Agent': 'Vemoni-DMALL/1.0 (+https://vemoni.info)' };
    // Optional shared secret so the operator can add a Cloudflare "skip challenge" rule
    // matching this header (IP-independent — Railway egress can rotate). Set DMALL_OP_BYPASS
    // on both sides. Header name is fixed: X-Vemoni-Op.
    const bypass = (process.env.DMALL_OP_BYPASS || '').trim();
    if (bypass) headers['X-Vemoni-Op'] = bypass;
    const opts = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 128);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    opts.signal = ctrl.signal;
    try {
        const res = await fetch(url, opts);
        let parsed = null;
        const text = await res.text();
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        return { ok: res.ok, status: res.status, body: parsed };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError');
        return { ok: false, status: aborted ? 504 : 502, body: { error: aborted ? 'operator-timeout' : 'operator-unreachable', detail: e && e.message } };
    } finally {
        clearTimeout(timer);
    }
}

// ---- Typed wrappers (one per documented endpoint) ----
const ping = () => call('GET', '/ping');
const me = () => call('GET', '/me');

const servers = (query) => call('GET', '/servers', { query });
const serverPreview = (guildId, targeting) => call('GET', `/servers/${guildId}/preview`, { query: targeting ? { targeting } : undefined });
const serverRoles = (guildId) => call('GET', `/servers/${guildId}/roles`);

const templatesList = () => call('GET', '/templates');
const templateCreate = (payload) => call('POST', '/templates', { body: payload });
const templatePatch = (id, payload) => call('PATCH', `/templates/${id}`, { body: payload });
const templatePreview = (id, body) => call('POST', `/templates/${id}/preview`, { body });

const media = (data, contentType) => call('POST', '/media', { body: { data, content_type: contentType } });
const avatar = (data, contentType) => call('POST', '/avatars', { body: { data, content_type: contentType } });

const resolveLink = (destinationLink) => call('POST', '/destination-link/resolve', { body: { destination_link: destinationLink } });
const estimate = (body) => call('POST', '/estimate', { body });

const runCreate = (body, idempotencyKey) => call('POST', '/runs', { body, idempotencyKey });
const runGet = (id) => call('GET', `/runs/${id}`);
const runList = (query) => call('GET', '/runs', { query });
const runStop = (id) => call('POST', `/runs/${id}/stop`);
const runRetry = (id) => call('POST', `/runs/${id}/retry`);
const runEvents = (id) => call('GET', `/runs/${id}/events`);
const runFailures = (id) => call('GET', `/runs/${id}/failures`);
const runDmLog = (id) => call('GET', `/runs/${id}/dm-log`);

const botsPool = (guildId) => call('GET', `/servers/${guildId}/bots-pool`);
const joinBots = (guildId, count) => call('POST', `/servers/${guildId}/join-bots`, { body: { count } });
const joinJob = (id) => call('GET', `/join-bots/jobs/${id}`);
const joinJobCancel = (id) => call('POST', `/join-bots/jobs/${id}/cancel`);
const joinJobs = (guildId) => call('GET', '/join-bots/jobs', { query: { guild_id: guildId } });

const accounts = () => call('GET', '/accounts');
const analytics = (query) => call('GET', '/analytics', { query });

module.exports = {
    enabled, call, OP_BASE,
    ping, me, servers, serverPreview, serverRoles,
    templatesList, templateCreate, templatePatch, templatePreview,
    media, avatar, resolveLink, estimate,
    runCreate, runGet, runList, runStop, runRetry, runEvents, runFailures, runDmLog,
    botsPool, joinBots, joinJob, joinJobCancel, joinJobs, accounts, analytics,
};

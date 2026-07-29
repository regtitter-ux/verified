// DMALL broadcast jobs. Clients configure + PAY for a mass-DM broadcast on our
// site; an EXTERNAL service pulls the paid jobs through the /dmall/v1 API, runs
// the actual Discord sending, and reports progress/completion back. This module
// is the job store + the pure helpers shared by the buyer purchase endpoint and
// the external API. Storage is a flat JSON file, written only through
// database.mutate (deep-copy atomic — the single-writer money invariant).
const crypto = require('crypto');
const database = require('./database.js');
const { loadJSON } = database;

const FILE = 'dmalljobs.json';
const KEYFILE = 'dmallkey.json';   // the external service's bearer key, generatable from the panel
const PRICE_PER_1000 = Number(process.env.DMALL_PRICE_PER_1000) || 1;   // USD per 1000 messages

const STATUSES = ['paid', 'claimed', 'running', 'done', 'failed', 'cancelled'];

function load() { const r = loadJSON(FILE, []); return Array.isArray(r) ? r : []; }
function priceFor(count) { const n = Math.max(0, Math.floor(Number(count) || 0)); return Math.round((n / 1000) * PRICE_PER_1000 * 100) / 100; }
function newId() { return 'dm_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

// The active key is the one generated in the panel (stored) if present, else the
// DMALL_API_KEY env fallback — so an existing env deployment keeps working, but the
// owner can (re)generate a key at runtime with no redeploy.
function currentKey() {
    const s = loadJSON(KEYFILE, {});
    const stored = (s && typeof s === 'object' && typeof s.key === 'string') ? s.key.trim() : '';
    return stored || (process.env.DMALL_API_KEY || '').trim();
}
function apiEnabled() { return Boolean(currentKey()); }
function checkKey(key) { const k = currentKey(); return Boolean(k) && String(key || '') === k; }
// Generate + persist a fresh key (invalidates the old one immediately).
function generateKey() {
    const key = 'dmall_' + crypto.randomBytes(24).toString('hex');
    database.mutate(KEYFILE, (o) => { o.key = key; o.updatedAt = Date.now(); return o; }, {});
    return key;
}

// Normalize the raw configurator payload into a STABLE external schema (what the
// service actually needs), while keeping the full original config under `raw`.
function normalize(cfg) {
    const f = (cfg && cfg.fields && typeof cfg.fields === 'object') ? cfg.fields : {};
    const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const ids = (v) => [...new Set(String(v || '').split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^\d{17,20}$/.test(x)))];
    const embeds = Array.isArray(cfg && cfg.embeds)
        ? cfg.embeds.filter((e) => e && Object.values(e).some((v) => String(v || '').trim()))
        : [];
    const guildId = String((cfg && cfg.target && cfg.target.guildId) || (cfg && cfg.guildId) || '');
    return {
        target: { guildId, guildName: (cfg && cfg.target && cfg.target.guildName) || null },
        message: {
            content: String(f.content || ''),
            username: f.setName ? String(f.username || '') : null,
            avatarUrl: f.setAvatar ? String(f.avatarUrl || '') : null,
            status: f.setStatus ? String(f.customStatus || '') : null,
            embeds,
        },
        filters: {
            excludeIds: ids(f.excludeIds),
            cooldown: { enabled: Boolean(f.coolG), days: num(f.coolGd, 0), hours: num(f.coolGh, 0) },
            priority: String(f.priority || 'normal'),
        },
        count: Math.max(0, Math.floor(num(f.count, 0))),
    };
}

// Create a PAID job (the caller has already charged the wallet). Returns the job.
function create(buyerId, cfg) {
    const n = normalize(cfg);
    const job = {
        id: newId(), buyerId: String(buyerId), createdAt: Date.now(),
        status: 'paid', price: priceFor(n.count), messageCount: n.count,
        target: n.target, message: n.message, filters: n.filters,
        raw: cfg,   // full original config, so the service can read a field we didn't normalize
        progress: { claimedBy: null, claimedAt: null, startedAt: null, finishedAt: null, sent: 0, failed: 0, note: '' },
    };
    database.mutate(FILE, (arr) => { arr.push(job); return arr; }, []);
    return job;
}

// External-facing shape (hide nothing sensitive — but drop internal churn if any).
function apiView(j) {
    if (!j) return null;
    return {
        id: j.id, status: j.status, createdAt: j.createdAt,
        buyerId: j.buyerId, price: j.price, messageCount: j.messageCount,
        target: j.target, message: j.message, filters: j.filters,
        progress: j.progress, raw: j.raw,
    };
}

function list({ status, limit = 100 } = {}) {
    let arr = load();
    if (status) arr = arr.filter((j) => j && j.status === status);
    return arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(0, Math.min(500, Math.max(1, limit))).map(apiView);
}
function get(id) { return apiView(load().find((j) => j && j.id === String(id)) || null); }
function forBuyer(buyerId, limit = 50) {
    return load().filter((j) => j && j.buyerId === String(buyerId)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit).map(apiView);
}

// Atomically patch one job via a mutator; returns the updated apiView or null if
// the job is missing / the mutator vetoes (returns false).
function patch(id, fn) {
    let out = null;
    database.mutate(FILE, (arr) => {
        const j = arr.find((x) => x && x.id === String(id));
        if (!j) { out = null; return false; }
        const ok = fn(j);
        if (ok === false) { out = null; return false; }
        out = apiView(j);
        return arr;
    }, []);
    return out;
}

// Worker claims a paid job (so two workers don't double-send). Only 'paid' → 'claimed'.
function claim(id, worker) {
    return patch(id, (j) => {
        if (j.status !== 'paid') return false;
        j.status = 'claimed';
        j.progress.claimedBy = String(worker || 'worker');
        j.progress.claimedAt = Date.now();
        return true;
    });
}
// Progress update while running (sent/failed counters + free-text note).
function progress(id, { sent, failed, note, running } = {}) {
    return patch(id, (j) => {
        if (j.status === 'done' || j.status === 'cancelled') return false;
        if (running || j.status === 'claimed') { j.status = 'running'; if (!j.progress.startedAt) j.progress.startedAt = Date.now(); }
        if (Number.isFinite(Number(sent))) j.progress.sent = Math.max(0, Math.floor(Number(sent)));
        if (Number.isFinite(Number(failed))) j.progress.failed = Math.max(0, Math.floor(Number(failed)));
        if (note != null) j.progress.note = String(note).slice(0, 500);
        return true;
    });
}
// Terminal completion. status must be 'done' or 'failed'.
function complete(id, { status, sent, failed, note } = {}) {
    const st = (status === 'failed') ? 'failed' : 'done';
    return patch(id, (j) => {
        if (j.status === 'done' || j.status === 'cancelled') return false;
        j.status = st;
        j.progress.finishedAt = Date.now();
        if (Number.isFinite(Number(sent))) j.progress.sent = Math.max(0, Math.floor(Number(sent)));
        if (Number.isFinite(Number(failed))) j.progress.failed = Math.max(0, Math.floor(Number(failed)));
        if (note != null) j.progress.note = String(note).slice(0, 500);
        return true;
    });
}

module.exports = {
    FILE, PRICE_PER_1000, STATUSES, apiEnabled, checkKey, currentKey, generateKey,
    priceFor, normalize, create, apiView, list, get, forBuyer, claim, progress, complete,
};

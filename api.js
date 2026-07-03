// Lightweight HTTP REST API so partners can drive the same /verify + /bal
// functionality from their own bot. Zero external deps (Node's built-in http).
//
// Auth: per-partner API key (Authorization: Bearer <key>  OR  X-API-Key: <key>).
// A key maps to a Discord user id; everything credits/reads that user's balance
// in the same central system (unified payouts). Manage keys with `!apikey` (owner).
const http = require('http');
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');
const { maybeAutoWithdraw, summarizeBehavior, BEHAVIOR_ORDER } = require('./payouts.js');

const getBid = (s) => (Number.isFinite(Number(s?.bid)) ? Number(s.bid) : 1); // $ per 100 clicks
const money = (n) => +(Number(n) || 0).toFixed(2);
const blankUser = () => ({ advText: '', serverAds: {}, partners: [] });

// key -> userId (apikeys.json = { "<key>": { userId, name, createdAt } })
function resolveKey(key) {
    if (!key) return null;
    const rec = loadJSON('apikeys.json')[key];
    return rec ? rec.userId : null;
}

// Same crediting rule as /verify: partner's bid ($/100 clicks) paid in 10-click steps.
function creditClick(userId, dwellMs) {
    const settings = loadJSON('settings.json');
    if (!settings[userId]) settings[userId] = blankUser();
    const s = settings[userId];

    const perTen = getBid(s) / 10;
    s.verifiedClicks = (Number(s.verifiedClicks) || 0) + 1;
    if (s.verifiedClicks >= 10) {
        const groups = Math.floor(s.verifiedClicks / 10);
        s.balance = money((Number(s.balance) || 0) + groups * perTen);
        s.verifiedClicks -= groups * 10;
    }
    if (Number.isFinite(dwellMs)) {
        if (!Array.isArray(s.dwellSamples)) s.dwellSamples = [];
        s.dwellSamples.push(Math.max(0, Math.round(dwellMs)));
        if (s.dwellSamples.length > 5000) s.dwellSamples.splice(0, s.dwellSamples.length - 5000);
    }
    saveJSON('settings.json', settings);
    return s;
}

// Record a verification so it shows in /stat and /bal stats (roleId marks it countable).
function recordVerified(userId, guildId, memberId) {
    const verified = loadJSON('verified.json', []);
    const arr = Array.isArray(verified) ? verified : [];
    arr.push({
        id: /^\d{17,20}$/.test(memberId || '') ? memberId : 'api',
        creatorId: userId,
        guildId: /^\d{17,20}$/.test(guildId || '') ? guildId : 'api',
        roleId: 'api',
        timestamp: Date.now(),
        viaApi: true
    });
    saveJSON('verified.json', arr);
}

function userStats(userId) {
    const verified = loadJSON('verified.json', []);
    const mine = (Array.isArray(verified) ? verified : []).filter(u => u.creatorId === userId && u.roleId);
    const now = Date.now();
    const win = (list) => ({
        hour: list.filter(u => u.timestamp > now - 3600000).length,
        day: list.filter(u => u.timestamp > now - 86400000).length,
        week: list.filter(u => u.timestamp > now - 604800000).length,
        month: list.filter(u => u.timestamp > now - 2592000000).length,
        total: list.length
    });
    const grouped = {};
    for (const u of mine) (grouped[u.guildId] ||= []).push(u);
    const perGuild = Object.keys(grouped)
        .map(gid => ({ guildId: gid, ...win(grouped[gid]) }))
        .sort((a, b) => b.total - a.total);
    return { total: win(mine), perGuild };
}

// Completion-time distribution for one user (past payouts + current samples).
function userBehavior(userId) {
    const s = loadJSON('settings.json')[userId] || {};
    const buckets = {};
    BEHAVIOR_ORDER.forEach(k => (buckets[k] = 0));
    let total = 0;
    for (const w of (Array.isArray(s.withdrawals) ? s.withdrawals : [])) {
        const b = w.behavior;
        if (b && b.buckets) {
            for (const [k, v] of Object.entries(b.buckets)) {
                const key = buckets[k] !== undefined ? k : (k === '+10s' ? '+31s' : null);
                if (key) buckets[key] += Number(v) || 0;
            }
            total += Number(b.total) || 0;
        }
    }
    const cur = summarizeBehavior(s.dwellSamples);
    for (const k of BEHAVIOR_ORDER) buckets[k] += cur.buckets[k] || 0;
    total += cur.total;
    return { buckets, total };
}

const DOCS = {
    name: 'Verification API',
    auth: 'Send your API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    endpoints: {
        'POST /api/verify/click': 'Record one qualifying verified click (ad shown + verified). Body: { dwellMs?, guildId?, userId? }. Credits your balance at your bid.',
        'GET /api/balance': 'Your balance, payment details, bid ($/100 clicks) and pending clicks.',
        'GET /api/stats': 'Your verification stats (per server + time windows) and completion-time distribution.',
        'GET /api/requisites': 'Your payment details.',
        'PUT /api/requisites': 'Set payment details. Body: { requisites }.',
        'GET /api/withdrawals': 'Your withdrawal history and total withdrawn.',
        'POST /api/withdraw': 'Trigger payout check — a request is filed automatically once balance reaches $10.'
    }
};

function send(res, status, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        req.on('end', () => {
            if (!data) return resolve({});
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
        req.on('error', () => resolve(null));
    });
}

function getKey(req) {
    const auth = req.headers['authorization'] || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return (req.headers['x-api-key'] || '').trim();
}

function startApiServer(clients, config) {
    const port = Number(process.env.API_PORT || process.env.PORT || 8080);

    const server = http.createServer(async (req, res) => {
        try {
            const p = (new URL(req.url, 'http://x').pathname).replace(/\/+$/, '') || '/';

            // Public: docs + health
            if (req.method === 'GET' && (p === '/' || p === '/api')) return send(res, 200, DOCS);
            if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });

            if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

            // Auth
            const userId = resolveKey(getKey(req));
            if (!userId) return send(res, 401, { error: 'Invalid or missing API key' });

            if (p === '/api/balance' && req.method === 'GET') {
                const s = loadJSON('settings.json')[userId] || {};
                return send(res, 200, {
                    userId,
                    balance: money(s.balance),
                    requisites: (s.requisites || '').trim(),
                    bid: getBid(s),
                    pendingClicks: Number(s.verifiedClicks) || 0
                });
            }

            if (p === '/api/verify/click' && req.method === 'POST') {
                const body = await readBody(req);
                if (body === null) return send(res, 400, { error: 'Invalid JSON body' });
                const dwellMs = Number(body.dwellMs);
                creditClick(userId, Number.isFinite(dwellMs) ? dwellMs : NaN);
                recordVerified(userId, body.guildId, body.userId);
                await maybeAutoWithdraw(clients, userId).catch(() => null);
                const s = loadJSON('settings.json')[userId] || {};
                return send(res, 200, {
                    ok: true,
                    balance: money(s.balance),
                    pendingClicks: Number(s.verifiedClicks) || 0,
                    bid: getBid(s)
                });
            }

            if (p === '/api/requisites' && req.method === 'GET') {
                const s = loadJSON('settings.json')[userId] || {};
                return send(res, 200, { requisites: (s.requisites || '').trim() });
            }
            if (p === '/api/requisites' && req.method === 'PUT') {
                const body = await readBody(req);
                if (body === null || typeof body.requisites !== 'string') {
                    return send(res, 400, { error: 'Body must be { "requisites": "..." }' });
                }
                const settings = loadJSON('settings.json');
                if (!settings[userId]) settings[userId] = blankUser();
                settings[userId].requisites = body.requisites.trim().slice(0, 1000);
                saveJSON('settings.json', settings);
                return send(res, 200, { ok: true, requisites: settings[userId].requisites });
            }

            if (p === '/api/stats' && req.method === 'GET') {
                return send(res, 200, { verifications: userStats(userId), completionTime: userBehavior(userId) });
            }

            if (p === '/api/withdrawals' && req.method === 'GET') {
                const s = loadJSON('settings.json')[userId] || {};
                const list = Array.isArray(s.withdrawals) ? s.withdrawals : [];
                const withdrawals = list
                    .map(w => ({
                        id: w.id,
                        amount: money(w.amount),
                        status: w.status,
                        createdAt: w.createdAt || null,
                        completedAt: w.completedAt || null,
                        requisites: w.requisites || ''
                    }))
                    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                const totalWithdrawn = money(list.filter(w => w.status === 'completed').reduce((a, w) => a + (Number(w.amount) || 0), 0));
                return send(res, 200, { totalWithdrawn, withdrawals });
            }

            if (p === '/api/withdraw' && req.method === 'POST') {
                await maybeAutoWithdraw(clients, userId).catch(() => null);
                const s = loadJSON('settings.json')[userId] || {};
                return send(res, 200, {
                    ok: true,
                    balance: money(s.balance),
                    note: 'A payout request is filed automatically once your balance reaches $10.'
                });
            }

            return send(res, 404, { error: 'Unknown endpoint' });
        } catch (e) {
            console.error('[API ERROR]', e);
            return send(res, 500, { error: 'Internal error' });
        }
    });

    server.on('error', (e) => console.error('[API] server error:', e.message));
    server.listen(port, () => console.log(`[API] listening on :${port}`));
    return server;
}

// Generate + store a new API key for a user. Returns the raw key.
function createApiKey(userId, name) {
    const keys = loadJSON('apikeys.json');
    const key = crypto.randomBytes(24).toString('hex');
    keys[key] = { userId, name: name || '', createdAt: Date.now() };
    saveJSON('apikeys.json', keys);
    return key;
}

module.exports = { startApiServer, createApiKey };

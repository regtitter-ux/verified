// Lightweight HTTP REST API so partners can drive the same /verify + /bal
// functionality from their own bot. Zero external deps (Node's built-in http).
//
// Auth: per-partner API key (Authorization: Bearer <key>  OR  X-API-Key: <key>).
// A key maps to a Discord user id; everything credits/reads that user's balance
// in the same central system (unified payouts). Manage keys with `!apikey` (owner).
const http = require('http');
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');
const { maybeAutoWithdraw } = require('./payouts.js');
const adminAuth = require('./admin-auth.js');

// Admin panel served from a separate origin (the vemoni.info static site).
// Only exact-match origins get CORS + credentialed cookies allowed.
const ADMIN_ORIGIN = (process.env.ADMIN_API_ORIGIN || 'https://vemoni.info').trim();

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
function creditClick(userId) {
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


const DOCS = {
    name: 'Verification API',
    auth: 'Send your API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    endpoints: {
        'POST /api/verify/click': 'Record one qualifying verified click (ad shown + verified). Body: { guildId?, userId? }. Credits your balance at your bid.',
        'GET /api/balance': 'Your balance, payment details, bid ($/100 clicks) and pending clicks.',
        'GET /api/stats': 'Your verification stats (per server + time windows).',
        'GET /api/requisites': 'Your payment details.',
        'PUT /api/requisites': 'Set payment details. Body: { requisites }.',
        'GET /api/withdrawals': 'Your withdrawal history and total withdrawn.',
        'POST /api/withdraw': 'Trigger payout check — a request is filed automatically once balance reaches $10.'
    }
};

function send(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(body);
}

// CORS headers that let the vemoni.info admin page call these endpoints with
// credentials (session cookie). Non-whitelisted origins get an empty object,
// which means no CORS headers → the browser blocks the request.
function corsHeaders(req) {
    const origin = req.headers.origin || '';
    if (origin !== ADMIN_ORIGIN) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
}

// Look up a guild name across every fleet bot's cache. Any bot that shares
// the guild will resolve — falls back to null when nobody sees it.
function guildNameOf(clients, gid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const g = c.guilds?.cache?.get(String(gid));
        if (g) return g.name;
    }
    return null;
}

function verifStats(entries) {
    const now = Date.now();
    return {
        hour: entries.filter((u) => u.timestamp > now - 3600000).length,
        day: entries.filter((u) => u.timestamp > now - 86400000).length,
        week: entries.filter((u) => u.timestamp > now - 604800000).length,
        month: entries.filter((u) => u.timestamp > now - 2592000000).length,
        total: entries.length
    };
}

// Admin routing — TOTP login, session cookie, then CRUD over templates/ads
// and the global ads-off toggle. Every response includes CORS headers so the
// vemoni.info frontend can talk to us (empty when origin mismatches → browser
// blocks the call).
async function handleAdmin(req, res, path, clients, config) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!adminAuth.enabled()) return send(res, 503, { error: 'admin auth not configured' }, cors);

    if (path === '/admin/login' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !adminAuth.verifyTotp(body.code)) return send(res, 401, { error: 'Invalid code' }, cors);
        const token = adminAuth.issueSession();
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': adminAuth.sessionCookieHeader(token) });
    }
    if (path === '/admin/logout' && req.method === 'POST') {
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': adminAuth.sessionCookieHeader('', { clear: true }) });
    }
    if (path === '/admin/whoami' && req.method === 'GET') {
        const authed = adminAuth.verifySession(adminAuth.readSessionCookie(req.headers.cookie));
        return send(res, 200, { authed }, cors);
    }

    // Everything below requires a valid session cookie.
    if (!adminAuth.verifySession(adminAuth.readSessionCookie(req.headers.cookie))) {
        return send(res, 401, { error: 'unauthorized' }, cors);
    }

    if (path === '/admin/state' && req.method === 'GET') {
        const uid = config.ownerId;
        const settings = loadJSON('settings.json');
        const s = settings[uid] || {};
        const t = loadJSON('adtemplates.json', {});
        const cfg = loadJSON('siteconfig.json', {});

        const verified = loadJSON('verified.json', []);
        const entries = (Array.isArray(verified) ? verified : []).filter((u) => u.roleId);
        const grouped = {};
        for (const u of entries) (grouped[u.guildId] ||= []).push(u);
        const perGuild = Object.entries(grouped)
            .map(([gid, list]) => ({ gid, name: guildNameOf(clients, gid), ...verifStats(list) }));

        // A server with a per-server ad or per-server ads-off flag but no
        // verifications yet still needs a row in the "По серверам" table so
        // the admin can manage its ads/kran from there. Union the two.
        const knownGids = new Set(perGuild.map((g) => g.gid));
        const adGids = Object.keys(s.serverAds || {}).filter((g) => typeof s.serverAds[g] === 'string' && s.serverAds[g].trim());
        const offGids = Object.keys(cfg.serverAdsOff || {}).filter((g) => cfg.serverAdsOff[g]);
        for (const gid of [...adGids, ...offGids]) {
            if (!knownGids.has(gid)) {
                perGuild.push({ gid, name: guildNameOf(clients, gid), hour: 0, day: 0, week: 0, month: 0, total: 0 });
                knownGids.add(gid);
            }
        }
        perGuild.sort((a, b) => b.total - a.total);

        // Financial: sum of every user's POSITIVE balance = money still owed
        // to creators. Negative balances (from sponsor-leave clawbacks) don't
        // reduce the debt — they represent overpayments the user has to earn
        // back, not funds available to the platform.
        let outstanding = 0, withBalance = 0;
        for (const u of Object.keys(settings)) {
            const b = Number(settings[u]?.balance) || 0;
            if (b > 0) { outstanding += b; withBalance++; }
        }

        return send(res, 200, {
            adsOff: Boolean(cfg.adsOff),
            adsOffAt: cfg.adsOffAt || 0,
            serverAdsOff: (cfg.serverAdsOff && typeof cfg.serverAdsOff === 'object') ? cfg.serverAdsOff : {},
            templates: {
                default: typeof t.default === 'string' ? t.default : '',
                servers: Object.entries(t.servers || {})
                    .filter(([, v]) => typeof v === 'string' && v.trim())
                    .map(([gid, text]) => ({ gid, name: guildNameOf(clients, gid), text }))
            },
            ads: {
                default: s.advText || '',
                defaultAt: s.advTextAt || 0,
                servers: Object.entries(s.serverAds || {})
                    .filter(([, v]) => typeof v === 'string' && v.trim())
                    .map(([gid, text]) => ({
                        gid, name: guildNameOf(clients, gid), text,
                        updatedAt: s.serverAdsAt?.[gid] || 0
                    }))
            },
            stats: {
                all: verifStats(entries),
                perGuild,
                outstanding: money(outstanding),
                withBalance
            }
        }, cors);
    }

    if (path === '/admin/template' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : null;
        if (gid && !/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        const text = String(body?.text ?? '');
        const t = loadJSON('adtemplates.json', {});
        if (!t.servers || typeof t.servers !== 'object') t.servers = {};
        if (gid) t.servers[gid] = text; else t.default = text;
        saveJSON('adtemplates.json', t);
        return send(res, 200, { ok: true }, cors);
    }
    if (path === '/admin/template' && req.method === 'DELETE') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : null;
        const t = loadJSON('adtemplates.json', {});
        if (gid) { if (t.servers) delete t.servers[gid]; }
        else { t.default = ''; }
        saveJSON('adtemplates.json', t);
        return send(res, 200, { ok: true }, cors);
    }

    if (path === '/admin/ad' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : null;
        if (gid && !/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        // We store the RAW ad argument (link or literal); the template is
        // applied at render time (see getAd in index.js).
        const text = String(body?.text ?? '');
        const uid = config.ownerId;
        const settings = loadJSON('settings.json');
        if (!settings[uid]) settings[uid] = blankUser();
        const now = Date.now();
        if (gid) {
            settings[uid].serverAds[gid] = text;
            settings[uid].serverAdsAt ||= {};
            settings[uid].serverAdsAt[gid] = now;
        } else {
            settings[uid].advText = text;
            settings[uid].advTextAt = now;
        }
        saveJSON('settings.json', settings);
        return send(res, 200, { ok: true }, cors);
    }
    if (path === '/admin/ad' && req.method === 'DELETE') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : null;
        const uid = config.ownerId;
        const settings = loadJSON('settings.json');
        if (settings[uid]) {
            if (gid) {
                if (settings[uid].serverAds) delete settings[uid].serverAds[gid];
                if (settings[uid].serverAdsAt) delete settings[uid].serverAdsAt[gid];
            } else {
                settings[uid].advText = '';
                settings[uid].advTextAt = 0;
            }
            saveJSON('settings.json', settings);
        }
        return send(res, 200, { ok: true }, cors);
    }

    // Balances list — server-side filter/sort so the client renders straight.
    if (path === '/admin/balances' && req.method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const q = (url.searchParams.get('q') || '').trim();
        const has = url.searchParams.get('has') || 'all';
        const sort = url.searchParams.get('sort') || 'balance';
        const dir = url.searchParams.get('dir') === 'asc' ? 1 : -1;

        const settings = loadJSON('settings.json');
        const verified = loadJSON('verified.json', []);

        // One O(n) pass over verified.json — count per creator.
        const vCount = {};
        for (const u of Array.isArray(verified) ? verified : []) {
            if (u.roleId && u.creatorId) vCount[u.creatorId] = (vCount[u.creatorId] || 0) + 1;
        }

        let users = Object.keys(settings).map((uid) => {
            const s = settings[uid] || {};
            const withdrawals = Array.isArray(s.withdrawals) ? s.withdrawals : [];
            const withdrawnTotal = money(withdrawals
                .filter((w) => w.status === 'completed')
                .reduce((sum, w) => sum + (Number(w.amount) || 0), 0));
            return {
                userId: uid,
                balance: money(s.balance),
                requisites: (s.requisites || '').trim(),
                hasRequisites: Boolean((s.requisites || '').trim()),
                bid: getBid(s),
                joinBid: Number.isFinite(Number(s.joinBid)) ? Number(s.joinBid) : 5,
                refBonusAccrued: money(s.refBonusAccrued),
                autoPayout: Boolean(s.autoPayout),
                referrer: s.referrer || null,
                referralsCount: Array.isArray(s.referrals) ? s.referrals.length : 0,
                verifications: vCount[uid] || 0,
                withdrawnTotal,
                withdrawalsCount: withdrawals.length
            };
        });

        // Skeleton settings rows (created just to hold botId or a partner list
        // but with no financial activity) are noise; drop them.
        users = users.filter((u) =>
            u.balance !== 0 || u.verifications > 0 || u.withdrawnTotal > 0 ||
            u.withdrawalsCount > 0 || u.referralsCount > 0 || u.referrer
        );

        if (q) users = users.filter((u) => u.userId.includes(q));
        if (has === 'positive') users = users.filter((u) => u.balance > 0);
        else if (has === 'negative') users = users.filter((u) => u.balance < 0);
        else if (has === 'zero') users = users.filter((u) => u.balance === 0);

        const sortMap = {
            balance: (u) => u.balance,
            withdrawn: (u) => u.withdrawnTotal,
            verifications: (u) => u.verifications,
            referrals: (u) => u.referralsCount,
            bid: (u) => u.bid
        };
        const sortKey = sortMap[sort] ? sort : 'balance';
        users.sort((a, b) => (sortMap[sortKey](a) - sortMap[sortKey](b)) * dir);

        return send(res, 200, { users, total: users.length }, cors);
    }

    // Balance detail — everything the /bal Discord view shows, plus history.
    if (path.startsWith('/admin/balances/') && req.method === 'GET') {
        const userId = path.slice('/admin/balances/'.length);
        if (!/^\d{17,20}$/.test(userId)) return send(res, 400, { error: 'bad user id' }, cors);

        const settings = loadJSON('settings.json');
        const s = settings[userId];
        if (!s) return send(res, 404, { error: 'user not found' }, cors);

        const verified = loadJSON('verified.json', []);
        const mine = (Array.isArray(verified) ? verified : []).filter((u) => u.creatorId === userId && u.roleId);
        const grouped = {};
        for (const u of mine) (grouped[u.guildId] ||= []).push(u);
        const perGuild = Object.entries(grouped)
            .map(([gid, list]) => ({ gid, name: guildNameOf(clients, gid), ...verifStats(list) }))
            .sort((a, b) => b.total - a.total);

        const withdrawals = Array.isArray(s.withdrawals) ? s.withdrawals : [];
        const withdrawnTotal = money(withdrawals
            .filter((w) => w.status === 'completed')
            .reduce((sum, w) => sum + (Number(w.amount) || 0), 0));

        return send(res, 200, {
            userId,
            balance: money(s.balance),
            requisites: (s.requisites || '').trim(),
            bid: getBid(s),
            joinBid: Number.isFinite(Number(s.joinBid)) ? Number(s.joinBid) : 5,
            refBonusAccrued: money(s.refBonusAccrued),
            autoPayout: Boolean(s.autoPayout),
            referrer: s.referrer || null,
            referrals: Array.isArray(s.referrals) ? s.referrals : [],
            botId: s.botId || null,
            verifications: { all: verifStats(mine), perGuild },
            withdrawals: withdrawals
                .map((w) => ({
                    id: w.id,
                    amount: money(w.amount),
                    status: w.status,
                    method: w.method || null,
                    createdAt: w.createdAt || null,
                    completedAt: w.completedAt || null,
                    requisites: w.requisites || ''
                }))
                .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)),
            withdrawnTotal
        }, cors);
    }

    // Balance-settings CRUD — one route per field so the frontend can PUT
    // just what changed. Balance credits also poke maybeAutoWithdraw so
    // crossing the payout threshold triggers a check immediately (same
    // behavior as the /bal "Change the balance" button in Discord).
    if (path.startsWith('/admin/balances/') && req.method === 'PUT') {
        const rest = path.slice('/admin/balances/'.length);
        const [userId, field] = rest.split('/');
        if (!/^\d{17,20}$/.test(userId)) return send(res, 400, { error: 'bad user id' }, cors);

        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);

        const settings = loadJSON('settings.json');
        if (!settings[userId]) settings[userId] = blankUser();
        const s = settings[userId];

        if (field === 'balance') {
            const delta = Number(body.delta);
            if (!Number.isFinite(delta)) return send(res, 400, { error: 'delta must be a number' }, cors);
            s.balance = money((Number(s.balance) || 0) + delta);
            saveJSON('settings.json', settings);
            if (delta > 0) maybeAutoWithdraw(clients, userId).catch(() => null);
            return send(res, 200, { ok: true, balance: s.balance }, cors);
        }
        if (field === 'bid') {
            const bid = Number(body.bid);
            if (!Number.isFinite(bid) || bid < 0) return send(res, 400, { error: 'bad bid' }, cors);
            s.bid = +bid.toFixed(4);
            saveJSON('settings.json', settings);
            return send(res, 200, { ok: true, bid: s.bid }, cors);
        }
        if (field === 'joinbid') {
            const bid = Number(body.joinBid);
            if (!Number.isFinite(bid) || bid < 0) return send(res, 400, { error: 'bad joinBid' }, cors);
            s.joinBid = +bid.toFixed(4);
            saveJSON('settings.json', settings);
            return send(res, 200, { ok: true, joinBid: s.joinBid }, cors);
        }
        if (field === 'autopayout') {
            s.autoPayout = Boolean(body.autoPayout);
            saveJSON('settings.json', settings);
            return send(res, 200, { ok: true, autoPayout: s.autoPayout }, cors);
        }
        if (field === 'referrals') {
            const raw = Array.isArray(body.referrals) ? body.referrals : [];
            // Accept both an array or a flat blob of newline/space/comma-separated
            // IDs; keep only valid ones, unique, and not self.
            const tokens = raw.flatMap((x) => String(x || '').split(/[\s,]+/));
            const refs = [...new Set(tokens.map((x) => x.trim()).filter((x) => /^\d{17,20}$/.test(x) && x !== userId))];
            s.referrals = refs;
            saveJSON('settings.json', settings);
            return send(res, 200, { ok: true, referrals: refs }, cors);
        }
        if (field === 'requisites') {
            const req = String(body.requisites ?? '').trim().slice(0, 1000);
            s.requisites = req;
            saveJSON('settings.json', settings);
            return send(res, 200, { ok: true, requisites: req }, cors);
        }
        return send(res, 404, { error: 'unknown field' }, cors);
    }

    // Per-server ads-off — same semantic as the global switch, scoped to
    // one guild. Verification handler in index.js OR's the two together.
    if (path === '/admin/server-ads-off' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : '';
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        const off = Boolean(body?.off);
        const cfg = loadJSON('siteconfig.json', {});
        if (!cfg.serverAdsOff || typeof cfg.serverAdsOff !== 'object') cfg.serverAdsOff = {};
        if (off) cfg.serverAdsOff[gid] = true;
        else delete cfg.serverAdsOff[gid];
        cfg.serverAdsOffAt = Date.now();
        saveJSON('siteconfig.json', cfg);
        return send(res, 200, { ok: true, gid, off }, cors);
    }

    if (path === '/admin/ads-off' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const off = Boolean(body?.off);
        const cfg = loadJSON('siteconfig.json', {});
        cfg.adsOff = off;
        cfg.adsOffAt = Date.now();
        saveJSON('siteconfig.json', cfg);
        return send(res, 200, { ok: true, adsOff: off }, cors);
    }

    return send(res, 404, { error: 'unknown admin endpoint' }, cors);
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

            // Admin panel (TOTP-gated, CORS-scoped to ADMIN_ORIGIN)
            if (p.startsWith('/admin/') || p === '/admin') {
                return handleAdmin(req, res, p, clients, config);
            }

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
                creditClick(userId);
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
                return send(res, 200, { verifications: userStats(userId) });
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

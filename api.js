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
const { applyTemplate } = require('./adtemplate.js');
const { adKeyOf } = require('./adcreative.js');
const { resolveSponsorPresence, isMember, creditJoin } = require('./joincheck.js');
const { SALE_PRICE_PER_100, REVENUE_PER_JOIN, ACQUIRING_RATE, loadShares, dayNumberOf, payShares } = require('./shares.js');
const cryptopay = require('./cryptopay.js');

// Admin panel served from a separate origin (the vemoni.info static site).
// Only exact-match origins get CORS + credentialed cookies allowed.
const ADMIN_ORIGIN = (process.env.ADMIN_API_ORIGIN || 'https://vemoni.info').trim();

// Optional allowlist of sponsor guild IDs that /api/join-check will pay for.
// When set, a partner can only be credited for joins to these servers — a
// hard lock against crediting "joins" to a big server users are already in.
// When empty, any guild one of our bots is on is accepted (membership +
// dedup still apply).
const JOIN_CHECK_GUILDS = new Set((process.env.JOIN_CHECK_GUILDS || '').split(',').map((s) => s.trim()).filter(Boolean));

// The sponsor servers that are CURRENTLY being advertised: derived from the
// owner's live ads (global + per-server), excluding campaigns whose join
// limit is reached, when the global kran is closed, or where no network bot
// is on the sponsor server. This is the ONLY set /api/join-check will pay
// for — a partner can't point join-check at an arbitrary server.
async function activeSponsors(clients, ownerId) {
    const cfg = loadJSON('siteconfig.json', {});
    if (cfg.adsOff) return []; // global kran closed → nothing is being advertised
    const settings = loadJSON('settings.json');
    const s = settings[ownerId] || {};
    const limits = loadJSON('adlimits.json', {});
    const verified = loadJSON('verified.json', []);
    const arr = Array.isArray(verified) ? verified : [];

    const items = [];
    if ((s.advText || '').trim()) items.push({ gid: null, raw: s.advText });
    for (const [gid, raw] of Object.entries(s.serverAds || {})) if ((raw || '').trim()) items.push({ gid, raw });

    const seen = new Set();
    const out = [];
    for (const { gid, raw } of items) {
        // Skip a campaign that already hit its join limit (since last reset).
        const key = adKeyOf(applyTemplate(gid, raw));
        const rec = limits[key];
        if (rec && Number(rec.limit) > 0) {
            const since = Number(rec.resetAt) || 0;
            const cnt = arr.filter((u) => u.adKey === key && u.timestamp > since).length;
            if (cnt >= Number(rec.limit)) continue;
        }
        const sp = await resolveSponsorPresence(clients, raw).catch(() => null);
        if (sp && !seen.has(sp.guildId)) { seen.add(sp.guildId); out.push(sp); }
    }
    return out;
}

// Cache the Crypto Pay USDT app balance briefly — /admin/state is polled
// every few seconds and we don't want to hammer the Crypto Pay API.
let _cpBalCache = { at: 0, val: null };
async function cryptoUsdtBalance() {
    if (!cryptopay.enabled()) return null;
    const now = Date.now();
    if (now - _cpBalCache.at < 30000) return _cpBalCache.val;
    const val = await cryptopay.usdtAvailable().catch(() => null);
    _cpBalCache = { at: now, val };
    return val;
}

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
        'POST /api/join-check': 'Verify a user really joined a server WE are currently advertising, and if so credit the join. Body: { userId, guildId?, invite?, cardGuildId? } — guildId/invite are optional and only narrow to a specific active sponsor; the eligible servers are decided by our live ads, not by you. Returns 200 { joined:true } when the member is confirmed on an active sponsor (let them through); 403 { joined:false } when not a member or the server is not currently advertised; 422 when no join-check campaign is live; 503 to retry. Membership is checked against Discord directly and each member is only ever paid once per sponsor.',
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

// Same lookup for the guild's icon (CDN URL, 64px). Null when no bot shares
// the guild or it has no icon — the frontend falls back to a letter tile.
function guildIconOf(clients, gid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const g = c.guilds?.cache?.get(String(gid));
        if (g) return g.iconURL({ size: 64 }) || null;
    }
    return null;
}

// Resolve a user's display name across every bot's user cache. Null when no
// bot has seen the user — the frontend then falls back to the raw ID.
function userNameOf(clients, uid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const u = c.users?.cache?.get(String(uid));
        if (u) return u.globalName || u.username || u.tag || null;
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
        const gate = adminAuth.loginGate();
        if (gate.locked) {
            return send(res, 429, {
                error: 'Слишком много попыток, попробуй позже.',
                retryAfterMs: gate.retryAfterMs
            }, cors);
        }
        const body = await readBody(req);
        const ok = body && adminAuth.verifyTotp(body.code);
        if (!ok) {
            // Progressive delay slows brute force without hurting a legit
            // admin who mistypes once or twice. Sleep first, then respond.
            adminAuth.recordLoginFailure();
            if (gate.delayMs > 0) await new Promise((r) => setTimeout(r, gate.delayMs));
            return send(res, 401, { error: 'Invalid code' }, cors);
        }
        adminAuth.recordLoginSuccess();
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
        // Synthetic guildIds like 'api' (partner API calls without a real
        // guildId) are excluded from ALL admin statistics — the top cards,
        // the per-server table and the per-creative rollup alike.
        const entries = (Array.isArray(verified) ? verified : [])
            .filter((u) => u.roleId && /^\d{17,20}$/.test(u.guildId));
        const now = Date.now();

        // Reversed join-check verifications (user left the sponsor) are
        // deleted from verified.json but survive in joinlinks.json as
        // status 'left' with the original timestamp and card guild — that's
        // what turns net counts into gross ones, per guild and overall.
        const joinlinksRaw = loadJSON('joinlinks.json', []);
        const leftRecs = (Array.isArray(joinlinksRaw) ? joinlinksRaw : []).filter((r) => r && r.status === 'left');
        const leftWinOf = (list) => ({
            hour: list.filter((r) => r.ts > now - 3600000).length,
            day: list.filter((r) => r.ts > now - 86400000).length,
            week: list.filter((r) => r.ts > now - 604800000).length,
            month: list.filter((r) => r.ts > now - 2592000000).length,
            total: list.length
        });
        const leftByGuild = {};
        for (const r of leftRecs) if (r.cardGuildId) (leftByGuild[r.cardGuildId] ||= []).push(r);

        // No-ad verifications (organic — no creative shown, tagged noAd in
        // index.js). Single-count stats feed the panel's "без рекламы" mode.
        const noAdByGuild = {};
        for (const u of entries) if (u.noAd) (noAdByGuild[u.guildId] ||= []).push(u);
        const ZERO = { hour: 0, day: 0, week: 0, month: 0, total: 0 };

        const grouped = {};
        for (const u of entries) (grouped[u.guildId] ||= []).push(u);
        const perGuild = Object.entries(grouped).map(([gid, list]) => {
            const net = verifStats(list);
            const lw = leftWinOf(leftByGuild[gid] || []);
            const gross = { hour: net.hour + lw.hour, day: net.day + lw.day, week: net.week + lw.week, month: net.month + lw.month, total: net.total + lw.total };
            const noAd = noAdByGuild[gid] ? verifStats(noAdByGuild[gid]) : { ...ZERO };
            return { gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), ...net, gross, noAd };
        });

        // A server with a per-server ad or per-server ads-off flag but no
        // verifications yet still needs a row in the "По серверам" table so
        // the admin can manage its ads/kran from there. Union the two.
        const knownGids = new Set(perGuild.map((g) => g.gid));
        const adGids = Object.keys(s.serverAds || {}).filter((g) => typeof s.serverAds[g] === 'string' && s.serverAds[g].trim());
        const offGids = Object.keys(cfg.serverAdsOff || {}).filter((g) => cfg.serverAdsOff[g]);
        for (const gid of [...adGids, ...offGids]) {
            if (!knownGids.has(gid)) {
                perGuild.push({ gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), hour: 0, day: 0, week: 0, month: 0, total: 0, gross: leftWinOf(leftByGuild[gid] || []), noAd: { ...ZERO } });
                knownGids.add(gid);
            }
        }
        perGuild.sort((a, b) => (b.gross?.total ?? b.total) - (a.gross?.total ?? a.total));

        // Financial: sum of every user's POSITIVE balance = money still owed
        // to creators. Negative balances (from sponsor-leave clawbacks) don't
        // reduce the debt — they represent overpayments the user has to earn
        // back, not funds available to the platform.
        let outstanding = 0, withBalance = 0, totalPaid = 0;
        for (const u of Object.keys(settings)) {
            const b = Number(settings[u]?.balance) || 0;
            if (b > 0) { outstanding += b; withBalance++; }
            // All-time payout: sum of every completed withdrawal across
            // every partner. This is money that has actually left to users.
            const wds = Array.isArray(settings[u]?.withdrawals) ? settings[u].withdrawals : [];
            for (const w of wds) if (w.status === 'completed') totalPaid += Number(w.amount) || 0;
        }

        // ---- Shares (доли) ----
        // Service profit per confirmed join = what we charge (REVENUE_PER_JOIN)
        // minus what the partner was actually paid (joinlinks amount). Only
        // 'joined' records count — leavers were clawed back and don't sell.
        const joinedRecs = (Array.isArray(joinlinksRaw) ? joinlinksRaw : []).filter((r) => r && r.status === 'joined');
        const pWin = { day: 0, week: 0, month: 0, total: 0 }; // net profit
        const rWin = { day: 0, week: 0, month: 0, total: 0 }; // revenue from joins
        const cWin = { day: 0, week: 0, month: 0, total: 0 }; // partner payouts
        const aWin = { day: 0, week: 0, month: 0, total: 0 }; // acquiring fee on those payouts
        for (const r of joinedRecs) {
            const amt = Number(r.amount) || 0;
            const acq = amt * ACQUIRING_RATE;
            const prof = REVENUE_PER_JOIN - amt - acq;
            const wins = [['total', true], ['day', r.ts > now - 86400000], ['week', r.ts > now - 604800000], ['month', r.ts > now - 2592000000]];
            for (const [k, inWin] of wins) if (inWin) { rWin[k] += REVENUE_PER_JOIN; cWin[k] += amt; aWin[k] += acq; pWin[k] += prof; }
        }
        const shareCfg = loadShares();
        const shareEarnings = loadJSON('shareearnings.json', {});
        const todayNum = dayNumberOf(now);
        const holderWin = (uid) => {
            const b = shareEarnings[uid] || {};
            let d = 0, w = 0, m = 0;
            for (const [k, v] of Object.entries(b)) {
                const dn = Number(k), val = Number(v) || 0;
                if (dn >= todayNum) d += val;
                if (dn > todayNum - 7) w += val;
                if (dn > todayNum - 30) m += val;
            }
            return { day: money(d), week: money(w), month: money(m) };
        };
        const holders = Object.entries(shareCfg).map(([uid, cfg]) => ({
            userId: uid,
            username: userNameOf(clients, uid),
            pct: Number(cfg.pct) || 0,
            addedAt: cfg.addedAt || 0,
            balance: money(settings[uid]?.balance),
            pending: money(cfg.pending),
            earnedTotal: money(cfg.earned),
            ...holderWin(uid)
        })).sort((a, b) => b.pct - a.pct);
        const roundWin = (w) => ({ day: money(w.day), week: money(w.week), month: money(w.month), total: money(w.total) });
        const sharesData = {
            salePricePer100: SALE_PRICE_PER_100,
            revenuePerJoin: REVENUE_PER_JOIN,
            acquiringRate: ACQUIRING_RATE,
            profit: roundWin(pWin),
            revenue: roundWin(rWin),
            partnerCost: roundWin(cWin),
            acquiring: roundWin(aWin),
            holders,
            totalPct: +holders.reduce((s, h) => s + h.pct, 0).toFixed(2)
        };

        // Per-creative rollup: verified.json entries carry the adKey they
        // were shown under (set by touchCreative in index.js), so we can
        // attribute counts back to individual rendered ad texts. Untagged
        // entries (from before creative tracking) are ignored here.
        const creatives = loadJSON('adcreatives.json', {});
        const perCreative = {}; // adKey -> { hour, day, week, month, total, guilds: {gid: count} }
        for (const u of entries) {
            if (!u.adKey) continue;
            let c = perCreative[u.adKey];
            if (!c) c = perCreative[u.adKey] = { hour: 0, day: 0, week: 0, month: 0, total: 0, guilds: {} };
            c.total++;
            if (u.timestamp > now - 3600000) c.hour++;
            if (u.timestamp > now - 86400000) c.day++;
            if (u.timestamp > now - 604800000) c.week++;
            if (u.timestamp > now - 2592000000) c.month++;
            c.guilds[u.guildId] = (c.guilds[u.guildId] || 0) + 1;
        }

        // Which creatives are on air right now: render the effective ad for
        // every managed guild (per-server ad falling back to the global one,
        // templates applied per guild) and hash it. Kran-closed guilds are
        // excluded — their creative isn't being shown.
        const activeText = {}; // adKey -> rendered text (fallback when no verifications yet)
        if (!cfg.adsOff) {
            for (const g of perGuild) {
                if (cfg.serverAdsOff && cfg.serverAdsOff[g.gid]) continue;
                const raw = (s.serverAds || {})[g.gid] || s.advText || '';
                if (!raw.trim()) continue;
                const rendered = applyTemplate(g.gid, raw);
                activeText[adKeyOf(rendered)] = rendered;
            }
        }
        // Creatives that are showing but haven't produced a verification yet
        // still need a card (that's where the limit gets set before launch).
        for (const key of Object.keys(activeText)) {
            if (!perCreative[key]) perCreative[key] = { hour: 0, day: 0, week: 0, month: 0, total: 0, guilds: {} };
        }

        const limits = loadJSON('adlimits.json', {});
        const adLimits = limits;
        // adKey of the global ad rendered through the default template — used
        // to surface its join-limit on the global ad editor.
        const globalKey = (s.advText || '').trim() ? adKeyOf(applyTemplate(null, s.advText)) : '';
        // Count / first-seen / last-seen for a creative, measured only from
        // its last counter reset (resetAt).
        const statsSinceReset = (key) => {
            if (!key) return { count: 0, firstAt: 0, lastAt: 0 };
            const since = Number(limits[key]?.resetAt) || 0;
            let count = 0, firstAt = 0, lastAt = 0;
            for (const u of entries) {
                if (u.adKey !== key || u.timestamp <= since) continue;
                count++;
                if (!firstAt || u.timestamp < firstAt) firstAt = u.timestamp;
                if (u.timestamp > lastAt) lastAt = u.timestamp;
            }
            return { count, firstAt, lastAt };
        };
        const globalStats = statsSinceReset(globalKey);
        const adCreatives = (await Promise.all(Object.entries(perCreative)
            .map(async ([key, c]) => {
                const text = creatives[key]?.text || activeText[key] || '(текст не найден в adcreatives.json)';
                const active = Boolean(activeText[key]);
                // Join-check mode = the ad's invite leads to a guild one of
                // our bots sits on. Only resolved for on-air creatives (the
                // invite cache in joincheck.js makes repeat polls cheap).
                const joinMode = active
                    ? Boolean(await resolveSponsorPresence(clients, text).catch(() => null))
                    : false;
                const reset = Number(limits[key]?.resetAt) || 0;
                // The limit counter + "Впервые" measure from the last reset.
                const st = reset ? statsSinceReset(key) : { count: c.total, firstAt: creatives[key]?.firstSeenAt || 0 };
                return {
                    key, text, active, joinMode,
                    limit: Number(limits[key]?.limit) || 0,
                    limitCount: st.count,
                    resetAt: reset,
                    firstSeenAt: st.firstAt || creatives[key]?.firstSeenAt || 0,
                    lastSeenAt: creatives[key]?.lastSeenAt || 0,
                    guilds: Object.entries(c.guilds)
                        .map(([gid, count]) => ({ gid, name: guildNameOf(clients, gid), count }))
                        .sort((a, b) => b.count - a.count),
                    hour: c.hour, day: c.day, week: c.week, month: c.month, total: c.total
                };
            })))
            .sort((a, b) => (b.active - a.active) || (b.total - a.total));

        // Gross vs "stays" for the headline cards — same leftRecs source as
        // the per-guild table above.
        const netStats = verifStats(entries);
        const lAll = leftWinOf(leftRecs);
        const grossStats = {
            hour: netStats.hour + lAll.hour,
            day: netStats.day + lAll.day,
            week: netStats.week + lAll.week,
            month: netStats.month + lAll.month,
            total: netStats.total + lAll.total
        };

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
                // Join-limit for the globally-rendered creative, so the limit
                // can be managed straight from the global ad editor. Count /
                // first-seen are measured from the last counter reset.
                defaultKey: globalKey,
                defaultLimit: Number(adLimits[globalKey]?.limit) || 0,
                defaultCount: globalStats.count,
                defaultFirstAt: globalStats.firstAt,
                defaultLastAt: globalStats.lastAt,
                servers: Object.entries(s.serverAds || {})
                    .filter(([, v]) => typeof v === 'string' && v.trim())
                    .map(([gid, text]) => ({
                        gid, name: guildNameOf(clients, gid), text,
                        updatedAt: s.serverAdsAt?.[gid] || 0
                    }))
            },
            stats: {
                all: netStats,
                gross: grossStats,
                noAd: verifStats(entries.filter((u) => u.noAd)),
                perGuild,
                outstanding: money(outstanding),
                withBalance,
                totalPaid: money(totalPaid)
            },
            shares: sharesData,
            cryptoBalance: await cryptoUsdtBalance(),
            adCreatives
        }, cors);
    }

    if (path === '/admin/template' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : null;
        if (gid && !/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        // 2000-char cap matches the Discord /advertising-text modal limit
        // and stops runaway payloads from bloating adtemplates.json.
        const text = String(body?.text ?? '').slice(0, 2000);
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
        // applied at render time (see getAd in index.js). 4000-char cap
        // is generous but keeps settings.json from ballooning.
        const text = String(body?.text ?? '').slice(0, 4000);
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
        // Same synthetic-gid skip as in /admin/state — no "Unknown Server"
        // rows for partner-API verifications without a real guildId.
        for (const u of mine) {
            if (!/^\d{17,20}$/.test(u.guildId)) continue;
            (grouped[u.guildId] ||= []).push(u);
        }
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
            // Sanity cap: a compromised session shouldn't be able to nuke the
            // Crypto Pay wallet in one shot. Trusted owner can still stack
            // adjustments if they really need >$1M — legitimate adjustments
            // are $10-$100 range.
            if (Math.abs(delta) > 1_000_000) return send(res, 400, { error: 'delta too large' }, cors);
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

    // Join-limit per creative: cap the number of NET joins (leavers drop
    // out of verified.json via clawback, so they free up slots) after which
    // the ad stops being shown. limit <= 0 removes the cap.
    if (path === '/admin/creative-limit' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const key = String(body?.key || '');
        if (!/^[0-9a-f]{12}$/.test(key)) return send(res, 400, { error: 'bad key' }, cors);
        const limit = Math.floor(Number(body?.limit));
        const limits = loadJSON('adlimits.json', {});
        if (Number.isFinite(limit) && limit > 0) limits[key] = { limit, setAt: Date.now() };
        else delete limits[key];
        saveJSON('adlimits.json', limits);
        return send(res, 200, { ok: true, key, limit: limits[key]?.limit || 0 }, cors);
    }

    // Reset a creative's join counter — starts a fresh campaign toward the
    // same limit. Stamps resetAt (enforcement + "Впервые" count from here)
    // and re-arms the completion notice.
    if (path === '/admin/creative-reset' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const key = String(body?.key || '');
        if (!/^[0-9a-f]{12}$/.test(key)) return send(res, 400, { error: 'bad key' }, cors);
        const limits = loadJSON('adlimits.json', {});
        if (!limits[key]) limits[key] = {};
        limits[key].resetAt = Date.now();
        delete limits[key].notifiedAt;
        saveJSON('adlimits.json', limits);
        return send(res, 200, { ok: true, key }, cors);
    }

    // Create a Crypto Pay invoice to top up the app balance — same as the
    // /cryptofund Discord command, but from the panel. Returns a pay URL.
    if (path === '/admin/cryptofund' && req.method === 'POST') {
        if (!cryptopay.enabled()) return send(res, 503, { error: 'Crypto Pay не настроен' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const n = Number(body?.amount);
        if (!Number.isFinite(n) || n <= 0) return send(res, 400, { error: 'Введите сумму больше 0' }, cors);
        const inv = await cryptopay.createUsdtInvoice(n.toFixed(2)).catch((e) => ({ __err: e.message }));
        const url = inv && (inv.bot_invoice_url || inv.mini_app_invoice_url || inv.pay_url);
        if (!url) return send(res, 502, { error: `Не удалось создать счёт${inv?.__err ? ` (${inv.__err})` : ''}` }, cors);
        return send(res, 200, { ok: true, url, amount: n.toFixed(2) }, cors);
    }

    // Shares (доли): set a holder's percentage. pct <= 0 removes them.
    // Existing pending/earned accounting is preserved across edits.
    if (path === '/admin/shares' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const uid = String(body?.userId || '');
        if (!/^\d{17,20}$/.test(uid)) return send(res, 400, { error: 'bad user id' }, cors);
        const pct = Number(body?.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return send(res, 400, { error: 'pct must be 0..100' }, cors);
        const cfg = loadShares();
        if (pct <= 0) delete cfg[uid];
        else cfg[uid] = { ...(cfg[uid] || {}), pct: +pct.toFixed(2), addedAt: cfg[uid]?.addedAt || Date.now() };
        saveJSON('shares.json', cfg);
        return send(res, 200, { ok: true, userId: uid, pct: cfg[uid]?.pct || 0 }, cors);
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

            // Admin panel (TOTP-gated, CORS-scoped to ADMIN_ORIGIN).
            // Await so any async rejection lands in this outer try/catch —
            // otherwise handleAdmin's promise would settle after we've
            // already returned and become an unhandled rejection.
            if (p.startsWith('/admin/') || p === '/admin') {
                return await handleAdmin(req, res, p, clients, config);
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

            // Secure join-check: a partner's bot asks whether `userId` is
            // really a member of the sponsor server, and — if so — the join
            // is credited (join-check rate) exactly like the in-Discord flow.
            //
            // Anti-fraud, layered:
            //  1. The sponsor server is NOT chosen by the partner — it must be
            //     one of the servers WE are currently advertising (activeSponsors:
            //     live ad, kran open, limit not reached, a network bot present).
            //     The partner may narrow to one of them, but cannot invent one.
            //  2. Membership is verified with Discord's own REST API through a
            //     network bot on the sponsor guild — the partner cannot fake it.
            //  3. Optional JOIN_CHECK_GUILDS allowlist further restricts payouts.
            //  4. Dedup per (creator, sponsor, user): a real member is paid once.
            //  5. The rate is the owner-set join bid, never partner-controlled.
            if (p === '/api/join-check' && req.method === 'POST') {
                const body = await readBody(req);
                if (body === null) return send(res, 400, { error: 'Invalid JSON body' });
                const memberId = String(body.userId || '').trim();
                if (!/^\d{17,20}$/.test(memberId)) return send(res, 400, { error: 'userId must be a Discord user ID' });

                // Only servers with a live ad campaign are eligible.
                const sponsors = await activeSponsors(clients, config.ownerId);
                if (!sponsors.length) return send(res, 422, { joined: false, error: 'нет активной рекламы с проверкой на заход' });

                // Partner may narrow to a specific sponsor, but it must be one
                // of the currently-advertised ones.
                let candidates = sponsors;
                const gid = String(body.guildId || '').trim();
                if (/^\d{17,20}$/.test(gid)) {
                    candidates = sponsors.filter((s) => s.guildId === gid);
                } else if (body.invite) {
                    const sp = await resolveSponsorPresence(clients, String(body.invite)).catch(() => null);
                    candidates = sp ? sponsors.filter((s) => s.guildId === sp.guildId) : [];
                }
                if (JOIN_CHECK_GUILDS.size) candidates = candidates.filter((s) => JOIN_CHECK_GUILDS.has(s.guildId));
                if (!candidates.length) return send(res, 403, { joined: false, error: 'этот сервер сейчас не в активной рекламе' });

                // Independent membership check via Discord REST against each
                // eligible sponsor; credit the first the user actually joined.
                let matched = null, transient = false;
                for (const s of candidates) {
                    const present = await isMember(s.bot, s.guildId, memberId).catch(() => null);
                    if (present === true) { matched = s; break; }
                    if (present === null) transient = true;
                }
                if (!matched) {
                    if (transient) return send(res, 503, { joined: null, error: 'membership check temporarily unavailable, retry' });
                    return send(res, 403, { joined: false });
                }

                // Dedup — never pay twice for the same real member.
                const links = loadJSON('joinlinks.json', []);
                const already = (Array.isArray(links) ? links : []).some(
                    (r) => r && r.status === 'joined' && r.creatorId === userId && r.guildId === matched.guildId && r.userId === memberId
                );
                if (already) return send(res, 200, { joined: true, credited: false, sponsor: matched.guildId, note: 'already counted' });

                // Record + credit — creditJoin writes a joinlinks record the
                // clawback sweep watches, so leaving the sponsor reverses it.
                const cardGuild = /^\d{17,20}$/.test(String(body.cardGuildId || '')) ? String(body.cardGuildId) : null;
                const amount = creditJoin(userId, matched.guildId, memberId, cardGuild, null, null);
                await payShares(clients, amount).catch(() => null);
                await maybeAutoWithdraw(clients, userId).catch(() => null);
                const s = loadJSON('settings.json')[userId] || {};
                return send(res, 200, { joined: true, credited: true, sponsor: matched.guildId, amount: money(amount), balance: money(s.balance) });
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

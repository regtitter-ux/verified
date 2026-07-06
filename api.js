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
const { adKeyOf, touchCreative, maybeNotifyAdComplete } = require('./adcreative.js');
const { resolveSponsorPresence, isMember, creditJoin, extractInviteCodes } = require('./joincheck.js');
const { syncHubMember } = require('./hubrole.js');
const { logFunds } = require('./fundslog.js');
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

// The single ad that applies to one server — the SAME rule every network bot
// uses: the owner's per-server ad if set for that server, otherwise the
// global ad. Returns { adText, sponsor:{guildId,bot}|null, invite } — adText
// null means "no ad, verify without one" (kran closed, no ad set, or the
// join limit is reached). sponsor is set only in join-check mode (the ad's
// invite leads to a server a network bot is on).
async function adForServer(clients, ownerId, serverId) {
    const cfg = loadJSON('siteconfig.json', {});
    const gidOk = /^\d{17,20}$/.test(String(serverId || ''));
    if (cfg.adsOff) return { adText: null, sponsor: null, invite: null };
    if (gidOk && cfg.serverAdsOff && cfg.serverAdsOff[serverId]) return { adText: null, sponsor: null, invite: null };

    const settings = loadJSON('settings.json');
    const s = settings[ownerId] || {};
    let raw = null;
    if (gidOk && (s.serverAds || {})[serverId] && String(s.serverAds[serverId]).trim()) raw = s.serverAds[serverId];
    else if ((s.advText || '').trim()) raw = s.advText;
    if (!raw) return { adText: null, sponsor: null, invite: null };
    // Render with this server's template (falls back to global/default), so a
    // bare global-ad link still lands inside the server's own template.
    const gid = gidOk ? serverId : null;

    const rendered = applyTemplate(gid, raw);
    // The campaign is keyed by the RAW ad (the link/text the owner stored),
    // NOT the rendered text — so the same ad shown through different
    // per-server templates is ONE creative with ONE limit.
    const key = adKeyOf(raw);
    // Reached its join limit → treat as no ad (verification runs ad-free).
    const limits = loadJSON('adlimits.json', {});
    const rec = limits[key];
    if (rec && Number(rec.limit) > 0) {
        const verified = loadJSON('verified.json', []);
        const arr = Array.isArray(verified) ? verified : [];
        const since = Number(rec.resetAt) || 0;
        const cnt = arr.filter((u) => u.adKey === key && u.timestamp > since).length;
        if (cnt >= Number(rec.limit)) return { adText: null, sponsor: null, invite: null };
    }

    const sponsor = await resolveSponsorPresence(clients, raw).catch(() => null);
    // Don't advertise a server on itself: if the ad's sponsor IS this server,
    // its members are already in — run ad-free (also blocks self-join farming).
    if (sponsor && gidOk && sponsor.guildId === String(serverId)) {
        return { adText: null, sponsor: null, invite: null };
    }
    const codes = extractInviteCodes(raw);
    return { adText: rendered, raw, sponsor, invite: codes.length ? `https://discord.gg/${codes[0]}` : null };
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

// Record an API verification exactly like the in-Discord flow: one entry per
// (member, server), tagged with the creative's adKey (paid join) or noAd
// (no active ad). Replaces any prior entry so repeats don't inflate stats.
// Returns the fresh verified.json array (for the completion-notice check).
function recordApiVerified({ creatorId, memberId, serverId, adKey, noAd }) {
    const verified = loadJSON('verified.json', []);
    const arr = Array.isArray(verified) ? verified : [];
    const gid = /^\d{17,20}$/.test(String(serverId || '')) ? String(serverId) : 'api';
    const mid = /^\d{17,20}$/.test(String(memberId || '')) ? String(memberId) : 'api';
    const kept = arr.filter((u) => !(u.id === mid && u.guildId === gid && (u.roleId || null) === 'api'));
    const rec = { id: mid, guildId: gid, roleId: 'api', creatorId, timestamp: Date.now(), viaApi: true };
    if (adKey) rec.adKey = adKey;
    else if (noAd) rec.noAd = true;
    kept.push(rec);
    saveJSON('verified.json', kept);
    return kept;
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
    note: 'Your bot behaves exactly like a network verification bot. You only run verifications; ad text, rate and campaigns are controlled by the owner — you cannot set them. Payouts are earned only through verified joins.',
    endpoints: {
        'GET /api/ad': 'The ad to show on your server: ?serverId=<your guild>. Returns { adText, sponsor:{guildId,name,invite}|null }. It is the owner\'s per-server ad if set for your server, else the global ad — same rule as every network bot. adText null → no ad, just verify.',
        'POST /api/join-check': 'Complete a verification, mirroring the in-Discord bots. Body: { userId, serverId }. We pick the ad for your server (per-server override or global) and: if it is a join-check ad, we verify membership on its sponsor via Discord — 200 { joined:true, credited:true } on success (let them through), 403 { joined:false } if not a member (ask them to join first). If there is no ad (kran closed / none set / limit reached), 200 { joined:true, ad:false } → verify them without an ad (no-ad stat recorded, no payout). The sponsor is derived from OUR ad config, never partner input. 503 to retry. Each member is paid once per sponsor; leaving reverses it.',
        'GET /api/balance': 'Your balance and payment details.',
        'GET /api/stats': 'Your verification stats (per server + time windows).',
        'GET /api/requisites': 'Your payment details.',
        'PUT /api/requisites': 'Set your payout details. Body: { requisites }. (The only thing you configure — same as a network bot operator setting theirs in /bal.)',
        'GET /api/withdrawals': 'Your withdrawal history and total withdrawn.',
        'POST /api/withdraw': 'Nudge the payout check — a request is filed automatically once balance reaches $10.'
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

    // ---- Discord OAuth login (top-level browser navigations, not fetch) ----
    // Start: bounce the browser to Discord's consent screen.
    if (path === '/admin/oauth/login' && req.method === 'GET') {
        const url = adminAuth.oauthAuthorizeUrl(adminAuth.issueState());
        res.writeHead(302, { Location: url });
        return res.end();
    }
    // Callback: exchange the code, check the user's role, set the session
    // cookie and send them back to the panel. On any failure, bounce back
    // with ?login=denied so the UI can show a message.
    if (path === '/admin/oauth/callback' && req.method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const back = adminAuth.adminOrigin() + '/admin/';
        if (!code || !adminAuth.verifyState(state)) {
            res.writeHead(302, { Location: back + '?login=denied' });
            return res.end();
        }
        let uid = null;
        try { uid = await adminAuth.resolveOauthUser(code); } catch { uid = null; }
        const role = uid ? adminAuth.roleOf(uid) : null;
        if (!role) {
            res.writeHead(302, { Location: back + '?login=denied' });
            return res.end();
        }
        const token = adminAuth.issueSession(uid, role);
        res.writeHead(302, { Location: back, 'Set-Cookie': adminAuth.sessionCookieHeader(token) });
        return res.end();
    }
    if (path === '/admin/logout' && req.method === 'POST') {
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': adminAuth.sessionCookieHeader('', { clear: true }) });
    }
    if (path === '/admin/whoami' && req.method === 'GET') {
        const sess = adminAuth.verifySession(adminAuth.readSessionCookie(req.headers.cookie));
        return send(res, 200, sess ? { authed: true, userId: sess.userId, role: sess.role } : { authed: false }, cors);
    }

    // Everything below requires a valid session cookie.
    const session = adminAuth.verifySession(adminAuth.readSessionCookie(req.headers.cookie));
    if (!session) return send(res, 401, { error: 'unauthorized' }, cors);
    const isOwner = session.role === 'owner';
    // Owner-only areas: Templates, Balances, Crypto Pay top-up, admin mgmt.
    const ownerOnly = () => send(res, 403, { error: 'owner only' }, cors);

    if (path === '/admin/state' && req.method === 'GET') {
        const uid = config.ownerId;
        const settings = loadJSON('settings.json');
        const s = settings[uid] || {};
        const t = loadJSON('adtemplates.json', {});
        const cfg = loadJSON('siteconfig.json', {});

        // Servers the network currently sits on. When a bot is kicked, the
        // guild drops out of every bot's cache — we exclude it (and all its
        // joins) from stats so a kicked "Unknown Server" no longer lingers.
        const activeGuildIds = new Set();
        for (const c of Array.isArray(clients) ? clients : []) {
            for (const id of (c.guilds?.cache?.keys?.() || [])) activeGuildIds.add(id);
        }

        const verified = loadJSON('verified.json', []);
        // Count only verifications on a guild a bot is still on (this also
        // drops synthetic 'api' guildIds, which are never in the cache).
        const entries = (Array.isArray(verified) ? verified : [])
            .filter((u) => u.roleId && activeGuildIds.has(u.guildId));
        const now = Date.now();

        // Reversed join-check verifications (user left the sponsor) are
        // deleted from verified.json but survive in joinlinks.json as
        // status 'left' with the original timestamp and card guild — that's
        // what turns net counts into gross ones, per guild and overall.
        // Only count those whose card guild is still one of ours.
        const joinlinksRaw = loadJSON('joinlinks.json', []);
        const leftRecs = (Array.isArray(joinlinksRaw) ? joinlinksRaw : []).filter((r) => r && r.status === 'left' && activeGuildIds.has(r.cardGuildId));
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
            // Only surface a management row for a guild a bot is still on.
            if (!knownGids.has(gid) && activeGuildIds.has(gid)) {
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
        // Keyed by the RAW ad (campaign), display text is the raw ad too so
        // one campaign shown through several templates stays a single card.
        const activeText = {}; // campaignKey -> raw ad text
        if (!cfg.adsOff) {
            for (const g of perGuild) {
                if (cfg.serverAdsOff && cfg.serverAdsOff[g.gid]) continue;
                const raw = (s.serverAds || {})[g.gid] || s.advText || '';
                if (!raw.trim()) continue;
                activeText[adKeyOf(raw)] = raw;
            }
        }
        // Creatives that are showing but haven't produced a verification yet
        // still need a card (that's where the limit gets set before launch).
        for (const key of Object.keys(activeText)) {
            if (!perCreative[key]) perCreative[key] = { hour: 0, day: 0, week: 0, month: 0, total: 0, guilds: {} };
        }

        const limits = loadJSON('adlimits.json', {});
        const adLimits = limits;
        // Campaign key of the global ad (the raw stored ad) — used to surface
        // its join-limit on the global ad editor. Keyed by raw so the counter
        // spans every server, whatever per-server template renders it.
        const globalKey = (s.advText || '').trim() ? adKeyOf(s.advText) : '';
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

    // Admin management (owner only): list / add / remove assigned admins.
    if (path === '/admin/admins' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        return send(res, 200, { owner: adminAuth.OWNER_ID, admins: adminAuth.loadAdmins() }, cors);
    }
    if (path === '/admin/admins' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const id = String(body?.userId || '');
        if (!/^\d{17,20}$/.test(id)) return send(res, 400, { error: 'bad user id' }, cors);
        const list = adminAuth.loadAdmins();
        const next = body?.remove ? list.filter((x) => x !== id) : [...list, id];
        const saved = adminAuth.saveAdmins(next);
        return send(res, 200, { ok: true, admins: saved }, cors);
    }

    if (path === '/admin/template' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
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
        if (!isOwner) return ownerOnly();
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
        if (!isOwner) return ownerOnly();
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
        if (!isOwner) return ownerOnly();
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
        if (!isOwner) return ownerOnly();
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
        if (!isOwner) return ownerOnly();
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
                    requisites: (s.requisites || '').trim()
                });
            }

            // The ad to show on YOUR server right now — the owner's per-server
            // ad if they set one for it, else the global ad (same rule as
            // every network bot). Poll this, show adText to your users.
            // adText null → no ad, just verify. Query: ?serverId=<your guild>.
            if (p === '/api/ad' && req.method === 'GET') {
                const serverId = (new URL(req.url, 'http://x')).searchParams.get('serverId') || '';
                const ad = await adForServer(clients, config.ownerId, serverId);
                return send(res, 200, {
                    adText: ad.adText,
                    sponsor: ad.sponsor ? { guildId: ad.sponsor.guildId, name: guildNameOf(clients, ad.sponsor.guildId), invite: ad.invite } : null
                });
            }

            // Complete a verification — same logic as the in-Discord bots.
            // The partner passes only { userId, serverId }. We pick the ad for
            // that server (per-server override or global), and:
            //  • no ad (kran closed / none set / limit reached) → verify
            //    without an ad (no-ad stat, hub role, no payout);
            //  • ad in join-check mode → verify membership on THAT sponsor via
            //    Discord and, on success, credit + record exactly like a
            //    network bot. Not a member → 403, ask them to join first.
            // The sponsor is derived from OUR ad config, never partner input,
            // so it can't be farmed. Dedup per (creator, sponsor, user).
            if (p === '/api/join-check' && req.method === 'POST') {
                const body = await readBody(req);
                if (body === null) return send(res, 400, { error: 'Invalid JSON body' });
                const memberId = String(body.userId || '').trim();
                if (!/^\d{17,20}$/.test(memberId)) return send(res, 400, { error: 'userId must be a Discord user ID' });
                const serverId = /^\d{17,20}$/.test(String(body.serverId || '')) ? String(body.serverId)
                    : (/^\d{17,20}$/.test(String(body.cardGuildId || '')) ? String(body.cardGuildId) : null);

                const ad = await adForServer(clients, config.ownerId, serverId);
                const sponsor = ad.sponsor;
                const approved = sponsor && (!JOIN_CHECK_GUILDS.size || JOIN_CHECK_GUILDS.has(sponsor.guildId));

                // No join-check sponsor for this server → verify without an ad,
                // exactly like a network bot: no-ad stat, hub role, no payout.
                if (!approved) {
                    recordApiVerified({ creatorId: userId, memberId, serverId, noAd: true });
                    syncHubMember(clients, memberId).catch(() => null);
                    return send(res, 200, { joined: true, credited: false, ad: false });
                }

                // Membership check against the sponsor of THIS server's ad.
                const present = await isMember(sponsor.bot, sponsor.guildId, memberId).catch(() => null);
                if (present === null) return send(res, 503, { joined: null, error: 'membership check temporarily unavailable, retry' });
                if (present !== true) return send(res, 403, { joined: false });

                // Dedup — never pay twice for the same real member.
                const links = loadJSON('joinlinks.json', []);
                const already = (Array.isArray(links) ? links : []).some(
                    (r) => r && r.status === 'joined' && r.creatorId === userId && r.guildId === sponsor.guildId && r.userId === memberId
                );
                if (already) return send(res, 200, { joined: true, credited: false, sponsor: sponsor.guildId, note: 'already counted' });

                // Full parity with the in-Discord flow: joinlinks (clawback-
                // watched, roleId 'api' + serverId), share split, verified.json
                // tagged with the shown creative's adKey, hub role, audit log,
                // campaign-complete notice.
                const adKey = touchCreative(ad.raw);
                const amount = creditJoin(userId, sponsor.guildId, memberId, serverId, 'api', null);
                await payShares(clients, amount).catch(() => null);
                const fresh = recordApiVerified({ creatorId: userId, memberId, serverId, adKey });
                syncHubMember(clients, memberId).catch(() => null);
                await logFunds(clients, {
                    type: 'credit', creatorId: userId, userId: memberId, guildId: serverId,
                    amount, reason: 'Join verified (API)'
                }).catch(() => null);
                maybeNotifyAdComplete(clients, adKey, fresh).catch(() => null);
                await maybeAutoWithdraw(clients, userId).catch(() => null);
                const s = loadJSON('settings.json')[userId] || {};
                return send(res, 200, { joined: true, credited: true, sponsor: sponsor.guildId, amount: money(amount), balance: money(s.balance) });
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

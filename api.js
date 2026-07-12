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
const { adKeyOf, touchCreative, maybeNotifyAdComplete, joinerCount } = require('./adcreative.js');
const { resolveSponsorPresence, isMember, creditJoin, extractInviteCodes } = require('./joincheck.js');
const { syncHubMember } = require('./hubrole.js');
const { logFunds } = require('./fundslog.js');
const { SALE_PRICE_PER_100, REVENUE_PER_JOIN, ACQUIRING_RATE, loadShares, dayNumberOf, payShares, distributeProfit } = require('./shares.js');
const { boostActive, BOOST_RATE, BOOST_MS } = require('./referral.js');
const cryptopay = require('./cryptopay.js');
const campaigns = require('./campaigns.js');
const managers = require('./managers.js');
const feed = require('./feed.js');
const cards = require('./cards.js');
const audit = require('./auditlog.js');
const backup = require('./backup.js');
const wallet = require('./wallet.js');
const investors = require('./investors.js');
const sales = require('./sales.js');
const partnerlog = require('./partnerlog.js');
const logincodes = require('./logincodes.js');

// The site can be reached from more than one origin (e.g. the apex AND the www
// host). ADMIN_API_ORIGIN may be a comma-separated list; any of them gets CORS +
// credentialed cookies. A user on a non-whitelisted host (say www when only the
// apex is listed) has EVERY credentialed API call blocked → they bounce back to
// the login screen even after a valid login.
const ADMIN_ORIGINS = (process.env.ADMIN_API_ORIGIN || 'https://vemoni.info,https://www.vemoni.info')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const ADMIN_ORIGIN = ADMIN_ORIGINS[0];
const isAllowedOrigin = (o) => ADMIN_ORIGINS.includes(String(o || '').replace(/\/+$/, ''));

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
// Mark a sponsor as "being advertised right now" — the same stamp the
// in-Discord flow writes when it shows an ad (index.js). This gates the
// leave-clawback: a member leaving a sponsor whose ad hasn't shown recently is
// NOT clawed back (joincheck.js). Without stamping here, sponsors advertised
// only through API partners would look permanently "off" and their delivered
// joins could never be clawed back. Throttled to one write/minute per sponsor.
function stampSponsorShow(gid) {
    if (!/^\d{17,20}$/.test(String(gid || ''))) return;
    try {
        const shows = loadJSON('sponsorshow.json', {});
        const now = Date.now();
        if (now - (Number(shows[gid]) || 0) < 60000) return; // already fresh → skip the write
        shows[gid] = now;
        saveJSON('sponsorshow.json', shows);
    } catch { /* stamping must never break the ad path */ }
}

async function adForServer(clients, ownerId, serverId) {
    const cfg = loadJSON('siteconfig.json', {});
    const gidOk = /^\d{17,20}$/.test(String(serverId || ''));
    if (cfg.adsOff) return { adText: null, sponsor: null, invite: null };
    if (gidOk && cfg.serverAdsOff && cfg.serverAdsOff[serverId]) return { adText: null, sponsor: null, invite: null };

    // Paid buyer campaigns take priority (respecting "Серверы показа" opt-outs,
    // the self-ad rule, the purchased cap and the per-creative join limit). Try
    // the eligible campaigns in weighted order and serve the FIRST that is
    // showable — not capped, invite resolves to a join-checkable server that
    // isn't this one. A campaign that fails a check is skipped so the next
    // eligible one is tried; only when NONE is showable do we fall through to
    // house ads. (No membership check here — /api/ad has no user yet; that
    // happens later at /api/join-check.)
    if (gidOk) {
        try {
            const verified = loadJSON('verified.json', []);
            const limits = loadJSON('adlimits.json', {});
            const capReached = (raw) => { const rec = limits[adKeyOf(raw)]; const cap = Number(rec?.limit) || 0; return cap > 0 && joinerCount(verified, adKeyOf(raw), Number(rec?.resetAt) || 0) >= cap; };
            const ordered = campaigns.weightedOrder(campaigns.eligibleForGuild(serverId, verified, campaigns.fleetGuildIds(clients)));
            let checks = 0;
            for (const cand of ordered) {
                if (checks >= 8) break;                                  // bound the network calls
                if (capReached(cand.invite)) continue;
                checks++;
                const sponsor = await resolveSponsorPresence(clients, cand.invite).catch(() => null);
                if (!sponsor || sponsor.guildId === String(serverId)) continue; // unresolvable / self → try next
                stampSponsorShow(sponsor.guildId);
                const codes = extractInviteCodes(cand.invite);
                return { adText: applyTemplate(serverId, cand.invite), raw: cand.invite, sponsor, campaignId: cand.id, invite: codes.length ? `https://discord.gg/${codes[0]}` : null };
            }
            // No showable campaign → fall through to house ads.
        } catch (e) { /* fall through to house ads */ }
    }

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
        const since = Number(rec.resetAt) || 0;
        const cnt = joinerCount(verified, key, since); // unique joiners, not raw entries
        if (cnt >= Number(rec.limit)) return { adText: null, sponsor: null, invite: null };
    }

    const sponsor = await resolveSponsorPresence(clients, raw).catch(() => null);
    // Ads only run when the join can be verified. No sponsor bot (the invite
    // points to a server no network bot is on, or there's no invite at all)
    // means no join-check → don't serve the ad; verification runs ad-free.
    // Also never advertise a server on itself (members are already in).
    if (!sponsor || (gidOk && sponsor.guildId === String(serverId))) {
        return { adText: null, sponsor: null, invite: null };
    }
    stampSponsorShow(sponsor.guildId);
    const codes = extractInviteCodes(raw);
    return { adText: rendered, raw, sponsor, invite: codes.length ? `https://discord.gg/${codes[0]}` : null };
}

// For /api/join-check: /api/ad is stateless and may have shown ANY eligible
// campaign (or the house ad), so re-rolling a single random pick here would
// often check the WRONG sponsor and 403 a user who correctly joined the shown
// one. Instead, scan the SAME candidate pool and return the ad whose sponsor
// the user is actually a member of — deterministic and correctly attributed.
// Returns one of: { ad } | { uncertain:true } (→503) | { none:true } (→ad-free)
// | { notMember:true } (→403). The credit dedup still guards double-pay.
async function matchJoinedSponsor(clients, ownerId, serverId, memberId) {
    const cfg = loadJSON('siteconfig.json', {});
    if (cfg.adsOff || (cfg.serverAdsOff && cfg.serverAdsOff[serverId])) return { none: true };
    const verified = loadJSON('verified.json', []);
    const limits = loadJSON('adlimits.json', {});
    const capReached = (raw) => { const rec = limits[adKeyOf(raw)]; const cap = Number(rec?.limit) || 0; return cap > 0 && joinerCount(verified, adKeyOf(raw), Number(rec?.resetAt) || 0) >= cap; };
    const approvedSponsor = (gid) => !JOIN_CHECK_GUILDS.size || JOIN_CHECK_GUILDS.has(gid);

    // Same candidate order /api/ad uses: eligible campaigns (weighted), then house ad.
    const cands = campaigns.weightedOrder(campaigns.eligibleForGuild(serverId, verified, campaigns.fleetGuildIds(clients)))
        .map((c) => ({ raw: c.invite, campaignId: c.id }));
    const s = loadJSON('settings.json')[ownerId] || {};
    const houseRaw = (s.serverAds && s.serverAds[serverId] && String(s.serverAds[serverId]).trim()) ? s.serverAds[serverId]
        : ((s.advText || '').trim() ? s.advText : null);
    if (houseRaw) cands.push({ raw: houseRaw, campaignId: null });

    let sawAny = false, uncertain = false, checks = 0;
    for (const cand of cands) {
        if (capReached(cand.raw)) continue;
        if (checks >= 8) break;
        checks++;
        const text = applyTemplate(serverId, cand.raw);
        const sp = await resolveSponsorPresence(clients, text).catch(() => null);
        if (!sp || sp.guildId === String(serverId) || !approvedSponsor(sp.guildId)) continue;
        sawAny = true;
        const m = await isMember(sp.bot, sp.guildId, memberId).catch(() => null);
        if (m === true) { stampSponsorShow(sp.guildId); return { ad: { adText: text, raw: cand.raw, sponsor: sp, campaignId: cand.campaignId } }; }
        if (m === null) uncertain = true;
    }
    if (uncertain) return { uncertain: true };  // don't 403 on a transient check
    if (sawAny) return { notMember: true };      // ads exist, user joined none yet
    return { none: true };                        // no join-check ad for this server
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
    // Paid verifications only (adKey set = an ad was shown and it wasn't a
    // duplicate join). Excludes no-ad/ads-off and duplicate verifications, and
    // leavers are already gone from verified.json — so the count matches the
    // balance, same rule as /bal and the admin "С рекламой" stats.
    const mine = (Array.isArray(verified) ? verified : []).filter(u => u.creatorId === userId && u.roleId && u.adKey);
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

// Enrich verification-card records with the funnel stats (first click →
// join checked → stayed), the average first-click→verify delay, and
// guild/channel/role/owner names. Shared by the admin registry and the
// partner cabinet so both show identical card cards. Returns
// { list, avgVerifySeconds }, list mirroring the input order.
function enrichCards(clients, records) {
    const now = Date.now();
    const vArr = (() => { const v = loadJSON('verified.json', []); return Array.isArray(v) ? v : []; })();
    const jArr = (() => { const j = loadJSON('joinlinks.json', []); return Array.isArray(j) ? j : []; })();
    // Unique users per hour/day/week for a matched set of records.
    const winOf = (items, tsField, uField) => {
        const h = new Set(), d = new Set(), w = new Set();
        for (const x of items) {
            const t = Number(x[tsField]) || 0, u = x[uField];
            if (t > now - 3600000) h.add(u);
            if (t > now - 86400000) d.add(u);
            if (t > now - 604800000) w.add(u);
        }
        return { hour: h.size, day: d.size, week: w.size };
    };
    const globalDeltas = []; // ms from first click → successful verification
    const list = (Array.isArray(records) ? records : []).map((c) => {
        const rid = c.roleId || null;
        // All role ids this card's stats live under (current + any pre-reset
        // role) so "Сбросить роль" doesn't zero the funnel.
        const roleIds = cards.cardRoleIds(c);
        // Verified-and-still-standing for this card (stage 3), and clawed
        // leavers (verified then left) — together they make "join checked".
        const vmatch = vArr.filter((u) => u.creatorId === c.creatorId && u.guildId === c.guildId && roleIds.includes(u.roleId || null));
        const leftMatch = jArr.filter((r) => r.status === 'left' && r.creatorId === c.creatorId && r.cardGuildId === c.guildId && roleIds.includes(r.roleId || null));
        const stayed = winOf(vmatch, 'timestamp', 'id');
        const leftW = winOf(leftMatch, 'ts', 'userId');
        const checked = { hour: stayed.hour + leftW.hour, day: stayed.day + leftW.day, week: stayed.week + leftW.week };

        // Average delay: for each successful verification, match the user's
        // latest first-click at or before it (clicks are pruned to a week).
        const byUser = {};
        for (const e of cards.clicksForKeyMulti(c.guildId, roleIds, c.creatorId)) (byUser[e.u] ||= []).push(e.t);
        for (const u of Object.keys(byUser)) byUser[u].sort((a, b) => a - b);
        const verifyEvents = [
            ...vmatch.map((u) => ({ u: u.id, t: Number(u.timestamp) || 0 })),
            ...leftMatch.map((r) => ({ u: r.userId, t: Number(r.ts) || 0 }))
        ];
        const deltas = [];
        for (const ve of verifyEvents) {
            const clicks = byUser[ve.u];
            if (!clicks || !ve.t) continue;
            let best = null;
            for (const t of clicks) { if (t <= ve.t) best = t; else break; }
            if (best != null && ve.t - best >= 0) { deltas.push(ve.t - best); globalDeltas.push(ve.t - best); }
        }
        const avgVerifySeconds = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length / 1000) : null;
        const rinfo = c.deletedAt ? cards.restoreInfo(clients, c) : null;
        return {
            messageId: c.messageId,
            channelId: c.channelId,
            guildId: c.guildId,
            guildName: guildNameOf(clients, c.guildId),
            guildIcon: guildIconOf(clients, c.guildId),
            channelName: channelNameOf(clients, c.channelId),
            creatorId: c.creatorId || null,
            creatorName: userNameOf(clients, c.creatorId),
            roleId: rid,
            roleName: roleNameOf(clients, c.guildId, rid),
            description: c.description || cards.DEFAULT_DESCRIPTION,
            customDescription: Boolean(c.description),
            link: (c.guildId && c.channelId) ? `https://discord.com/channels/${c.guildId}/${c.channelId}/${c.messageId}` : null,
            createdAt: c.createdAt || 0,
            avgVerifySeconds,
            deletedAt: c.deletedAt || 0,
            deletedBy: c.deletedBy || null,
            deletedByName: c.deletedBy ? userNameOf(clients, c.deletedBy) : null,
            canRestore: rinfo ? rinfo.can : false,
            restoreReason: rinfo ? rinfo.reason : null,
            // Funnel: started (first click) → join checked (2nd click) → stayed.
            stats: { clicks: cards.clickWindowsMulti(c.guildId, roleIds, c.creatorId, now), checked, stayed }
        };
    });
    const avgVerifySeconds = globalDeltas.length
        ? Math.round(globalDeltas.reduce((a, b) => a + b, 0) / globalDeltas.length / 1000) : null;
    return { list, avgVerifySeconds };
}


const DOCS = {
    name: 'Verification API',
    auth: 'Send your API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    note: 'Your bot behaves exactly like a network verification bot. You only run verifications; ad text, rate and campaigns are controlled by the owner — you cannot set them. Payouts are earned only through verified joins.',
    endpoints: {
        'GET /api/ad': 'The ad to show on your server: ?serverId=<your guild>. Returns { adText, fallbackText, sponsor:{guildId,name,invite}|null }. It is the owner\'s per-server ad if set for your server, else a paid buyer campaign, else the global ad — same rule and priority as every network bot. adText null → no ad; show fallbackText (the network\'s no-ad message) if set, then just verify.',
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
    if (!isAllowedOrigin(origin)) {
        // A real browser hitting from a host we don't whitelist → its credentialed
        // calls are blocked and the user bounces. Surface it so it's diagnosable.
        if (origin) console.warn('[CORS] blocked credentialed origin:', origin, '(allowed:', ADMIN_ORIGINS.join(', ') + ')');
        return {};
    }
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin'
    };
}

// Buyer session from EITHER the Authorization: Bearer token (localStorage-based,
// works when third-party cookies are blocked) OR the cookie. The token and the
// cookie carry the same signed session, so both paths are equivalent.
function bearerToken(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function buyerSessionOf(req) {
    return adminAuth.verifyBuyerSession(bearerToken(req))
        || adminAuth.verifyBuyerSession(adminAuth.readBuyerCookie(req.headers.cookie));
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

// Channel name across the fleet caches (for the verification-card list).
function channelNameOf(clients, cid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const ch = c.channels?.cache?.get(String(cid));
        if (ch?.name) return ch.name;
    }
    return null;
}
// Role name within a guild across the fleet caches.
function roleNameOf(clients, gid, rid) {
    if (!rid) return null;
    for (const c of Array.isArray(clients) ? clients : []) {
        const r = c.guilds?.cache?.get(String(gid))?.roles?.cache?.get(String(rid));
        if (r?.name) return r.name;
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
// The user's Discord avatar URL across the fleet caches (null → frontend uses a
// letter fallback).
function userAvatarOf(clients, uid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const u = c.users?.cache?.get(String(uid));
        if (u) { try { return u.displayAvatarURL({ size: 64, extension: 'png' }); } catch { return null; } }
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
        const kind = adminAuth.verifyState(state); // 'admin' | 'buyer' | 'partner' | 'investor' | null
        const dest = kind === 'buyer' ? '/order/' : kind === 'partner' ? '/partner/' : kind === 'investor' ? '/investor/' : '/admin/';
        const back = adminAuth.adminOrigin() + dest;
        if (!code || !kind) {
            console.warn(`[OAUTH] denied: ${!code ? 'no code' : 'bad/expired state'} (kind=${kind || '-'})`);
            res.writeHead(302, { Location: back + '?login=denied' });
            return res.end();
        }
        let uid = null;
        try { uid = await adminAuth.resolveOauthUser(code); }
        catch (e) { console.warn('[OAUTH] denied: code exchange failed —', e && e.message); uid = null; }
        if (!uid) { res.writeHead(302, { Location: back + '?login=denied' }); return res.end(); }

        // Single sign-on across every cabinet: one successful login unlocks all
        // pages the user is entitled to. Always issue the shared user (buyer)
        // session — that opens the order, partner and investor cabinets for any
        // Discord user. If the user is also an owner/admin, additionally issue
        // the admin session so the admin panel opens too, without a second login.
        const role = adminAuth.roleOf(uid);
        // An explicit admin-panel login by a non-admin is still a denial for that
        // page — but they keep the buyer session so the other cabinets work.
        if (kind === 'admin' && !role) {
            res.writeHead(302, { Location: back + '?login=denied', 'Set-Cookie': adminAuth.buyerCookieHeader(adminAuth.issueBuyerSession(uid)) });
            return res.end();
        }
        const buyerToken = adminAuth.issueBuyerSession(uid);
        const cookies = [adminAuth.buyerCookieHeader(buyerToken)];
        if (role) cookies.push(adminAuth.sessionCookieHeader(adminAuth.issueSession(uid, role)));
        // Also hand the token to the frontend via the URL fragment (never sent to
        // servers, stripped immediately) so login survives third-party-cookie
        // blocking: the page stores it and sends it as a Bearer header.
        res.writeHead(302, { Location: back + '#t=' + encodeURIComponent(buyerToken), 'Set-Cookie': cookies });
        return res.end();
    }
    if (path === '/admin/logout' && req.method === 'POST') {
        // Unified logout: clear BOTH sessions (see the cabinet logouts).
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': [adminAuth.sessionCookieHeader('', { clear: true }), adminAuth.buyerCookieHeader('', { clear: true })] });
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
    // Record a mutating panel action against whoever is signed in.
    const auditDo = (action, detail) => audit.logAction(session.userId, action, detail);

    // Owner-only: read the admin action audit log.
    if (path === '/admin/audit' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const url = new URL(req.url, 'http://x');
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
        const entries = audit.recent(limit).map((e) => ({ ...e, userName: userNameOf(clients, e.userId) }));
        return send(res, 200, { entries }, cors);
    }

    // Partner activity log across ALL partners, with filters (by partner, by
    // verifying user, by server, by type/reason, by period). Any admin may read.
    if (path === '/admin/activity' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const periodMap = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
        const pm = periodMap[q.get('period')];
        const events = partnerlog.applyFilters(partnerlog.allEvents(), {
            type: q.get('type') || null,
            reason: q.get('reason') || null,
            server: /^\d{17,20}$/.test(q.get('server') || '') ? q.get('server') : null,
            user: /^\d{17,20}$/.test(q.get('user') || '') ? q.get('user') : null,
            partner: /^\d{17,20}$/.test(q.get('partner') || '') ? q.get('partner') : null,
            since: pm ? Date.now() - pm : 0,
            sort: q.get('sort') || null,
            limit: Math.min(1000, Number(q.get('limit')) || 400)
        });
        const servers = {}, users = {}, partners = {};
        for (const e of events) {
            if (e.guildId && !(e.guildId in servers)) servers[e.guildId] = guildNameOf(clients, e.guildId);
            if (e.sponsorGuildId && !(e.sponsorGuildId in servers)) servers[e.sponsorGuildId] = guildNameOf(clients, e.sponsorGuildId);
            if (e.userId && !(e.userId in users)) users[e.userId] = userNameOf(clients, e.userId);
            if (e.creatorId && !(e.creatorId in partners)) partners[e.creatorId] = userNameOf(clients, e.creatorId);
        }
        return send(res, 200, { events, servers, users, partners }, cors);
    }

    // Owner-only: fleet health (monitoring).
    if (path === '/admin/health' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const bots = (Array.isArray(clients) ? clients : []).map((c) => ({
            id: c.user?.id || null,
            tag: c.user?.tag || null,
            online: Boolean(c.isReady?.()),
            ping: Math.round(Number(c.ws?.ping) >= 0 ? c.ws.ping : -1),
            guilds: c.guilds?.cache?.size || 0,
            uptimeMs: c.uptime || 0
        })).sort((a, b) => (b.guilds - a.guilds));
        return send(res, 200, {
            bots,
            online: bots.filter((b) => b.online).length,
            total: bots.length,
            alertChannel: Boolean(process.env.ALERT_CHANNEL),
            backup: { last: backup.getLastRun(), offsite: Boolean(backup.BACKUP_CHANNEL) },
            serverTime: Date.now()
        }, cors);
    }

    // Owner-only: run a backup now.
    if (path === '/admin/backup' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const r = await backup.runOnce(clients).catch((e) => ({ error: e.message }));
        auditDo('backup.manual', r?.offsite ? 'local+offsite' : 'local');
        return send(res, 200, { ok: true, result: r }, cors);
    }

    // Owner-only: financial reconciliation & solvency.
    if (path === '/admin/finance' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const settings = loadJSON('settings.json');
        let owed = 0, negative = 0, withdrawnDone = 0, withdrawnPending = 0, accountsOwed = 0, accountsNeg = 0;
        for (const uid of Object.keys(settings || {})) {
            const b = Number(settings[uid]?.balance) || 0;
            if (b > 0) { owed += b; accountsOwed++; }
            else if (b < 0) { negative += b; accountsNeg++; }
            for (const w of (Array.isArray(settings[uid]?.withdrawals) ? settings[uid].withdrawals : [])) {
                if (w.status === 'completed') withdrawnDone += Number(w.amount) || 0;
                else withdrawnPending += Number(w.amount) || 0;
            }
        }
        const jl = loadJSON('joinlinks.json', []);
        let paidOutJoins = 0, clawedBack = 0;
        for (const r of Array.isArray(jl) ? jl : []) {
            if (r.status === 'joined' || r.status === 'settled') paidOutJoins += Number(r.amount) || 0;
            else if (r.status === 'left') clawedBack += Number(r.amount) || 0;
        }
        // Ad sales (what buyers paid) and where undistributed money sits:
        // prepaid wallet balances + paid-but-not-yet-delivered campaign value.
        const verifiedF = loadJSON('verified.json', []);
        let prepaidUndelivered = 0;
        for (const c of Object.values(campaigns.loadCampaigns())) {
            if (!c || c.status !== 'active') continue;
            const rem = Math.max(0, (Number(c.purchased) || 0) - campaigns.delivered(c, verifiedF));
            const perJoin = (Number(c.purchased) > 0) ? (Number(c.price) || 0) / c.purchased : 0;
            prepaidUndelivered += rem * perJoin;
        }
        const cryptoBal = await cryptoUsdtBalance();
        return send(res, 200, {
            owed: money(owed), accountsOwed,
            negative: money(negative), accountsNeg,
            withdrawnDone: money(withdrawnDone), withdrawnPending: money(withdrawnPending),
            paidOutJoins: money(paidOutJoins), clawedBack: money(clawedBack),
            adSales: sales.salesWindows(),
            walletsHeld: wallet.totalHeld(),
            prepaidUndelivered: money(prepaidUndelivered),
            cryptoBalance: cryptoBal, solvency: cryptoBal != null ? money(cryptoBal - owed) : null,
            solvent: cryptoBal != null ? cryptoBal >= owed : null
        }, cors);
    }

    // Owner-only: business KPIs (#12) + ad inventory / overselling (#8).
    if (path === '/admin/bi' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const now = Date.now();
        const WEEK = 604800000;
        const jl = loadJSON('joinlinks.json', []);
        const jArr = Array.isArray(jl) ? jl : [];
        const paid = jArr.filter((r) => r.status === 'joined' || r.status === 'settled');

        // Weekly revenue & joins, last 8 weeks (oldest→newest).
        const weeks = [];
        for (let i = 7; i >= 0; i--) {
            const start = now - (i + 1) * WEEK, end = now - i * WEEK;
            let rev = 0, joins = 0;
            for (const r of paid) {
                const t = Number(r.ts) || 0;
                if (t > start && t <= end) { rev += Number.isFinite(Number(r.revenue)) ? Number(r.revenue) : REVENUE_PER_JOIN; joins++; }
            }
            weeks.push({ revenue: money(rev), joins });
        }

        const partners7 = new Set(), partners30 = new Set();
        for (const r of paid) { const t = Number(r.ts) || 0; if (t > now - WEEK) partners7.add(r.creatorId); if (t > now - 4 * WEEK) partners30.add(r.creatorId); }
        const joins7 = paid.filter((r) => (Number(r.ts) || 0) > now - WEEK).length;
        const joins30 = paid.filter((r) => (Number(r.ts) || 0) > now - 4 * WEEK).length;
        const left30 = jArr.filter((r) => r.status === 'left' && (Number(r.leftAt || r.ts) || 0) > now - 4 * WEEK).length;
        const churn = (joins30 + left30) > 0 ? left30 / (joins30 + left30) : 0;
        let rev30 = 0; for (const r of paid) if ((Number(r.ts) || 0) > now - 4 * WEEK) rev30 += Number.isFinite(Number(r.revenue)) ? Number(r.revenue) : REVENUE_PER_JOIN;

        const camps = Object.values(campaigns.loadCampaigns());
        const activeCamps = camps.filter((c) => c.status === 'active');
        const buyers30 = new Set(camps.filter((c) => (Number(c.paidAt || c.createdAt) || 0) > now - 4 * WEEK).map((c) => c.buyerId));

        // Inventory: realized join throughput vs unmet campaign demand.
        const verified = loadJSON('verified.json', []);
        let demand = 0;
        for (const c of activeCamps) demand += Math.max(0, (Number(c.purchased) || 0) - campaigns.delivered(c, verified));
        const capacityPerDay = joins7 / 7;
        const coverageDays = capacityPerDay > 0 ? demand / capacityPerDay : null;

        return send(res, 200, {
            weeks,
            revenue30: money(rev30),
            adSales: sales.salesWindows(),
            activePartners7: partners7.size, activePartners30: partners30.size,
            joins7, joins30,
            churnPct: +(churn * 100).toFixed(1),
            activeCampaigns: activeCamps.length, buyers30: buyers30.size,
            inventory: {
                demand,
                capacityPerDay: Math.round(capacityPerDay),
                coverageDays: coverageDays != null ? +coverageDays.toFixed(1) : null,
                oversold: coverageDays != null && coverageDays > 14
            }
        }, cors);
    }

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
        // "С рекламой" = only PAID verifications: an entry carries an adKey
        // exactly when an ad was shown and it wasn't a duplicate join (i.e. a
        // payout accrued). Entries tagged noAd (no ad shown / duplicate) belong
        // to the "Без рекламы" side and must not inflate the with-ads numbers.
        const paidEntries = entries.filter((u) => u.adKey);
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

        // Per sponsor server: is its ad being shown on the network right now?
        // We stamp sponsorshow.json each time a join-check ad for a sponsor is
        // actually displayed (index.js). "Not showing" = no display for a
        // while — that's when the owner's clawback opt-out applies. Drives the
        // control in the Statistics table.
        const shows = loadJSON('sponsorshow.json', {});
        const SHOW_STALE_MS = Number(process.env.SPONSOR_SHOW_STALE_MS) || 30 * 60 * 1000;
        const adShowingOf = (gid) => (Date.now() - (Number(shows?.[gid]) || 0)) <= SHOW_STALE_MS;
        const clawOffCfg = (cfg.clawbackOffAfterComplete && typeof cfg.clawbackOffAfterComplete === 'object') ? cfg.clawbackOffAfterComplete : {};

        // Group PAID entries for the with-ads numbers; keep a row for guilds
        // that only have organic (no-ad) activity so they still show in the
        // "Без рекламы" mode.
        const paidByGuild = {};
        for (const u of paidEntries) (paidByGuild[u.guildId] ||= []).push(u);
        const statGuildIds = new Set([...Object.keys(paidByGuild), ...Object.keys(noAdByGuild)]);
        const perGuild = [...statGuildIds].map((gid) => {
            const net = verifStats(paidByGuild[gid] || []);
            const lw = leftWinOf(leftByGuild[gid] || []);
            const gross = { hour: net.hour + lw.hour, day: net.day + lw.day, week: net.week + lw.week, month: net.month + lw.month, total: net.total + lw.total };
            const noAd = noAdByGuild[gid] ? verifStats(noAdByGuild[gid]) : { ...ZERO };
            return { gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), ...net, gross, noAd, clawbackOff: Boolean(clawOffCfg[gid]), adShowing: adShowingOf(gid) };
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
                perGuild.push({ gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), hour: 0, day: 0, week: 0, month: 0, total: 0, gross: leftWinOf(leftByGuild[gid] || []), noAd: { ...ZERO }, clawbackOff: Boolean(clawOffCfg[gid]), adShowing: adShowingOf(gid) });
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
        // 'joined' (still-standing) and 'settled' (kept after a post-completion
        // leave, money not clawed back) records count — those joins were sold.
        // Clawed-back leavers ('left') don't sell.
        const joinedRecs = (Array.isArray(joinlinksRaw) ? joinlinksRaw : []).filter((r) => r && (r.status === 'joined' || r.status === 'settled'));
        const pWin = { day: 0, week: 0, month: 0, total: 0 }; // net profit
        const rWin = { day: 0, week: 0, month: 0, total: 0 }; // revenue from joins
        const cWin = { day: 0, week: 0, month: 0, total: 0 }; // partner payouts
        const aWin = { day: 0, week: 0, month: 0, total: 0 }; // acquiring fee on those payouts
        const mWin = { day: 0, week: 0, month: 0, total: 0 }; // manager margin (retail − our price)
        for (const r of joinedRecs) {
            const amt = Number(r.amount) || 0;
            // Per-join revenue is stored on the record for manager sales
            // ($9/100); older/house-ad joins fall back to the standard $0.10.
            // The manager's margin = retail minus what we actually charged them
            // — foregone revenue, shown as a "manager cost" line.
            const rev = Number.isFinite(Number(r.revenue)) ? Number(r.revenue) : REVENUE_PER_JOIN;
            const mgrMargin = Math.max(0, REVENUE_PER_JOIN - rev);
            const acq = amt * ACQUIRING_RATE;
            const prof = rev - amt - acq;
            const wins = [['total', true], ['day', r.ts > now - 86400000], ['week', r.ts > now - 604800000], ['month', r.ts > now - 2592000000]];
            for (const [k, inWin] of wins) if (inWin) { rWin[k] += rev; cWin[k] += amt; aWin[k] += acq; mWin[k] += mgrMargin; pWin[k] += prof; }
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
            managerCost: roundWin(mWin),
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
        // The limit counter counts UNIQUE joiners (one person = one invite),
        // over the full verified list so it matches the in-Discord enforcement
        // — not the active-guild-filtered `entries` used for display windows.
        const verifiedArr = Array.isArray(verified) ? verified : [];
        const statsSinceReset = (key) => {
            if (!key) return { count: 0, firstAt: 0, lastAt: 0 };
            const since = Number(limits[key]?.resetAt) || 0;
            let firstAt = 0, lastAt = 0;
            for (const u of verifiedArr) {
                if (u.adKey !== key || u.timestamp <= since) continue;
                if (!firstAt || u.timestamp < firstAt) firstAt = u.timestamp;
                if (u.timestamp > lastAt) lastAt = u.timestamp;
            }
            return { count: joinerCount(verifiedArr, key, since), firstAt, lastAt };
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
                // Does the ad contain a Discord invite at all? An on-air ad with
                // an invite but no join-check means the invite points to a
                // server no network bot is on → paid as plain clicks, no
                // per-join verification. That's what the top banner warns about.
                const hasInvite = extractInviteCodes(text).length > 0;
                const reset = Number(limits[key]?.resetAt) || 0;
                // The limit counter + "Впервые" measure from the last reset.
                const st = reset ? statsSinceReset(key) : { count: c.total, firstAt: creatives[key]?.firstSeenAt || 0 };
                return {
                    key, text, active, joinMode, hasInvite,
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

        // On-air ads whose invite points to a server no network bot is on:
        // there's no join-check, so they pay as plain clicks ($1/100) instead
        // of confirmed joins ($5–7/100). Surface them for a top-of-panel
        // warning so the owner can add the bot (or fix the link).
        const noJoinCheckAds = adCreatives
            .filter((c) => c.active && c.hasInvite && !c.joinMode)
            .map((c) => ({ key: c.key, text: c.text, guilds: c.guilds }));

        // Gross vs "stays" for the headline cards — paid verifications only,
        // same leftRecs source as the per-guild table above.
        const netStats = verifStats(paidEntries);
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
            clawbackOffAfterComplete: clawOffCfg,
            fallbackText: typeof cfg.fallbackText === 'string' ? cfg.fallbackText : '',
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
            adCreatives,
            noJoinCheckAds
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
        auditDo(body?.remove ? 'admin.remove' : 'admin.add', id);
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

        // One O(n) pass over verified.json — count PAID verifications per
        // creator (adKey set = a join-check join actually paid; no-ad and
        // duplicate verifications aren't paid, so they don't count).
        const vCount = {};
        for (const u of Array.isArray(verified) ? verified : []) {
            if (u.roleId && u.adKey && u.creatorId) vCount[u.creatorId] = (vCount[u.creatorId] || 0) + 1;
        }
        const nowTs = Date.now();

        let users = Object.keys(settings).map((uid) => {
            const s = settings[uid] || {};
            const withdrawals = Array.isArray(s.withdrawals) ? s.withdrawals : [];
            const withdrawnTotal = money(withdrawals
                .filter((w) => w.status === 'completed')
                .reduce((sum, w) => sum + (Number(w.amount) || 0), 0));
            // Join-check rate ($ per 100 joins). While a referral boost is
            // active it acts as a floor of BOOST_RATE; report the time left.
            const baseJoin = Number.isFinite(Number(s.joinBid)) ? Number(s.joinBid) : 5;
            const boosted = boostActive(s);
            const joinRate = boosted ? Math.max(baseJoin, BOOST_RATE) : baseJoin;
            const boostLeftMs = boosted ? Math.max(0, BOOST_MS - (nowTs - Number(s.referrerAt || 0))) : 0;
            return {
                userId: uid,
                username: userNameOf(clients, uid),
                balance: money(s.balance),
                requisites: (s.requisites || '').trim(),
                hasRequisites: Boolean((s.requisites || '').trim()),
                bid: getBid(s),
                joinBid: baseJoin,
                joinRate,
                boosted,
                boostLeftMs,
                refBonusAccrued: money(s.refBonusAccrued),
                autoPayout: Boolean(s.autoPayout),
                autoTransfer: Boolean(s.autoTransfer),
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
            rate: (u) => u.joinRate,
            bid: (u) => u.joinRate
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
        // Paid verifications only (adKey set), same rule as the list + /bal.
        const mine = (Array.isArray(verified) ? verified : []).filter((u) => u.creatorId === userId && u.roleId && u.adKey);
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

        const baseJoinD = Number.isFinite(Number(s.joinBid)) ? Number(s.joinBid) : 5;
        const boostedD = boostActive(s);
        return send(res, 200, {
            userId,
            username: userNameOf(clients, userId),
            balance: money(s.balance),
            requisites: (s.requisites || '').trim(),
            bid: getBid(s),
            joinBid: baseJoinD,
            joinRate: boostedD ? Math.max(baseJoinD, BOOST_RATE) : baseJoinD,
            boosted: boostedD,
            boostLeftMs: boostedD ? Math.max(0, BOOST_MS - (Date.now() - Number(s.referrerAt || 0))) : 0,
            refBonusAccrued: money(s.refBonusAccrued),
            autoPayout: Boolean(s.autoPayout),
            autoTransfer: Boolean(s.autoTransfer),
            tgUserId: s.tgUserId || null,
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
            auditDo('balance.change', `${userId}: ${delta > 0 ? '+' : ''}${delta} → $${s.balance}`);
            if (delta > 0) maybeAutoWithdraw(clients, userId).catch(() => null);
            return send(res, 200, { ok: true, balance: s.balance }, cors);
        }
        if (field === 'bid') {
            const bid = Number(body.bid);
            if (!Number.isFinite(bid) || bid < 0) return send(res, 400, { error: 'bad bid' }, cors);
            s.bid = +bid.toFixed(4);
            saveJSON('settings.json', settings);
            auditDo('rate.bid', `${userId}: $${s.bid}/100 clicks`);
            return send(res, 200, { ok: true, bid: s.bid }, cors);
        }
        if (field === 'joinbid') {
            const bid = Number(body.joinBid);
            if (!Number.isFinite(bid) || bid < 0) return send(res, 400, { error: 'bad joinBid' }, cors);
            s.joinBid = +bid.toFixed(4);
            saveJSON('settings.json', settings);
            auditDo('rate.joinbid', `${userId}: $${s.joinBid}/100 joins`);
            return send(res, 200, { ok: true, joinBid: s.joinBid }, cors);
        }
        if (field === 'autopayout') {
            s.autoPayout = Boolean(body.autoPayout);
            saveJSON('settings.json', settings);
            auditDo('autopayout', `${userId}: ${s.autoPayout ? 'on' : 'off'}`);
            return send(res, 200, { ok: true, autoPayout: s.autoPayout }, cors);
        }
        // Manual credit to the user's investment account.
        if (field === 'investtopup') {
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: 'amount must be > 0' }, cors);
            if (amount > 1_000_000) return send(res, 400, { error: 'amount too large' }, cors);
            const r = investors.manualTopup(userId, amount);
            if (!r.ok) return send(res, 400, { error: r.error }, cors);
            auditDo('invest.topup', `${userId}: +$${r.amount}`);
            return send(res, 200, { ok: true, amount: r.amount }, cors);
        }
        // Direct-transfer auto-payout (no check): a toggle + the recipient's
        // numeric Telegram id. Can't enable without an id to send to.
        if (field === 'autotransfer') {
            if (body.tgUserId !== undefined) {
                const tg = String(body.tgUserId || '').trim();
                if (tg && !/^\d{5,15}$/.test(tg)) return send(res, 400, { error: 'bad-tg-id' }, cors);
                s.tgUserId = tg || null;
            }
            s.autoTransfer = Boolean(body.autoTransfer);
            if (s.autoTransfer && !s.tgUserId) return send(res, 400, { error: 'tg-id-required' }, cors);
            saveJSON('settings.json', settings);
            auditDo('autotransfer', `${userId}: ${s.autoTransfer ? 'on' : 'off'}${s.tgUserId ? ' tg=' + s.tgUserId : ''}`);
            return send(res, 200, { ok: true, autoTransfer: s.autoTransfer, tgUserId: s.tgUserId || null }, cors);
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
        if (Number.isFinite(limit) && limit > 0) {
            // Preserve resetAt (else saving a limit would undo a counter reset)
            // and re-arm the completion notice for the new limit.
            limits[key] = { ...(limits[key] || {}), limit, setAt: Date.now() };
            delete limits[key].notifiedAt;
        } else {
            delete limits[key];
        }
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
        auditDo('cryptopay.topup', `$${n.toFixed(2)} invoice created`);
        return send(res, 200, { ok: true, url, amount: n.toFixed(2) }, cors);
    }

    // Shares (доли): set a holder's percentage. pct <= 0 removes them.
    // Existing pending/earned accounting is preserved across edits.
    if (path === '/admin/shares' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const uid = String(body?.userId || '');
        if (!/^\d{17,20}$/.test(uid)) return send(res, 400, { error: 'bad user id' }, cors);
        const pct = Number(body?.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return send(res, 400, { error: 'pct must be 0..100' }, cors);
        const cfg = loadShares();
        // Can't hand out more than 100% total — reject if the sum of everyone
        // else's shares plus the new value would exceed 100%.
        if (pct > 0) {
            const others = Object.entries(cfg).reduce((s, [k, v]) => k === uid ? s : s + (Number(v?.pct) || 0), 0);
            if (others + pct > 100 + 1e-6) {
                return send(res, 400, { error: 'exceeds-100', available: +(100 - others).toFixed(2) }, cors);
            }
        }
        if (pct <= 0) delete cfg[uid];
        else cfg[uid] = { ...(cfg[uid] || {}), pct: +pct.toFixed(2), addedAt: cfg[uid]?.addedAt || Date.now() };
        saveJSON('shares.json', cfg);
        auditDo('shares.set', `${uid}: ${cfg[uid]?.pct || 0}%`);
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
        auditDo('kran.server', `${gid}: ${off ? 'closed' : 'open'}`);
        return send(res, 200, { ok: true, gid, off }, cors);
    }

    // Owner-only: for a sponsor server, toggle whether a member leaving AFTER
    // that server's ad campaign has completed still claws back the partner
    // payout. Off (flag set) = keep payouts once the campaign is done.
    if (path === '/admin/leave-clawback-off' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = body?.gid ? String(body.gid) : '';
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        const off = Boolean(body?.off);
        const cfg = loadJSON('siteconfig.json', {});
        if (!cfg.clawbackOffAfterComplete || typeof cfg.clawbackOffAfterComplete !== 'object') cfg.clawbackOffAfterComplete = {};
        if (off) cfg.clawbackOffAfterComplete[gid] = true;
        else delete cfg.clawbackOffAfterComplete[gid];
        cfg.clawbackOffAfterCompleteAt = Date.now();
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
        auditDo('kran.global', off ? 'closed (ads off)' : 'open');
        return send(res, 200, { ok: true, adsOff: off }, cors);
    }

    // The "заглушка" — text shown instead of an ad when there's none.
    if (path === '/admin/fallback' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const cfg = loadJSON('siteconfig.json', {});
        cfg.fallbackText = String(body?.text ?? '').slice(0, 2000);
        cfg.fallbackTextAt = Date.now();
        saveJSON('siteconfig.json', cfg);
        return send(res, 200, { ok: true }, cors);
    }

    // Owner-only: manage the home-page server feed.
    if (path === '/admin/feed' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        return send(res, 200, { servers: feed.loadFeed() }, cors);
    }
    if (path === '/admin/feed' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const raw = String(body?.invite || '').trim();
        const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,32})$/i)
            || raw.match(/^([a-z0-9-]{2,32})$/i);
        if (!m) return send(res, 400, { error: 'bad-invite' }, cors);
        const code = m[1];
        let inv = null;
        for (const c of clients) { inv = await c.fetchInvite(code).catch(() => null); if (inv) break; }
        if (!inv?.guild?.id) return send(res, 400, { error: 'bad-invite' }, cors);
        const list = feed.loadFeed();
        if (list.some((s) => s.code === code || (s.id && s.id === inv.guild.id))) {
            return send(res, 409, { error: 'exists' }, cors);
        }
        list.push(feed.itemFromInvite(inv, code));
        auditDo('feed.add', `${inv.guild.name || ''} (${code})`);
        return send(res, 200, { ok: true, servers: feed.saveFeed(list) }, cors);
    }
    if (path === '/admin/feed' && req.method === 'DELETE') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const code = String(body?.code || '');
        const id = String(body?.id || '');
        if (!code && !id) return send(res, 400, { error: 'bad request' }, cors);
        const list = feed.loadFeed().filter((s) => !((code && s.code === code) || (id && s.id === id)));
        auditDo('feed.remove', code || id);
        return send(res, 200, { ok: true, servers: feed.saveFeed(list) }, cors);
    }

    // Owner-only: verification-card registry + remote management.
    if (path === '/admin/cards' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const { list, avgVerifySeconds } = enrichCards(clients, cards.loadCards());
        const active = list.filter((c) => !c.deletedAt).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const deleted = list.filter((c) => c.deletedAt).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
        return send(res, 200, { cards: active, deletedCards: deleted, avgVerifySeconds }, cors);
    }
    if (path === '/admin/cards/register' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const r = await cards.register(clients, body?.ref).catch((e) => ({ ok: false, error: e.message }));
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card } : { error: r.error || 'failed' }, cors);
    }
    // Scan the fleet for existing (untracked) cards. POST starts it in the
    // background; GET reports progress so the panel can poll.
    if (path === '/admin/cards/scan' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        return send(res, 200, { ok: true, scan: cards.scanAll(clients) }, cors);
    }
    if (path === '/admin/cards/scan' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        return send(res, 200, { scan: cards.getScanState() }, cors);
    }
    if ((path === '/admin/cards/fix' || path === '/admin/cards/republish' || path === '/admin/cards/delete' || path === '/admin/cards/restore') && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        let r;
        const op = path.endsWith('/delete') ? 'delete' : path.endsWith('/fix') ? 'fix' : path.endsWith('/restore') ? 'restore' : 'republish';
        if (op === 'delete') r = await cards.remove(clients, mid, session.userId).catch((e) => ({ ok: false, error: e.message }));
        else r = await cards[op](clients, mid).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) auditDo('card.' + op, mid);
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card || null } : { error: r.error || 'failed' }, cors);
    }
    // Reset a card's verification role: recreate an identical role (perms +
    // channel overwrites + name/colour/icon), repoint the card, delete the old.
    if (path === '/admin/cards/reset-role' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        const r = await cards.resetRole(clients, mid).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) auditDo('card.reset-role', `${mid} ${r.oldRoleId}→${r.newRoleId}`);
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card, roleName: r.roleName } : { error: r.error || 'failed' }, cors);
    }
    // Permanently drop a card from the (deleted) registry.
    if (path === '/admin/cards/purge' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        cards.removeCard(mid);
        return send(res, 200, { ok: true }, cors);
    }
    // On-demand: sweep the fleet for cards whose message is gone.
    if (path === '/admin/cards/verify' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const marked = await cards.sweepDeleted(clients).catch(() => 0);
        return send(res, 200, { ok: true, marked }, cors);
    }
    if (path === '/admin/cards/edit' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        const patch = {};
        if (body.creatorId !== undefined) {
            if (!/^\d{17,20}$/.test(String(body.creatorId))) return send(res, 400, { error: 'bad creator id' }, cors);
            patch.creatorId = String(body.creatorId);
        }
        if (body.roleId !== undefined) {
            const rid = String(body.roleId || '');
            if (rid && !/^\d{17,20}$/.test(rid)) return send(res, 400, { error: 'bad role id' }, cors);
            patch.roleId = rid || null;
        }
        if (body.description !== undefined) patch.description = String(body.description).slice(0, 4000);
        const r = await cards.edit(clients, mid, patch).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) auditDo('card.edit', `${mid} ${Object.keys(patch).join(',')}`);
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card } : { error: r.error || 'failed' }, cors);
    }

    // Owner-only: servers investors may buy invites of. Candidates are servers
    // with an active (non-deleted) verification card; enabling requires one.
    if (path === '/admin/invest-servers' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const cardGuilds = new Set(cards.loadCards().filter((c) => !c.deletedAt && c.guildId).map((c) => String(c.guildId)));
        const enabledIds = investors.loadEnabledServers();
        const enabledSet = new Set(enabledIds);
        const enabled = enabledIds.map((gid) => ({ serverId: gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), hasCard: cardGuilds.has(gid) }));
        const candidates = [...cardGuilds].filter((gid) => !enabledSet.has(gid))
            .map((gid) => ({ serverId: gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid) }))
            .sort((a, b) => (a.name || a.serverId).localeCompare(b.name || b.serverId));
        return send(res, 200, { enabled, candidates }, cors);
    }
    if (path === '/admin/invest-servers' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = String(body?.serverId || '');
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        const hasActiveCard = cards.loadCards().some((c) => !c.deletedAt && String(c.guildId) === gid);
        if (!hasActiveCard) return send(res, 400, { error: 'no-active-card' }, cors);
        investors.addEnabledServer(gid);
        auditDo('invest.server.add', gid);
        return send(res, 200, { ok: true, enabled: investors.loadEnabledServers() }, cors);
    }
    if (path === '/admin/invest-servers' && req.method === 'DELETE') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = String(body?.serverId || '');
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        investors.removeEnabledServer(gid);
        auditDo('invest.server.remove', gid);
        return send(res, 200, { ok: true, enabled: investors.loadEnabledServers() }, cors);
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

// ---------- Alternative login: one-time code via DM ----------
// DM a login code from a fleet bot that shares a server with the user
// (user.send only works with a mutual guild + open DMs — which is exactly the
// "on a server with any of our bots" requirement). Prefers the user's own bot.
async function dmLoginCode(clients, userId, code, botId) {
    const list = Array.isArray(clients) ? clients : [];
    const ordered = botId ? [...list.filter((c) => c.user?.id === botId), ...list.filter((c) => c.user?.id !== botId)] : list;
    // Default English text + a "Translation" button that re-renders the message
    // in the clicking user's Discord client locale (handled in index.js).
    const msg = {
        content: logincodes.renderMessage(code, 'en'),
        components: [{ type: 1, components: [{ type: 2, style: 2, label: '🌐 Translation', custom_id: `login_code_tr:${code}` }] }]
    };
    for (const bot of ordered) {
        try { const u = await bot.users.fetch(userId); await u.send(msg); return true; } catch { /* try the next bot */ }
    }
    return false;
}

// Shared code-login endpoints for every cabinet: <prefix>/code/request and
// <prefix>/code/verify. Returns true once it handled the request. On verify it
// issues the SAME cookies as OAuth (buyer session + admin session when the user
// has a role), so the login is cached and carries freely across all pages.
async function handleLoginCode(req, res, path, clients, cors) {
    if (path.endsWith('/code/request') && req.method === 'POST') {
        const body = await readBody(req);
        const userId = String(body?.userId || '').trim();
        if (!/^\d{17,20}$/.test(userId)) { send(res, 400, { error: 'bad-id' }, cors); return true; }
        const rl = logincodes.canRequest(userId);
        if (!rl.ok) { send(res, 429, { error: 'cooldown', retryAfterSec: Math.ceil(rl.retryAfterMs / 1000) }, cors); return true; }
        const code = logincodes.newCode();
        const botId = (loadJSON('settings.json')[userId] || {}).botId || null;
        const delivered = await dmLoginCode(clients, userId, code, botId).catch(() => false);
        if (!delivered) { send(res, 400, { error: 'no-dm' }, cors); return true; }
        logincodes.save(userId, code);
        send(res, 200, { ok: true, ttlSec: Math.floor(logincodes.CODE_TTL_MS / 1000) }, cors);
        return true;
    }
    if (path.endsWith('/code/verify') && req.method === 'POST') {
        const body = await readBody(req);
        const userId = String(body?.userId || '').trim();
        const code = String(body?.code || '').trim();
        if (!/^\d{17,20}$/.test(userId)) { send(res, 400, { error: 'bad-id' }, cors); return true; }
        const r = logincodes.verify(userId, code);
        if (!r.ok) { console.warn(`[LOGIN-CODE] verify failed for ${userId}: ${r.reason}`); send(res, 400, { error: r.reason, attemptsLeft: r.attemptsLeft }, cors); return true; }
        const role = adminAuth.roleOf(userId);
        const token = adminAuth.issueBuyerSession(userId);
        const cookies = [adminAuth.buyerCookieHeader(token)];
        if (role) cookies.push(adminAuth.sessionCookieHeader(adminAuth.issueSession(userId, role)));
        console.log(`[LOGIN-CODE] verified ${userId} (role=${role || 'none'}); origin=${req.headers.origin || '-'}`);
        // Return the token too: the frontend stores it and sends it as a Bearer
        // header, so login works even when the (third-party) cookie is blocked.
        send(res, 200, { ok: true, token }, { ...cors, 'Set-Cookie': cookies });
        return true;
    }
    return false;
}

// ---------- Buyer order panel ----------
// Self-serve ad buying: Discord login, create an order, pay a CryptoBot
// invoice, then a dashboard with live stats and per-server controls.
async function handleBuyer(req, res, path, clients, config) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!adminAuth.enabled()) return send(res, 503, { error: 'auth not configured' }, cors);

    // OAuth start (top-level nav).
    if (path === '/order/oauth/login' && req.method === 'GET') {
        res.writeHead(302, { Location: adminAuth.oauthAuthorizeUrl(adminAuth.issueState('buyer')) });
        return res.end();
    }
    if (path === '/order/logout' && req.method === 'POST') {
        // Unified logout: clear BOTH sessions so leaving one cabinet signs the
        // user out everywhere (mirrors the single sign-on on login).
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': [adminAuth.buyerCookieHeader('', { clear: true }), adminAuth.sessionCookieHeader('', { clear: true })] });
    }
    if (path === '/order/whoami' && req.method === 'GET') {
        const sess = buyerSessionOf(req);
        return send(res, 200, sess
            ? { authed: true, userId: sess.userId, isOwner: sess.userId === adminAuth.OWNER_ID, isManager: managers.isManager(sess.userId), isAdmin: Boolean(adminAuth.roleOf(sess.userId)) }
            : { authed: false }, cors);
    }
    if (await handleLoginCode(req, res, path, clients, cors)) return;

    const sess = buyerSessionOf(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' }, cors);
    const buyerId = sess.userId;

    if (path === '/order/config' && req.method === 'GET') {
        const isMgr = managers.isManager(buyerId);
        return send(res, 200, {
            pricePer100: isMgr ? managers.PRICE_PER_100 : campaigns.PRICE_PER_100,
            publicPricePer100: campaigns.PRICE_PER_100,
            minJoins: campaigns.MIN_JOINS,
            cryptoEnabled: cryptopay.enabled(),
            isOwner: buyerId === adminAuth.OWNER_ID,
            isManager: isMgr,
            botInviteUrl: process.env.BOT_INVITE_URL || 'https://discord.com/oauth2/authorize?client_id=1522609323090509905&permissions=268435456&scope=bot'
        }, cors);
    }

    // Owner-only: list / add / remove sales managers.
    if (path === '/order/managers' && req.method === 'GET') {
        if (buyerId !== adminAuth.OWNER_ID) return send(res, 403, { error: 'owner only' }, cors);
        return send(res, 200, {
            managers: managers.loadManagers(),
            pricePer100: managers.PRICE_PER_100,
            commissionRate: managers.COMMISSION_RATE
        }, cors);
    }
    if (path === '/order/managers' && req.method === 'PUT') {
        if (buyerId !== adminAuth.OWNER_ID) return send(res, 403, { error: 'owner only' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const uid = String(body?.userId || '');
        if (!/^\d{17,20}$/.test(uid)) return send(res, 400, { error: 'bad user id' }, cors);
        const list = managers.loadManagers();
        const next = body?.remove ? list.filter((x) => x !== uid) : [...list, uid];
        audit.logAction(buyerId, body?.remove ? 'manager.remove' : 'manager.add', uid);
        return send(res, 200, { ok: true, managers: managers.saveManagers(next) }, cors);
    }

    // Wallet: balance + recent top-ups (reconciles pending top-ups first).
    if (path === '/order/wallet' && req.method === 'GET') {
        await wallet.reconcileTopups(buyerId, campaigns.isInvoicePaid).catch(() => null);
        const minTopup = managers.isManager(buyerId) ? managers.MIN_TOPUP : wallet.MIN_TOPUP;
        return send(res, 200, {
            balance: wallet.balanceOf(buyerId),
            topups: wallet.recentTopups(buyerId),
            minTopup,
            cryptoEnabled: cryptopay.enabled()
        }, cors);
    }
    // Top up the wallet via a CryptoBot invoice. Body: { amount }.
    if (path === '/order/wallet/topup' && req.method === 'POST') {
        if (!cryptopay.enabled()) return send(res, 503, { error: 'Оплата временно недоступна' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const amount = +(Number(body?.amount) || 0).toFixed(2);
        const minTopup = managers.isManager(buyerId) ? managers.MIN_TOPUP : wallet.MIN_TOPUP;
        if (!(amount >= minTopup)) return send(res, 400, { error: 'min-topup' }, cors);
        let invoice = null;
        try { invoice = await cryptopay.createUsdtInvoice(amount.toFixed(2), { description: `Пополнение баланса Vemoni на $${amount.toFixed(2)}`.slice(0, 1024) }); }
        catch (e) { return send(res, 502, { error: 'invoice-failed' }, cors); }
        const invoiceUrl = invoice.bot_invoice_url || invoice.mini_app_invoice_url || invoice.web_app_invoice_url || invoice.pay_url;
        wallet.addTopup(buyerId, { invoiceId: invoice.invoice_id, amount, status: 'pending', createdAt: Date.now() });
        return send(res, 200, { ok: true, invoiceUrl, amount }, cors);
    }

    // Create a campaign, paid instantly from the wallet balance. Body: { invite, joins }.
    if (path === '/order/create' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const rawInvite = String(body?.invite || '').trim();
        const m = rawInvite.match(/^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,32})$/i)
            || rawInvite.match(/^([a-z0-9-]{2,32})$/i);
        if (!m) return send(res, 400, { error: 'bad-invite' }, cors);
        const inviteCode = m[1];
        const joins = Math.floor(Number(body?.joins));
        if (!Number.isFinite(joins) || joins < campaigns.MIN_JOINS) return send(res, 400, { error: 'min-joins' }, cors);

        let inv = null;
        for (const c of clients) { inv = await c.fetchInvite(inviteCode).catch(() => null); if (inv) break; }
        const sponsorGuildId = inv?.guild?.id || null;
        if (!sponsorGuildId) return send(res, 400, { error: 'bad-invite' }, cors);

        const isMgr = managers.isManager(buyerId);
        const pricePer100 = isMgr ? managers.PRICE_PER_100 : campaigns.PRICE_PER_100;
        const price = +(joins * pricePer100 / 100).toFixed(2);

        // Pay from the prepaid wallet (reconcile pending top-ups first).
        await wallet.reconcileTopups(buyerId, campaigns.isInvoicePaid).catch(() => null);
        const bal = wallet.balanceOf(buyerId);
        if (bal < price) return send(res, 402, { error: 'insufficient', balance: bal, price, shortfall: +(price - bal).toFixed(2) }, cors);
        if (wallet.debit(buyerId, price) === null) return send(res, 402, { error: 'insufficient', balance: bal, price }, cors);

        const camps = campaigns.loadCampaigns();
        const id = campaigns.newId();
        camps[id] = {
            id, buyerId,
            invite: `https://discord.gg/${inviteCode}`,
            sponsorGuildId, serverName: inv.guild?.name || null,
            purchased: joins, price, pricePer100,
            managerId: isMgr ? buyerId : null,
            commissionRate: isMgr ? managers.COMMISSION_RATE : 0,
            status: 'active', paidFromWallet: true,
            disabledGuilds: [], paused: false,
            createdAt: Date.now(), paidAt: Date.now(), completedAt: 0
        };
        campaigns.saveCampaigns(camps);
        sales.recordSale({ campaignId: id, buyerId, amount: price, joins, sponsorGuildId, managerId: isMgr ? buyerId : null, via: 'wallet' });
        return send(res, 200, { ok: true, price, balance: wallet.balanceOf(buyerId), campaign: campaigns.publicView(camps[id]) }, cors);
    }

    // My campaigns (reconcile first: purges dead legacy unpaid campaigns and
    // completes finished ones).
    if (path === '/order/campaigns' && req.method === 'GET') {
        await campaigns.reconcile(clients).catch(() => null);
        const camps = campaigns.loadCampaigns();
        const verified = loadJSON('verified.json', []);
        const joinlinks = loadJSON('joinlinks.json', []);
        const fleet = campaigns.fleetGuildIds(clients);
        const mine = Object.values(camps).filter((c) => c.buyerId === buyerId && c.status !== 'pending_payment')
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .map((c) => ({ ...campaigns.publicView(c, verified), botPresent: campaigns.botPresent(c, fleet), retention: campaigns.retention(c, verified, joinlinks) }));
        return send(res, 200, { campaigns: mine }, cors);
    }

    // Per-server delivery breakdown for one campaign.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/servers') && req.method === 'GET') {
        const id = path.slice('/order/campaigns/'.length, -('/servers'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || c.buyerId !== buyerId) return send(res, 404, { error: 'not found' }, cors);
        const keys = campaigns.campaignAdKeys(c);
        const verified = loadJSON('verified.json', []);
        const perGuild = {};
        for (const u of Array.isArray(verified) ? verified : []) {
            if (!keys.has(u.adKey) || (c.paidAt && u.timestamp < c.paidAt)) continue;
            (perGuild[u.guildId] ||= new Set()).add(u.id);
        }
        const servers = Object.entries(perGuild)
            .map(([gid, set]) => ({ gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), count: set.size, disabled: (c.disabledGuilds || []).includes(gid) }))
            .sort((a, b) => b.count - a.count);
        return send(res, 200, { servers }, cors);
    }

    // Pause / resume a campaign.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/pause') && req.method === 'POST') {
        const id = path.slice('/order/campaigns/'.length, -('/pause'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || c.buyerId !== buyerId) return send(res, 404, { error: 'not found' }, cors);
        // Only a running campaign can be paused/resumed — pausing a complete or
        // invalid one would show a misleading "active, not paused" state.
        if (c.status !== 'active') return send(res, 400, { error: 'not-active' }, cors);
        const body = await readBody(req);
        c.paused = Boolean(body?.paused);
        campaigns.saveCampaigns(camps);
        return send(res, 200, { ok: true, paused: c.paused }, cors);
    }

    // Toggle a server on/off for this campaign.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/server') && req.method === 'PUT') {
        const id = path.slice('/order/campaigns/'.length, -('/server'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || c.buyerId !== buyerId) return send(res, 404, { error: 'not found' }, cors);
        const body = await readBody(req);
        const gid = String(body?.gid || '');
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        if (!Array.isArray(c.disabledGuilds)) c.disabledGuilds = [];
        if (body?.disabled) { if (!c.disabledGuilds.includes(gid)) c.disabledGuilds.push(gid); }
        else c.disabledGuilds = c.disabledGuilds.filter((x) => x !== gid);
        campaigns.saveCampaigns(camps);
        return send(res, 200, { ok: true, disabledGuilds: c.disabledGuilds }, cors);
    }

    // Change a running campaign's invite link mid-flight (e.g. the old one
    // expired). Validates that the new link actually resolves AND that a
    // network bot is on its server (otherwise joins can't be verified).
    // Delivery progress is preserved — the outgoing ad-key is kept so joins
    // already delivered still count toward the purchased total.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/invite') && req.method === 'PUT') {
        const id = path.slice('/order/campaigns/'.length, -('/invite'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || c.buyerId !== buyerId) return send(res, 404, { error: 'not found' }, cors);
        // Allow the swap for 'active' AND 'invalid' — swapping to a working invite
        // is exactly how a buyer self-recovers a campaign the sweep killed on a
        // dead/temporarily-revoked invite. (complete/pending stay closed.)
        if (c.status !== 'active' && c.status !== 'invalid') return send(res, 400, { error: 'not-active' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const rawInvite = String(body?.invite || '').trim();
        const m = rawInvite.match(/^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,32})$/i)
            || rawInvite.match(/^([a-z0-9-]{2,32})$/i);
        if (!m) return send(res, 400, { error: 'bad-invite' }, cors);
        const inviteCode = m[1];
        // Link must resolve (works)…
        let inv = null;
        for (const cl of clients) { inv = await cl.fetchInvite(inviteCode).catch(() => null); if (inv) break; }
        const newGuildId = inv?.guild?.id || null;
        if (!newGuildId) return send(res, 400, { error: 'bad-invite' }, cors);
        // …and a network bot must be on the target server (join-checkable).
        const fleet = campaigns.fleetGuildIds(clients);
        if (!fleet.has(newGuildId)) return send(res, 400, { error: 'no-bot' }, cors);

        let dirty = false;
        const newInvite = `https://discord.gg/${inviteCode}`;
        if (newInvite !== c.invite) {
            const oldKey = campaigns.campaignAdKey(c);
            if (!Array.isArray(c.adKeys)) c.adKeys = [];
            if (oldKey && !c.adKeys.includes(oldKey)) c.adKeys.push(oldKey);
            c.invite = newInvite;
            c.sponsorGuildId = newGuildId;
            c.serverName = inv.guild?.name || c.serverName || null;
            c.inviteChangedAt = Date.now();
            dirty = true;
        }
        // The invite is confirmed working + join-checkable above, so revive an
        // invalidated campaign back to active (works even if the invite string is
        // unchanged — the previously-dead link now resolves). Force a re-check.
        if (c.status === 'invalid') { c.status = 'active'; c.invalidAt = 0; c.inviteCheckedAt = Date.now(); dirty = true; }
        if (dirty) campaigns.saveCampaigns(camps);
        const verified = loadJSON('verified.json', []);
        return send(res, 200, { ok: true, campaign: campaigns.publicView(camps[id], verified) }, cors);
    }

    return send(res, 404, { error: 'unknown endpoint' }, cors);
}

// ---------- Partner cabinet ----------
// A Discord-login dashboard for partners: earnings, paid verifications, payout
// history, requisites. Same user session cookie as the order panel.
async function handlePartner(req, res, path, clients, config) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!adminAuth.enabled()) return send(res, 503, { error: 'auth not configured' }, cors);

    if (path === '/partner/oauth/login' && req.method === 'GET') {
        res.writeHead(302, { Location: adminAuth.oauthAuthorizeUrl(adminAuth.issueState('partner')) });
        return res.end();
    }
    if (path === '/partner/logout' && req.method === 'POST') {
        // Unified logout: clear BOTH sessions so leaving one cabinet signs the
        // user out everywhere (mirrors the single sign-on on login).
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': [adminAuth.buyerCookieHeader('', { clear: true }), adminAuth.sessionCookieHeader('', { clear: true })] });
    }
    if (path === '/partner/whoami' && req.method === 'GET') {
        const sess = buyerSessionOf(req);
        if (!sess) return send(res, 200, { authed: false }, cors);
        return send(res, 200, {
            authed: true, userId: sess.userId,
            name: userNameOf(clients, sess.userId),
            avatar: userAvatarOf(clients, sess.userId),
            isAdmin: Boolean(adminAuth.roleOf(sess.userId))
        }, cors);
    }
    if (await handleLoginCode(req, res, path, clients, cors)) return;

    const sess = buyerSessionOf(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' }, cors);
    const userId = sess.userId;

    // Partner activity log for this partner, with filters (by server, by
    // verifying user, by type/reason, by period, sort order).
    if (path === '/partner/activity' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const periodMap = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
        const pm = periodMap[q.get('period')];
        const events = partnerlog.applyFilters(partnerlog.forPartner(userId), {
            type: q.get('type') || null,
            reason: q.get('reason') || null,
            server: /^\d{17,20}$/.test(q.get('server') || '') ? q.get('server') : null,
            user: /^\d{17,20}$/.test(q.get('user') || '') ? q.get('user') : null,
            since: pm ? Date.now() - pm : 0,
            sort: q.get('sort') || null,
            limit: Math.min(500, Number(q.get('limit')) || 300)
        });
        const servers = {}, users = {};
        for (const e of events) {
            if (e.guildId && !(e.guildId in servers)) servers[e.guildId] = guildNameOf(clients, e.guildId);
            if (e.sponsorGuildId && !(e.sponsorGuildId in servers)) servers[e.sponsorGuildId] = guildNameOf(clients, e.sponsorGuildId);
            if (e.userId && !(e.userId in users)) users[e.userId] = userNameOf(clients, e.userId);
        }
        return send(res, 200, { events, servers, users }, cors);
    }

    if (path === '/partner/me' && req.method === 'GET') {
        const settings = loadJSON('settings.json');
        const s = settings[userId] || {};
        const now = Date.now();

        // Paid verifications (adKey), grouped by server + windows.
        const stats = userStats(userId);

        // Earnings reconciliation from joinlinks (same as the /bal owner view).
        const jl = loadJSON('joinlinks.json', []);
        const mine = (Array.isArray(jl) ? jl : []).filter((r) => r && r.creatorId === userId);
        const r2 = (n) => +((Number(n) || 0).toFixed(2));
        const sumAmt = (arr) => r2(arr.reduce((a, r) => a + (Number(r.amount) || 0), 0));
        const standing = mine.filter((r) => r.status === 'joined' || r.status === 'settled');
        const clawed = mine.filter((r) => r.status === 'left');

        // Per-server, per-window count of joiners who verified but later left
        // (clawed back). Keyed by the card's own server (cardGuildId) so it
        // lines up with the per-guild verification rows, and windowed by the
        // JOIN time (r.ts, same basis as verified.json timestamps) so
        // "joined = stayed + left" is consistent per window.
        const leftByGuild = {};
        for (const r of clawed) {
            const g = r.cardGuildId; if (!g) continue; // only the partner's own card server
            const t = Number(r.ts) || 0;
            const w = (leftByGuild[g] ||= { hour: 0, day: 0, week: 0, month: 0, total: 0 });
            w.total++;
            if (t > now - 3600000) w.hour++;
            if (t > now - 86400000) w.day++;
            if (t > now - 604800000) w.week++;
            if (t > now - 2592000000) w.month++;
        }
        const zeroLeft = { hour: 0, day: 0, week: 0, month: 0, total: 0 };

        const wds = Array.isArray(s.withdrawals) ? s.withdrawals : [];
        const withdrawnDone = r2(wds.filter((w) => w.status === 'completed').reduce((a, w) => a + (Number(w.amount) || 0), 0));

        const baseJoin = Number.isFinite(Number(s.joinBid)) ? Number(s.joinBid) : 5;
        const boosted = boostActive(s);

        return send(res, 200, {
            userId,
            balance: money(s.balance),
            requisites: (s.requisites || '').trim(),
            joinRate: boosted ? Math.max(baseJoin, BOOST_RATE) : baseJoin,
            boosted,
            boostLeftMs: boosted ? Math.max(0, BOOST_MS - (now - Number(s.referrerAt || 0))) : 0,
            referrer: s.referrer || null,
            referralsCount: Array.isArray(s.referrals) ? s.referrals.length : 0,
            refBonusAccrued: money(s.refBonusAccrued),
            autoPayout: Boolean(s.autoPayout),
            autoTransfer: Boolean(s.autoTransfer),
            standingJoins: standing.length,
            standingPaid: sumAmt(standing),
            clawedJoins: clawed.length,
            clawedAmount: sumAmt(clawed),
            withdrawnDone,
            verifications: {
                all: stats.total,
                perGuild: stats.perGuild.map((g) => ({ ...g, name: guildNameOf(clients, g.guildId), left: leftByGuild[g.guildId] || zeroLeft }))
            },
            withdrawals: wds
                .map((w) => ({ id: w.id, amount: money(w.amount), status: w.status, createdAt: w.createdAt || 0, completedAt: w.completedAt || 0 }))
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 300),
            minWithdraw: 10
        }, cors);
    }

    // History of every ad (sponsor) that ran on the partner's server(s), with
    // per-server stats: how many joined via it, how many are still standing,
    // how many left, and how much the partner earned from it. Grouped by the
    // partner's own server (cardGuildId) → sponsor (guildId), from joinlinks.
    if (path === '/partner/ad-history' && req.method === 'GET') {
        const jl = loadJSON('joinlinks.json', []);
        const mine = (Array.isArray(jl) ? jl : []).filter((r) => r && r.creatorId === userId);
        const r2 = (n) => +((Number(n) || 0).toFixed(2));
        const servers = {};
        for (const r of mine) {
            // Group strictly by the partner's OWN card server. Legacy records
            // predating cardGuildId have it null — never fall back to guildId
            // (that's the SPONSOR server, which would show a server the partner
            // has no card on and isn't even a member of).
            const sv = r.cardGuildId;
            if (!sv) continue;
            const sp = r.guildId || 'unknown';
            const standing = r.status === 'joined' || r.status === 'settled';
            const left = r.status === 'left';
            const amt = Number(r.amount) || 0;
            const t = Number(r.ts) || 0;
            const S = (servers[sv] ||= { guildId: sv, ads: {}, totalJoined: 0, totalStayed: 0, totalLeft: 0, totalEarned: 0, lastAt: 0 });
            const A = (S.ads[sp] ||= { sponsorGuildId: sp, joined: 0, stayed: 0, left: 0, earned: 0, firstAt: 0, lastAt: 0 });
            A.joined++; S.totalJoined++;
            if (standing) { A.stayed++; A.earned += amt; S.totalStayed++; S.totalEarned += amt; }
            if (left) { A.left++; S.totalLeft++; }
            if (t) { A.firstAt = A.firstAt ? Math.min(A.firstAt, t) : t; A.lastAt = Math.max(A.lastAt, t); S.lastAt = Math.max(S.lastAt, t); }
        }
        const out = Object.values(servers).map((S) => ({
            guildId: S.guildId,
            name: guildNameOf(clients, S.guildId),
            icon: guildIconOf(clients, S.guildId),
            totalJoined: S.totalJoined,
            totalStayed: S.totalStayed,
            totalLeft: S.totalLeft,
            totalEarned: r2(S.totalEarned),
            lastAt: S.lastAt,
            ads: Object.values(S.ads).map((A) => ({
                sponsorGuildId: A.sponsorGuildId,
                sponsorName: guildNameOf(clients, A.sponsorGuildId),
                sponsorIcon: guildIconOf(clients, A.sponsorGuildId),
                joined: A.joined, stayed: A.stayed, left: A.left,
                earned: r2(A.earned), firstAt: A.firstAt, lastAt: A.lastAt
            })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
        })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
        return send(res, 200, { servers: out }, cors);
    }

    // The partner's own servers: distinct guildIds from their active cards.
    const partnerGuildIds = () => [...new Set(cards.loadCards()
        .filter((c) => c.creatorId === userId && !c.deletedAt)
        .map((c) => c.guildId)
        .filter((g) => /^\d{17,20}$/.test(String(g || ''))))];

    // Active ads currently AVAILABLE to each of the partner's servers (i.e. not
    // opted-out by the buyer/admin for that server), per server, plus this
    // partner's PER-SERVER priority + hide flags. "Available" =
    // campaigns.eligibleForGuild: active, not paused, not self-targeted, not
    // opted-out of this guild, bot on the sponsor, remaining > 0. The switcher on
    // the frontend flips between the partner's servers using this per-server list.
    if (path === '/partner/ads' && req.method === 'GET') {
        const settings = loadJSON('settings.json');
        const pset = settings[userId] || {};
        const priorityByGuild = pset.priorityByGuild || {};
        const hiddenByGuild = pset.hiddenByGuild || {};
        const verified = loadJSON('verified.json', []);
        const fleet = campaigns.fleetGuildIds(clients);
        const camps = campaigns.loadCampaigns();
        const servers = partnerGuildIds().map((gid) => {
            const prio = priorityByGuild[gid] || null;
            const hiddenSet = new Set(Array.isArray(hiddenByGuild[gid]) ? hiddenByGuild[gid] : []);
            let prioValid = false;
            const ads = campaigns.eligibleForGuild(gid, verified, fleet)
                .map((e) => {
                    const isPriority = e.id === prio;
                    if (isPriority) prioValid = true;
                    const purchased = Number(camps[e.id]?.purchased) || e.remaining;
                    return {
                        campaignId: e.id,
                        sponsorGuildId: e.sponsorGuildId,
                        sponsorName: guildNameOf(clients, e.sponsorGuildId),
                        sponsorIcon: guildIconOf(clients, e.sponsorGuildId),
                        remaining: e.remaining,
                        purchased,
                        delivered: Math.max(0, purchased - e.remaining),
                        isPriority,
                        isHidden: hiddenSet.has(e.id)
                    };
                })
                .sort((a, b) => b.remaining - a.remaining);
            return {
                guildId: gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid),
                priorityCampaign: prioValid ? prio : null, ads
            };
        });
        return send(res, 200, { servers }, cors);
    }

    // Set (or clear) the priority campaign FOR ONE of the partner's servers.
    // Body: { guildId, campaignId } — empty campaignId clears it. The campaign
    // must be eligible on that server. Priority and hide are mutually exclusive
    // for the same campaign+server, so pinning also un-hides it.
    if (path === '/partner/priority' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = String(body?.guildId || '').trim();
        const cid = String(body?.campaignId || '').trim();
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad guild' }, cors);
        if (!partnerGuildIds().includes(gid)) return send(res, 403, { error: 'not-your-server' }, cors);
        const settings = loadJSON('settings.json');
        if (!settings[userId]) settings[userId] = {};
        const S = settings[userId];
        S.priorityByGuild = S.priorityByGuild || {};
        if (!cid) {
            delete S.priorityByGuild[gid];
            saveJSON('settings.json', settings);
            return send(res, 200, { ok: true, priorityCampaign: null }, cors);
        }
        const verified = loadJSON('verified.json', []);
        const fleet = campaigns.fleetGuildIds(clients);
        const available = campaigns.eligibleForGuild(gid, verified, fleet).some((e) => e.id === cid);
        if (!available) return send(res, 400, { error: 'not-available' }, cors);
        S.priorityByGuild[gid] = cid;
        if (Array.isArray(S.hiddenByGuild?.[gid])) S.hiddenByGuild[gid] = S.hiddenByGuild[gid].filter((x) => x !== cid);
        saveJSON('settings.json', settings);
        return send(res, 200, { ok: true, priorityCampaign: cid }, cors);
    }

    // Hide (or unhide) a campaign on ONE of the partner's servers, so it won't be
    // shown there. Body: { guildId, campaignId, hidden }. Hiding a campaign that
    // is the server's priority clears that priority (they're exclusive).
    if (path === '/partner/hide' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const gid = String(body?.guildId || '').trim();
        const cid = String(body?.campaignId || '').trim();
        if (!/^\d{17,20}$/.test(gid) || !cid) return send(res, 400, { error: 'bad params' }, cors);
        if (!partnerGuildIds().includes(gid)) return send(res, 403, { error: 'not-your-server' }, cors);
        const settings = loadJSON('settings.json');
        if (!settings[userId]) settings[userId] = {};
        const S = settings[userId];
        S.hiddenByGuild = S.hiddenByGuild || {};
        const cur = new Set(Array.isArray(S.hiddenByGuild[gid]) ? S.hiddenByGuild[gid] : []);
        if (body?.hidden) {
            cur.add(cid);
            if (S.priorityByGuild?.[gid] === cid) delete S.priorityByGuild[gid];
        } else {
            cur.delete(cid);
        }
        if (cur.size) S.hiddenByGuild[gid] = [...cur]; else delete S.hiddenByGuild[gid];
        saveJSON('settings.json', settings);
        return send(res, 200, { ok: true, hidden: Boolean(body?.hidden) }, cors);
    }

    // The partner's own active verification cards — same rich stats as the
    // admin "Экстренно" list, scoped to cards this partner owns.
    if (path === '/partner/cards' && req.method === 'GET') {
        const mine = cards.loadCards().filter((c) => c.creatorId === userId && !c.deletedAt);
        const { list, avgVerifySeconds } = enrichCards(clients, mine);
        const active = list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return send(res, 200, { cards: active, avgVerifySeconds }, cors);
    }

    // Card management, same actions as the admin "Экстренно" panel but a partner
    // may only touch cards they own. The ownership guard reads the CURRENT owner
    // before any change (so a partner can't act on someone else's card).
    const ownCard = (mid) => { const c = cards.getCard(mid); return (c && c.creatorId === userId && !c.deletedAt) ? c : null; };
    if ((path === '/partner/cards/fix' || path === '/partner/cards/republish' || path === '/partner/cards/delete' || path === '/partner/cards/reset-role') && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        if (!ownCard(mid)) return send(res, 403, { error: 'not-your-card' }, cors);
        let r;
        if (path.endsWith('/delete')) r = await cards.remove(clients, mid, userId).catch((e) => ({ ok: false, error: e.message }));
        else if (path.endsWith('/fix')) r = await cards.fix(clients, mid).catch((e) => ({ ok: false, error: e.message }));
        else if (path.endsWith('/republish')) r = await cards.republish(clients, mid).catch((e) => ({ ok: false, error: e.message }));
        else r = await cards.resetRole(clients, mid).catch((e) => ({ ok: false, error: e.message }));
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card || null, roleName: r.roleName } : { error: r.error || 'failed' }, cors);
    }
    if (path === '/partner/cards/edit' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        if (!ownCard(mid)) return send(res, 403, { error: 'not-your-card' }, cors);
        const patch = {};
        // creatorId (the payout recipient) is intentionally NOT editable here:
        // a partner must not be able to redirect a card's future payouts to an
        // arbitrary Discord user who never consented. Owner reassignment lives
        // in the admin panel only.
        if (body.roleId !== undefined) {
            const rid = String(body.roleId || '');
            if (rid && !/^\d{17,20}$/.test(rid)) return send(res, 400, { error: 'bad role id' }, cors);
            patch.roleId = rid || null;
        }
        if (body.description !== undefined) patch.description = String(body.description).slice(0, 4000);
        const r = await cards.edit(clients, mid, patch).catch((e) => ({ ok: false, error: e.message }));
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card } : { error: r.error || 'failed' }, cors);
    }

    if (path === '/partner/requisites' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const settings = loadJSON('settings.json');
        if (!settings[userId]) settings[userId] = blankUser();
        settings[userId].requisites = String(body?.requisites ?? '').trim().slice(0, 1000);
        saveJSON('settings.json', settings);
        return send(res, 200, { ok: true, requisites: settings[userId].requisites }, cors);
    }

    return send(res, 404, { error: 'unknown endpoint' }, cors);
}

// ---------- Investor cabinet ----------
// Discord-login dashboard where an investor tops up an investment account and
// buys future invites of a server at $9/100; as those invites are sold by the
// service at $10/100 they return $0.09 + 10%. Same user session cookie.
async function handleInvestor(req, res, path, clients, config) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (!adminAuth.enabled()) return send(res, 503, { error: 'auth not configured' }, cors);

    if (path === '/investor/oauth/login' && req.method === 'GET') {
        res.writeHead(302, { Location: adminAuth.oauthAuthorizeUrl(adminAuth.issueState('investor')) });
        return res.end();
    }
    if (path === '/investor/logout' && req.method === 'POST') {
        // Unified logout: clear BOTH sessions so leaving one cabinet signs the
        // user out everywhere (mirrors the single sign-on on login).
        return send(res, 200, { ok: true }, { ...cors, 'Set-Cookie': [adminAuth.buyerCookieHeader('', { clear: true }), adminAuth.sessionCookieHeader('', { clear: true })] });
    }
    if (path === '/investor/whoami' && req.method === 'GET') {
        const sess = buyerSessionOf(req);
        return send(res, 200, sess ? { authed: true, userId: sess.userId, isAdmin: Boolean(adminAuth.roleOf(sess.userId)) } : { authed: false }, cors);
    }
    if (await handleLoginCode(req, res, path, clients, cors)) return;

    const sess = buyerSessionOf(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' }, cors);
    const userId = sess.userId;
    const verified = () => { const v = loadJSON('verified.json', []); return Array.isArray(v) ? v : []; };

    if (path === '/investor/me' && req.method === 'GET') {
        await investors.reconcileTopups(userId, campaigns.isInvoicePaid).catch(() => null);
        const acc = investors.accountOf(userId, verified());
        return send(res, 200, {
            userId,
            account: acc,
            topups: investors.recentTopups(userId),
            pricing: { buyPer100: investors.BUY_PER_100, sellPer100: investors.SELL_PER_100, returnRate: investors.RETURN_RATE, minInvites: investors.MIN_BUY, minDays: investors.MIN_DAYS, minDaily: investors.MIN_DAILY },
            minTopup: investors.MIN_TOPUP,
            cryptoEnabled: cryptopay.enabled()
        }, cors);
    }

    // Servers with sold-invite throughput + this investor's position on each.
    if (path === '/investor/servers' && req.method === 'GET') {
        const list = investors.serversFor(userId, verified())
            .filter((s) => s.investable || s.mine)
            .slice(0, 60)
            .map((s) => ({
                ...s,
                name: guildNameOf(clients, s.serverId),
                icon: guildIconOf(clients, s.serverId),
                broken: investors.serverBroken(s.serverId, clients)
            }));
        return send(res, 200, { servers: list, pricing: { buyPer100: investors.BUY_PER_100, sellPer100: investors.SELL_PER_100, returnRate: investors.RETURN_RATE, minInvites: investors.MIN_BUY, minDays: investors.MIN_DAYS, minDaily: investors.MIN_DAILY } }, cors);
    }

    // Top up the investment account via a CryptoBot invoice. Body: { amount }.
    if (path === '/investor/topup' && req.method === 'POST') {
        if (!cryptopay.enabled()) return send(res, 503, { error: 'Оплата временно недоступна' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const amount = +(Number(body?.amount) || 0).toFixed(2);
        if (!(amount >= investors.MIN_TOPUP)) return send(res, 400, { error: 'min-topup' }, cors);
        let invoice = null;
        try { invoice = await cryptopay.createUsdtInvoice(amount.toFixed(2), { description: `Пополнение инвест-счёта Vemoni на $${amount.toFixed(2)}`.slice(0, 1024) }); }
        catch (e) { return send(res, 502, { error: 'invoice-failed' }, cors); }
        const invoiceUrl = invoice.bot_invoice_url || invoice.mini_app_invoice_url || invoice.web_app_invoice_url || invoice.pay_url;
        investors.addTopup(userId, { invoiceId: invoice.invoice_id, amount, status: 'pending', createdAt: Date.now() });
        return send(res, 200, { ok: true, invoiceUrl, amount }, cors);
    }

    // Buy N future invites of a server. Body: { serverId, qty }.
    if (path === '/investor/buy' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        if (!investors.isServerInvestable(String(body?.serverId || ''), verified())) return send(res, 400, { error: 'server-disabled' }, cors);
        if (investors.serverBroken(String(body?.serverId || ''), clients)) return send(res, 400, { error: 'server-broken' }, cors);
        await investors.reconcileTopups(userId, campaigns.isInvoicePaid).catch(() => null);
        const gid = String(body?.serverId || '');
        const r = investors.buy(userId, gid, body?.qty, verified());
        if (!r.ok) return send(res, r.error === 'insufficient' ? 402 : r.error === 'occupied' ? 409 : 400, r, cors);
        // Recognize the buy-in as revenue now: distribute the service's per-invite
        // net profit to shareholders (early) and record it in sales stats. The
        // matching future join deliveries skip the normal per-join share split
        // (index.js), so there's no double-count. Time/retention stats stay tied
        // to real sponsor joins and are untouched here.
        try {
            const ownerCard = cards.loadCards().find((c) => !c.deletedAt && String(c.guildId) === gid);
            const bid = ownerCard ? (Number((loadJSON('settings.json', {})[ownerCard.creatorId] || {}).joinBid) || 5) : 5;
            const perInvite = investors.buyinProfitPerInvite(bid, ACQUIRING_RATE);
            const breakdown = await distributeProfit(clients, r.qty * perInvite).catch((e) => {
                // Loud, actionable log: the position exists (investor charged) and
                // its future joins skip per-join payShares, so a silent failure
                // here means those shareholders are never paid. Operator must
                // reconcile manually against this position id.
                console.error(`[INVEST] CRITICAL: buy-in profit distribution failed for position ${r.positionId} (user ${userId}, server ${gid}): ${e && e.message}`);
                return null;
            });
            if (breakdown && r.positionId) investors.recordBuyinCredits(userId, r.positionId, breakdown);
            sales.recordSale({ campaignId: `invest_${userId}_${Date.now()}`, buyerId: userId, amount: r.cost, joins: r.qty, sponsorGuildId: gid, via: 'invest' });
        } catch (e) { console.error('[INVEST] buy-in distribution error:', e.message); }
        return send(res, 200, { ok: true, cost: r.cost, qty: r.qty, account: investors.accountOf(userId, verified()) }, cors);
    }

    // Withdraw liquid balance to the partner's main balance. Body: { amount? }.
    if (path === '/investor/withdraw' && req.method === 'POST') {
        const body = await readBody(req);
        const r = investors.withdraw(userId, body?.amount, verified());
        if (!r.ok) return send(res, r.error === 'insufficient' ? 402 : 400, r, cors);
        return send(res, 200, { ok: true, amount: r.amount, account: investors.accountOf(userId, verified()) }, cors);
    }

    return send(res, 404, { error: 'unknown endpoint' }, cors);
}

// Lenient per-IP fixed-window rate limit — defense-in-depth against floods
// and credential brute-forcing. The cap is high so normal panel polling and
// many bots behind one NAT stay well under it; only abusive bursts trip it.
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.API_RATE_LIMIT) || 600;
const rlHits = new Map(); // ip -> { count, windowStart }
function rateLimited(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    let e = rlHits.get(ip);
    if (!e || now - e.windowStart > RL_WINDOW_MS) { e = { count: 0, windowStart: now }; rlHits.set(ip, e); }
    e.count++;
    return e.count > RL_MAX;
}
// Bounded cleanup so the Map can't grow without limit.
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rlHits) if (now - e.windowStart > RL_WINDOW_MS) rlHits.delete(ip);
}, RL_WINDOW_MS).unref?.();

function startApiServer(clients, config) {
    const port = Number(process.env.API_PORT || process.env.PORT || 8080);

    const server = http.createServer(async (req, res) => {
        try {
            if (rateLimited(req)) return send(res, 429, { error: 'rate limited' });
            const p = (new URL(req.url, 'http://x').pathname).replace(/\/+$/, '') || '/';

            // CSRF defense for the cookie-authenticated cabinets. The session
            // cookie is SameSite=None (cross-origin admin panel), so a malicious
            // page could otherwise forge a state-changing POST that rides the
            // victim's cookie. Any browser cross-origin request — including the
            // text/plain "simple request" that skips preflight — still carries an
            // Origin header, so rejecting a mismatched Origin on mutating cabinet
            // requests blocks CSRF without touching the frontend (legit calls
            // come from ADMIN_ORIGIN and are unaffected). API-key routes (/api/*)
            // aren't cookie-authed, so they're exempt.
            const isCabinet = p === '/admin' || p.startsWith('/admin/') || p.startsWith('/order/') || p.startsWith('/partner/') || p.startsWith('/investor/');
            const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH';
            if (isCabinet && mutating) {
                const origin = req.headers.origin || '';
                if (origin && !isAllowedOrigin(origin)) return send(res, 403, { error: 'bad origin' });
            }

            // Public: docs + health
            if (req.method === 'GET' && (p === '/' || p === '/api')) return send(res, 200, DOCS);
            if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });

            // Public: home-page server feed (owner-managed via /admin/feed).
            // Read-only, no credentials → open to any origin.
            if (req.method === 'GET' && p === '/feed') return send(res, 200, { servers: feed.loadFeed() }, { 'Access-Control-Allow-Origin': '*' });

            // Public: live "new member joined a sponsor" feed for the buyers page.
            // Recent CONFIRMED joins → the sponsor server that gained a member and
            // its live member count. No payout figures. Read-only, any origin,
            // newest first; only sponsors a bot still shares are included.
            if (req.method === 'GET' && p === '/joins-feed') {
                const jl = loadJSON('joinlinks.json', []);
                const now = Date.now();
                const WINDOW = 12 * 3600 * 1000;                 // last 12h of real joins
                const rows = (Array.isArray(jl) ? jl : [])
                    .filter((r) => r && (r.status === 'joined' || r.status === 'settled')
                        && Number(r.ts) > now - WINDOW && /^\d{17,20}$/.test(String(r.guildId || '')))
                    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
                    .slice(0, 60);
                const events = [];
                for (const r of rows) {
                    const gid = String(r.guildId);
                    const name = guildNameOf(clients, gid);
                    if (!name) continue;                          // bot no longer on sponsor → skip
                    let members = null, icon = null;
                    for (const c of clients) { const g = c.guilds?.cache?.get(gid); if (g) { members = (g.memberCount ?? null); icon = (g.iconURL?.({ size: 64 }) || null); break; } }
                    events.push({ ts: Number(r.ts) || 0, name, icon, members });
                    if (events.length >= 25) break;
                }
                return send(res, 200, { events }, { 'Access-Control-Allow-Origin': '*' });
            }

            // Admin panel (TOTP-gated, CORS-scoped to ADMIN_ORIGIN).
            // Await so any async rejection lands in this outer try/catch —
            // otherwise handleAdmin's promise would settle after we've
            // already returned and become an unhandled rejection.
            if (p.startsWith('/admin/') || p === '/admin') {
                return await handleAdmin(req, res, p, clients, config);
            }

            // Buyer order panel (Discord-OAuth, CORS-scoped to ADMIN_ORIGIN).
            if (p.startsWith('/order/')) {
                return await handleBuyer(req, res, p, clients, config);
            }

            // Partner cabinet (same user session as the order panel).
            if (p.startsWith('/partner/')) {
                return await handlePartner(req, res, p, clients, config);
            }

            // Investor cabinet (same user session).
            if (p.startsWith('/investor/')) {
                return await handleInvestor(req, res, p, clients, config);
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
                // Same "заглушка" the in-Discord bots show when there is no ad,
                // so an API bot can render an identical no-ad message.
                const cfg = loadJSON('siteconfig.json', {});
                return send(res, 200, {
                    adText: ad.adText,
                    fallbackText: (cfg.fallbackText && String(cfg.fallbackText).trim()) || null,
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

                // Find which advertised sponsor the user actually joined (scans the
                // same candidate pool /api/ad shows from — NOT a fresh random pick,
                // which could check the wrong sponsor and 403 a valid join).
                const match = await matchJoinedSponsor(clients, config.ownerId, serverId, memberId);
                if (match.uncertain) return send(res, 503, { joined: null, error: 'membership check temporarily unavailable, retry' });

                // No join-check sponsor for this server → verify without an ad,
                // exactly like a network bot: no-ad stat, hub role, no payout.
                if (match.none) {
                    recordApiVerified({ creatorId: userId, memberId, serverId, noAd: true });
                    try { partnerlog.logEvent(userId, { type: 'grant', reason: 'no_ad', userId: memberId, guildId: serverId, roleId: 'api', srcId: `v:${memberId}:${serverId}:api` }); } catch { /* never block */ }
                    syncHubMember(clients, memberId).catch(() => null);
                    return send(res, 200, { joined: true, credited: false, ad: false });
                }
                if (match.notMember) return send(res, 403, { joined: false });

                const ad = match.ad;
                const sponsor = ad.sponsor;

                // Dedup by (sponsor, user) — one real invite is paid once, no
                // matter which network server / partner delivered the join.
                const links = loadJSON('joinlinks.json', []);
                const already = (Array.isArray(links) ? links : []).some(
                    (r) => r && (r.status === 'joined' || r.status === 'settled') && r.guildId === sponsor.guildId && r.userId === memberId
                );
                if (already) {
                    try { partnerlog.logEvent(userId, { type: 'grant', reason: 'dup_join', userId: memberId, guildId: serverId, roleId: 'api', srcId: `dup:${memberId}:${sponsor.guildId}` }); } catch { /* never block */ }
                    return send(res, 200, { joined: true, credited: false, sponsor: sponsor.guildId, note: 'already counted' });
                }

                // Full parity with the in-Discord flow: joinlinks (clawback-
                // watched, roleId 'api' + serverId), share split, verified.json
                // tagged with the shown creative's adKey, hub role, audit log,
                // campaign-complete notice.
                const adKey = touchCreative(ad.raw);
                // Manager economics (same as the in-Discord flow): lower revenue
                // for manager campaigns, no commission paid.
                const camp = ad.campaignId ? campaigns.loadCampaigns()[ad.campaignId] : null;
                const econ = managers.joinEconomics(camp, REVENUE_PER_JOIN);
                const credit = creditJoin(userId, sponsor.guildId, memberId, serverId, 'api', null,
                    { revenue: econ.revenue, managerId: econ.managerId });
                // Race backstop: creditJoin's atomic guard caught a concurrent
                // credit for the same (user, sponsor) — treat as already counted.
                if (credit.duplicate) {
                    try { partnerlog.logEvent(userId, { type: 'grant', reason: 'dup_join', userId: memberId, guildId: serverId, roleId: 'api' }); } catch { /* never block */ }
                    return send(res, 200, { joined: true, credited: false, sponsor: sponsor.guildId, note: 'already counted' });
                }
                const amount = credit.amount;
                try { partnerlog.logEvent(userId, { type: 'grant', reason: 'paid', amount, userId: memberId, guildId: serverId, roleId: 'api', srcId: credit.linkId }); } catch { /* never block */ }
                // Parity with the in-Discord flow: if this server has outstanding
                // investor invites, this paid join fills one — its share split
                // already happened at the investor buy-in, so skip payShares.
                let investorOwnedJoin = false;
                try { investorOwnedJoin = investors.serverOutstanding(serverId, loadJSON('verified.json', [])) > 0; } catch { /* never block verification */ }
                if (!investorOwnedJoin) await payShares(clients, amount, { revenuePerJoin: econ.revenue }).catch(() => null);
                const fresh = recordApiVerified({ creatorId: userId, memberId, serverId, adKey });
                syncHubMember(clients, memberId).catch(() => null);
                await logFunds(clients, {
                    type: 'credit', creatorId: userId, userId: memberId, guildId: serverId,
                    amount, sponsorGuildId: sponsor.guildId,
                    reason: 'Join verified (API) — member joined the sponsor server'
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

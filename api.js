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
const { resolveSponsorPresence, isMember, creditJoin, extractInviteCodes, finalizeLeavers } = require('./joincheck.js');
const webhooks = require('./webhooks.js');
const { syncHubMember } = require('./hubrole.js');
const { logFunds } = require('./fundslog.js');
const shares = require('./shares.js');
const { loadShares, dayNumberOf, payShares, distributeProfit } = shares;
const { boostActive, BOOST_RATE, BOOST_MS, REFERRAL_RATE } = require('./referral.js');
const cryptopay = require('./cryptopay.js');
const cryptomus = require('./cryptomus.js');
const nowpayments = require('./nowpayments.js');
const usertoken = require('./usertoken.js');
const reservegw = require('./reservegw.js');
const presence = require('./presence.js');
const perf = require('./perf.js');
const sponsorshow = require('./sponsorshow.js');
// Named runtimeConfig to avoid clashing with the app `config` object that
// handleAdmin/handleBuyer/etc. receive as a parameter.
const runtimeConfig = require('./config.js');

// The set of sponsor guilds joins can be verified on: every guild a network bot is
// on, PLUS the reserve user account's guilds (invisible fallback). Used only on the
// ad-serving / verification path — the buyer cabinet stays bot-only on purpose.
async function coveredGuildIds(clients) {
    const set = campaigns.fleetGuildIds(clients);
    if (usertoken.enabled()) { try { for (const g of await usertoken.coveredGuildIds()) set.add(g); } catch { /* ignore */ } }
    return set;
}

// Where each campaign sits in the FIFO delivery queue right now, and whether it's
// actually being shown. Returns a fn campaign → { state, position, total, ... }:
//   showing — it is the FRONT of the FIFO queue that's actually running now.
//   waiting — deliverable but an earlier order is still ahead of it (position/total).
//   no_bot  — active but no bot/reserve covers its server, so it can't run.
//   paused  — manually paused.
//   idle    — active but not deliverable for another reason (per-link cap / just done).
//   null    — not active (complete/cancelled/invalid — shown by the status chip).
//
// "showing" is strict-FIFO, NOT just "sponsor stamped recently". The stamp alone
// over-reports: because a user already in the front sponsors is shown the NEXT
// eligible ad (you can't advertise a server someone's already in), several
// sponsors get stamped at once, so many orders would falsely read "showing"
// while, by the queue, only the front one is really the ad being served. So we
// mark as "showing" only the FRONT-MOST deliverable order that is itself stamped
// recently; everything behind it is "waiting", even if its own sponsor was
// stamped by such a skip.
// The service admin/manager's GLOBAL priority pin (one campaign, set from the
// orders page). Stored in siteconfig; null when unset. Partner per-server pins
// still override it in the actual delivery (index.js).
const adminPriorityId = () => { const sc = loadJSON('siteconfig.json', {}); const v = sc && sc.adminPriorityCampaignId; return (typeof v === 'string' && v) ? v : null; };

const QUEUE_SHOWING_MS = Number(process.env.QUEUE_SHOWING_MS) || 5 * 60 * 1000;
function queueResolver(camps, verified, covered) {
    const now = Date.now();
    const shows = sponsorshow.loadShows();
    const key = (c) => Number(c.paidAt) || Number(c.createdAt) || 0;
    const stampedRecently = (c) => { const last = Number(shows[c.sponsorGuildId]) || 0; return last > 0 && (now - last) <= QUEUE_SHOWING_MS; };
    const deliverable = [];
    for (const c of Object.values(camps)) {
        if (!c || c.status !== 'active' || c.paused || c.autoPaused) continue;
        if (!covered.has(c.sponsorGuildId)) continue;
        const del = campaigns.delivered(c, verified, camps);
        if ((Number(c.purchased) || 0) - del <= 0) continue;
        if (campaigns.linkProgress(c, del).reached) continue;
        deliverable.push(c);
    }
    deliverable.sort((a, b) => key(a) - key(b) || String(a.id).localeCompare(String(b.id)));
    // A service admin/manager can pin ONE campaign to the front network-wide (set
    // from the orders page). It leads the queue everywhere the partner hasn't set
    // their own per-server pin (partner pin wins, but that's per-guild and not
    // reflected in this global view).
    const pinId = adminPriorityId();
    if (pinId) { const i = deliverable.findIndex((c) => c.id === pinId); if (i > 0) { const [p] = deliverable.splice(i, 1); deliverable.unshift(p); } }
    const pos = new Map(deliverable.map((c, i) => [c.id, i + 1]));
    const total = deliverable.length;
    // The single order that's genuinely "showing now": the earliest-queued
    // deliverable one whose ad actually ran recently. null on a quiet network.
    const showingId = (deliverable.find(stampedRecently) || {}).id || null;
    return (c) => {
        if (!c || c.status !== 'active') return null;
        if (c.autoPaused) return { state: 'verifier_off' };
        if (c.paused) return { state: 'paused' };
        if (!covered.has(c.sponsorGuildId)) return { state: 'no_bot' };
        if (!pos.has(c.id)) return { state: 'idle' };
        const last = Number(shows[c.sponsorGuildId]) || 0;
        const showing = c.id === showingId;
        return { state: showing ? 'showing' : 'waiting', position: pos.get(c.id), total, lastShownSec: last ? Math.round((now - last) / 1000) : null };
    };
}
const campaigns = require('./campaigns.js');
const managers = require('./managers.js');
const dmaccess = require('./dmaccess.js');
const rateLimit = require('./ratelimit.js');
const feed = require('./feed.js');
const cards = require('./cards.js');
const audit = require('./auditlog.js');
const backup = require('./backup.js');
const poster = require('./poster.js');
const extraad = require('./extraad.js');
const wallet = require('./wallet.js');
const lots = require('./lots.js');
const lotmon = require('./lotmon.js');
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
const joinCheckGuilds = () => new Set((process.env.JOIN_CHECK_GUILDS || '').split(',').map((s) => s.trim()).filter(Boolean));

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
    try { sponsorshow.stamp(gid); } catch { /* stamping must never break the ad path */ }
}

// Short-lived membership cache for AD SELECTION only (mirrors the in-Discord
// isMemberCached). Reserve-covered sponsors (no network bot) answer membership
// over a user-token gateway that intermittently replies "don't know" (null); a
// fresh check every /api/ad then sometimes fails to skip a sponsor the user is
// already in. Caching a CONFIRMED true/false for a minute smooths that out so an
// already-joined sponsor is skipped consistently once we've seen it. Crediting
// (matchJoinedSponsor) still uses a FRESH isMember — never a cached membership.
const _adMemberCache = new Map();       // "guild:user" -> { at, val }
const AD_MEMBER_TTL = 60000;
async function isMemberForAd(bot, guildId, memberId) {
    const key = String(guildId) + ':' + String(memberId);
    const hit = _adMemberCache.get(key);
    if (hit && Date.now() - hit.at < AD_MEMBER_TTL) return hit.val;
    const val = await isMember(bot, guildId, memberId).catch(() => null);
    if (val === true || val === false) {
        if (_adMemberCache.size > 5000) _adMemberCache.clear();
        _adMemberCache.set(key, { at: Date.now(), val });
    }
    return val;
}

async function adForServer(clients, ownerId, serverId, memberId, botId) {
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
            const ordered = campaigns.weightedOrder(campaigns.eligibleForGuild(serverId, verified, await coveredGuildIds(clients), botId));
            let checks = 0;
            for (const cand of ordered) {
                if (checks >= 8) break;                                  // bound the network calls
                if (capReached(cand.invite)) continue;
                checks++;
                const sponsor = await resolveSponsorPresence(clients, cand.invite).catch(() => null);
                if (!sponsor || sponsor.guildId === String(serverId)) continue; // unresolvable / self → try next
                // Optional: a bot may pass userId so we skip sponsors the user is
                // already in (don't advertise a server they've already joined).
                if (memberId && (await isMemberForAd(sponsor.bot, sponsor.guildId, memberId)) === true) continue;
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
    // Also never advertise a server on itself (members are already in), nor one
    // the passed user is already a member of.
    if (!sponsor || (gidOk && sponsor.guildId === String(serverId))
        || (memberId && (await isMemberForAd(sponsor.bot, sponsor.guildId, memberId)) === true)) {
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
async function matchJoinedSponsor(clients, ownerId, serverId, memberId, botId, wantSponsorId) {
    const cfg = loadJSON('siteconfig.json', {});
    if (cfg.adsOff) return { none: true };
    const verified = loadJSON('verified.json', []);
    const limits = loadJSON('adlimits.json', {});
    const capReached = (raw) => { const rec = limits[adKeyOf(raw)]; const cap = Number(rec?.limit) || 0; return cap > 0 && joinerCount(verified, adKeyOf(raw), Number(rec?.resetAt) || 0) >= cap; };
    const jcg = joinCheckGuilds();
    const approvedSponsor = (gid) => !jcg.size || jcg.has(gid);
    const s = loadJSON('settings.json')[ownerId] || {};

    // Resolve presence by guild id (fleet bot on it, or reserve) — robust to a
    // dead/rate-limited invite, which must never make a real join look like "no ad".
    const presenceByGuild = async (gid) => {
        gid = String(gid);
        const bot = (Array.isArray(clients) ? clients : []).find((c) => c.guilds?.cache?.has(gid));
        if (bot) return { guildId: gid, bot };
        if (usertoken.enabled() && await usertoken.coversGuild(gid).catch(() => false)) return { guildId: gid, bot: null };
        return null;
    };

    // Verify the sponsor we ACTUALLY SHOWED this user via this bot (recorded on
    // /api/ad), keyed by (bot, user) — never a different sponsor they already
    // belong to. Hot path is lean (one membership REST call) so the bot can ack
    // Discord's interaction in time.
    if (botId) {
        const clicks = loadJSON('apiclicks.json', []);
        const now = Date.now();
        const want = /^\d{17,20}$/.test(String(wantSponsorId || '')) ? String(wantSponsorId) : null;
        let shown = null;
        for (const e of (Array.isArray(clicks) ? clicks : [])) {
            // When the caller passes sponsorId (the guildId /api/ad returned), pin
            // to THAT shown record — makes the check deterministic even if the bot
            // showed different sponsors across concurrent commands. Still requires a
            // real shown record, so it can't be used to farm an arbitrary server.
            if (e.b === String(botId) && e.u === String(memberId) && e.s && (!want || String(e.s) === want) && e.t > now - 3600000 && (!shown || e.t > shown.t)) shown = e;
        }
        if (!shown) return { none: true };                     // nothing shown → nothing to reward
        const effSid = String(shown.g || serverId || '');      // the guild the ad ran in
        const gid = String(shown.s);                           // the sponsor we showed
        if (!/^\d{17,20}$/.test(gid) || gid === effSid || !approvedSponsor(gid)) return { none: true };
        if (cfg.serverAdsOff && cfg.serverAdsOff[effSid]) return { none: true };
        const sp = await presenceByGuild(gid);
        if (!sp) return { none: true };
        const m = await isMember(sp.bot, sp.guildId, memberId).catch(() => null);
        if (m === null) return { uncertain: true };            // transient → 503
        if (m !== true) return { notMember: true };            // not in the shown sponsor → 403
        // Attribution only — the sponsor is already resolved, so skip the
        // coveredGuildIds() network work (pass null → no bot-presence filter).
        const elig = campaigns.eligibleForGuild(effSid, verified, null, botId).find((c) => String(c.sponsorGuildId) === gid);
        if (elig && capReached(elig.invite)) return { none: true };
        const raw = elig ? elig.invite
            : ((s.serverAds && s.serverAds[effSid] && String(s.serverAds[effSid]).trim()) ? s.serverAds[effSid] : (s.advText || ''));
        stampSponsorShow(gid);
        return { ad: { adText: applyTemplate(effSid, raw), raw, sponsor: sp, campaignId: elig ? elig.id : null }, serverId: effSid };
    }

    // Legacy fallback (botId absent): scan eligible sponsors.
    if (cfg.serverAdsOff && cfg.serverAdsOff[serverId]) return { none: true };
    const cands = campaigns.eligibleForGuild(serverId, verified, await coveredGuildIds(clients))
        .map((c) => ({ raw: c.invite, campaignId: c.id, sponsorGuildId: c.sponsorGuildId || null }));
    const houseRaw = (s.serverAds && s.serverAds[serverId] && String(s.serverAds[serverId]).trim()) ? s.serverAds[serverId]
        : ((s.advText || '').trim() ? s.advText : null);
    if (houseRaw) cands.push({ raw: houseRaw, campaignId: null, sponsorGuildId: null });
    const presenceFor = (cand) => cand.sponsorGuildId ? presenceByGuild(cand.sponsorGuildId)
        : resolveSponsorPresence(clients, applyTemplate(serverId, cand.raw)).catch(() => null);
    let sawAny = false, uncertain = false, checks = 0;
    const seenSponsors = new Set();
    for (const cand of cands) {
        if (checks >= 25) break;                 // bound network calls (only REAL checks count)
        if (capReached(cand.raw)) continue;
        const sp = await presenceFor(cand);
        if (!sp || sp.guildId === String(serverId) || !approvedSponsor(sp.guildId)) continue;
        if (seenSponsors.has(sp.guildId)) continue; // same sponsor via another campaign
        seenSponsors.add(sp.guildId);
        checks++;
        sawAny = true;
        const m = await isMember(sp.bot, sp.guildId, memberId).catch(() => null);
        if (m === true) { stampSponsorShow(sp.guildId); return { ad: { adText: applyTemplate(serverId, cand.raw), raw: cand.raw, sponsor: sp, campaignId: cand.campaignId } }; }
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

// NOWPayments custody balance (USD), cached — NOWPayments rate-limits hard, and
// balance moves slowly. Keeps the last good value on a transient fetch failure.
let _npBalCache = { at: 0, val: null };
async function nowpaymentsBalanceUsd() {
    if (!nowpayments.enabled()) return null;
    const now = Date.now();
    if (now - _npBalCache.at < 5 * 60 * 1000) return _npBalCache.val;
    const val = await nowpayments.balanceUsd().catch(() => null);
    _npBalCache = { at: now, val: val != null ? val : _npBalCache.val };
    return _npBalCache.val;
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
function recordApiVerified({ creatorId, memberId, serverId, adKey, noAd, botId }) {
    const verified = loadJSON('verified.json', []);
    const arr = Array.isArray(verified) ? verified : [];
    const gid = /^\d{17,20}$/.test(String(serverId || '')) ? String(serverId) : 'api';
    const mid = /^\d{17,20}$/.test(String(memberId || '')) ? String(memberId) : 'api';
    const kept = arr.filter((u) => !(u.id === mid && u.guildId === gid && (u.roleId || null) === 'api'));
    const rec = { id: mid, guildId: gid, roleId: 'api', creatorId, timestamp: Date.now(), viaApi: true };
    if (botId) rec.botId = String(botId);
    if (adKey) rec.adKey = adKey;
    else if (noAd) rec.noAd = true;
    kept.push(rec);
    saveJSON('verified.json', kept);
    return kept;
}

// Funnel stage 1 for the developer API: an ad was shown to a user through a bot.
// Deduped per (bot, server, user) within a minute so repeat /api/ad polls don't
// inflate it; pruned to a week. Keyed by bot so the cabinet can draw a per-bot
// funnel (started → checked → stayed), mirroring the server verification cards.
const API_CLICK_TTL = 7 * 86400000;
function recordApiClick({ creatorId, botId, serverId, memberId, sponsorGuildId }) {
    if (!creatorId || !botId) return;
    const now = Date.now();
    const raw = loadJSON('apiclicks.json', []);
    const arr = (Array.isArray(raw) ? raw : []).filter((e) => e.t > now - API_CLICK_TTL);
    // Refresh a recent record for the same (bot, server, user) — keeps the funnel
    // "started" count honest — but always update the last-shown sponsor so
    // join-check verifies exactly what we showed.
    const recent = arr.find((e) => e.b === String(botId) && e.g === String(serverId || '') && e.u === String(memberId || '') && e.t > now - 60000);
    if (recent) { if (sponsorGuildId) recent.s = String(sponsorGuildId); recent.t = now; saveJSON('apiclicks.json', arr); return; }
    arr.push({ c: String(creatorId), b: String(botId), g: String(serverId || ''), u: String(memberId || ''), s: sponsorGuildId ? String(sponsorGuildId) : null, t: now });
    saveJSON('apiclicks.json', arr);
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
    // Index the big arrays by (creatorId|guildId) ONCE instead of re-scanning the
    // whole verified/joinlinks list for every card (was O(cards × records)).
    const vByKey = new Map();
    for (const u of vArr) { const k = (u.creatorId || '') + '|' + (u.guildId || ''); let a = vByKey.get(k); if (!a) vByKey.set(k, a = []); a.push(u); }
    const jByKey = new Map();
    for (const r of jArr) { if (r.status !== 'left') continue; const k = (r.creatorId || '') + '|' + (r.cardGuildId || ''); let a = jByKey.get(k); if (!a) jByKey.set(k, a = []); a.push(r); }
    const list = (Array.isArray(records) ? records : []).map((c) => {
        const rid = c.roleId || null;
        // All role ids this card's stats live under (current + any pre-reset
        // role) so "Сбросить роль" doesn't zero the funnel.
        const roleIds = cards.cardRoleIds(c);
        // Verified-and-still-standing for this card (stage 3), and clawed
        // leavers (verified then left) — together they make "join checked".
        const _k = (c.creatorId || '') + '|' + (c.guildId || '');
        const vmatch = (vByKey.get(_k) || []).filter((u) => roleIds.includes(u.roleId || null));
        const leftMatch = (jByKey.get(_k) || []).filter((r) => roleIds.includes(r.roleId || null));
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
            memberCount: guildMembersOf(clients, c.guildId),
            channelName: channelNameOf(clients, c.channelId),
            creatorId: c.creatorId || null,
            creatorName: userNameOf(clients, c.creatorId),
            roleId: rid,
            roleName: roleNameOf(clients, c.guildId, rid),
            description: c.description || cards.DEFAULT_DESCRIPTION,
            customDescription: Boolean(c.description),
            title: c.title || 'Get verified!',
            customTitle: Boolean(c.title),
            buttonLabel: c.buttonLabel || 'Start Verification',
            buttonEmoji: Object.prototype.hasOwnProperty.call(c, 'buttonEmoji') ? (c.buttonEmoji || '') : '🔐',
            color: c.color || '#5865F2',
            isTemplate: !!c.isTemplate,
            link: (c.guildId && c.channelId) ? `https://discord.com/channels/${c.guildId}/${c.channelId}/${c.messageId}` : null,
            createdAt: c.createdAt || 0,
            autoResetMs: c.autoResetMs || 0,
            alwaysBottom: !!c.alwaysBottom,
            alwaysBottomSupported: !!c.channelId,
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


// Public changelog for the developer API. Newest first. Surfaced at
// GET /api/changelog and mirrored on the docs page. `breaking` flags changes
// that could affect an existing integration.
const API_VERSION = 1;
const CHANGELOG = [
    { date: '2026-07-22', version: 1, breaking: true, changes: [
        'join-check: "not joined" is now 200 { joined:false, status:"not_joined" } instead of 403 (so it is no longer confused with an auth error).',
        'join-check: every response now carries a status field: credited | not_joined | already_counted | no_ad | uncertain. The old boolean fields still ship.',
        'join-check: accepts an optional sponsorId (the guildId /api/ad returned) to pin the check deterministically.',
        'Errors now include a machine code: { error, code }. /v1/api/* is available as the versioned alias of /api/*.',
        'Signed webhooks (credited / reverted) can be configured in your cabinet.'
    ] },
    { date: '2026-07-19', version: 1, breaking: true, changes: [
        'join-check no longer needs serverId — the shown sponsor is remembered per (bot, user).',
        'A membership is credited once per active join; a genuine leave-then-rejoin counts again.'
    ] },
    { date: '2026-07-17', version: 1, breaking: true, changes: [
        '/api/ad and /api/join-check now require botId (and /api/ad requires userId) so per-bot funnels and reward attribution work.'
    ] }
];

const DOCS = {
    name: 'Verification API',
    version: API_VERSION,
    versioning: 'Call /v1/api/... for the versioned path (bare /api/... stays supported). See GET /api/changelog for what changed.',
    auth: 'Send your API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`.',
    note: 'Two operational endpoints only. Reward your user ONLY when join-check returns status:"credited" (credited:true) — that is the single signal that a real sponsor join happened and you were paid. A join can only be credited when the sponsor server has the Vemoni bot on it (that is how we verify membership). Balance, stats, payout details and withdrawals are viewed in your cabinet on the site, not over the API.',
    errors: 'Errors are JSON: { error: "<human message>", code: "<machine code>" }. 401 invalid_key → bad/missing API key. 400 → a required field is missing (code names it). 429 → rate limited (see Retry-After). 503 uncertain → membership check temporarily unavailable, retry. Business outcomes (not joined / already counted / no ad) are 200, not 4xx.',
    rateLimit: 'Requests are rate limited per IP. On a 429 back off and honour the Retry-After header. In practice: poll /api/ad at most once per user action, and only call /api/join-check when the user presses your check button.',
    endpoints: {
        'GET /api/ad': 'The sponsor to show. ALL THREE query params are required: ?serverId=<your guild>&botId=<your bot app id>&userId=<the Discord user>. Returns { sponsor:{guildId,name,invite}|null, fallbackText }. Build your own message from sponsor.name + sponsor.invite. A sponsor the user is already in is skipped. sponsor null → no ad right now; do NOT promise a reward. 400 if any of serverId/botId/userId is missing.',
        'POST /api/join-check': 'Body: { userId, botId, sponsorId? }. userId + botId required; sponsorId is the guildId /api/ad returned — pass it to pin the check to that exact sponsor (deterministic when your bot ran several ad commands at once); omit it and we use the most recent ad shown to this user. serverId is not needed. We verify the shown sponsor, so a different server they already belong to never counts. Reward ONLY on status:"credited". Every response has a "status" field: "credited" → 200 { joined:true, credited:true } join verified and you were paid → GIVE the reward; "not_joined" → 200 { joined:false } not in the sponsor yet → ask them to join, no reward; "already_counted" → 200 { joined:true, credited:false, alreadyCounted:true } already credited for this sponsor → no reward; "no_ad" → 200 { joined:true, credited:false, ad:false } nothing was shown → no reward; "uncertain" → 503, retry. Each membership is paid once; leaving reverses it, a real rejoin counts again. userId is verified against real Discord membership, so passing IDs that did not actually join earns nothing.'
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

// How long the whole order book would take to deliver at the network's recent
// throughput. Backlog = unmet joins across every running campaign; throughput =
// ad-driven verifications over the last 7 days (smooths daily swings), as
// joins/hour. Used to warn buyers when the queue is longer than a day.
// Returns { overloaded, etaHours } — etaHours null means "no throughput at all".
function networkLoadEstimate() {
    const camps = campaigns.loadCampaigns();
    const verified = loadJSON('verified.json', []);
    const arr = Array.isArray(verified) ? verified : [];

    let backlog = 0;
    for (const c of Object.values(camps)) {
        if (!c || c.status !== 'active') continue;
        const del = campaigns.delivered(c, arr, camps);
        backlog += Math.max(0, (Number(c.purchased) || 0) - del);
    }
    if (backlog <= 0) return { overloaded: false, etaHours: 0 };

    // Rate is per hour of ACTIVE advertising, so an ads-off stretch neither drags
    // the number down nor inflates the ETA (see perf.js).
    const r = perf.rate(arr);
    if (!(r.perHour > 0)) return { overloaded: true, etaHours: null, perDay: 0, frozen: r.frozen };
    const etaHours = backlog / r.perHour;
    return {
        overloaded: etaHours > 24, etaHours: Math.round(etaHours),
        perDay: r.perDay, frozen: r.frozen, activeHours: r.activeHours
    };
}

// Look up a guild name across every fleet bot's cache. Any bot that shares
// the guild will resolve — falls back to null when nobody sees it.
function guildNameOf(clients, gid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const g = c.guilds?.cache?.get(String(gid));
        if (g) return g.name;
    }
    // Reserve-covered servers have no bot, so only the reserve account sees them.
    return reservegw.guildInfo(gid)?.name || null;
}

// Same lookup for the guild's icon (CDN URL, 64px). Null when no bot shares
// the guild or it has no icon — the frontend falls back to a letter tile.
function guildIconOf(clients, gid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const g = c.guilds?.cache?.get(String(gid));
        // Force a STATIC png: some servers' animated (a_) icons have a broken .gif
        // asset on Discord's CDN (returns 415), which renders as a broken avatar.
        // The static frame always works.
        if (g) return g.iconURL({ size: 64, extension: 'png', forceStatic: true }) || null;
    }
    // Reserve-covered servers: build the CDN URL from the account's guild data.
    const r = reservegw.guildInfo(gid);
    return (r && r.icon) ? `https://cdn.discordapp.com/icons/${r.id}/${r.icon}.png?size=64` : null;
}

// Member count across the fleet caches, falling back to the reserve account's
// view for servers no bot is on. Null when nobody can see the guild.
function guildMembersOf(clients, gid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const g = c.guilds?.cache?.get(String(gid));
        if (g) return g.memberCount ?? null;
    }
    const r = reservegw.guildInfo(gid);
    return (r && Number.isFinite(r.members)) ? r.members : null;
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
        if (u) { try { return u.displayAvatarURL({ size: 128, extension: 'png' }); } catch { return null; } }
    }
    return null;
}
// Post full info about a new website ad order to an ops channel. Best-effort:
// any failure (no bot on the guild, missing channel, send error) is swallowed so
// it can never break order creation. Channel/guild overridable via env.
async function notifyNewOrder(clients, o) {
    try {
        const notifyChannel = (process.env.ORDER_NOTIFY_CHANNEL || '1526627488527290419').trim();
        if (!notifyChannel) return;
        const channel = await poster.posterChannel(clients, notifyChannel);
        if (!channel || typeof channel.send !== 'function') return;
        const name = userNameOf(clients, o.buyerId);
        const handle = userHandleOf(clients, o.buyerId);
        const buyer = `<@${o.buyerId}>` + (name ? ` — ${name}${handle ? ' (@' + handle + ')' : ''}` : '') + `\n\`${o.buyerId}\``;
        const fields = [
            { name: '👤 Покупатель', value: buyer, inline: false },
            { name: '📣 Сервер', value: `${o.serverName || '—'}\n\`${o.sponsorGuildId}\``, inline: true },
            { name: '🔗 Инвайт', value: o.invite || '—', inline: true },
            { name: '👥 Заходов заказано', value: String(o.joins), inline: true },
            { name: '💵 Сумма', value: `$${Number(o.price).toFixed(2)} ($${Number(o.pricePer100).toFixed(2)} / 100)`, inline: true },
            { name: '💳 Оплата', value: 'с баланса кабинета', inline: true },
            { name: '🆔 Кампания', value: `\`${o.campaignId}\``, inline: true }
        ];
        if (o.isManager) fields.push({ name: '🧑‍💼 Менеджер', value: `да · комиссия ${Math.round((o.commissionRate || 0) * 100)}%`, inline: true });
        await channel.send({
            embeds: [{ title: '🛒 Новый заказ рекламы через сайт', color: 0x5865F2, fields, timestamp: new Date().toISOString() }],
            allowedMentions: { parse: [] }
        }).catch(() => null);
    } catch { /* never break order creation */ }
}

// The @username (handle), distinct from the display/global name.
function userHandleOf(clients, uid) {
    for (const c of Array.isArray(clients) ? clients : []) {
        const u = c.users?.cache?.get(String(uid));
        if (u) return u.username || null;
    }
    return null;
}
// Compact identity for the account menu: { userId, name, username, avatar }.
function userMiniOf(clients, uid) {
    return { userId: String(uid), name: userNameOf(clients, uid), username: userHandleOf(clients, uid), avatar: userAvatarOf(clients, uid) };
}
// The user's Discord profile banner. The banner hash is not present on cached
// users, so force-fetch once and cache the result for an hour (null → the
// frontend derives a banner from the avatar colour).
const _bannerCache = new Map();
// Buyers with a wallet reconciliation currently running in the background, so a
// new /wallet poll doesn't stack another set of slow gateway calls on top.
const _walletReconciling = new Set();
async function userBannerOf(clients, uid) {
    uid = String(uid);
    const hit = _bannerCache.get(uid);
    // cache real URLs for an hour; retry misses/failures after a minute
    if (hit && (Date.now() - hit.at) < (hit.url ? 3600e3 : 60e3)) return hit.url;
    for (const c of Array.isArray(clients) ? clients : []) {
        try {
            const data = await c.rest.get('/users/' + uid); // raw Discord user, includes the banner hash
            let url = null;
            if (data && data.banner) {
                const ext = String(data.banner).startsWith('a_') ? 'gif' : 'png';
                url = 'https://cdn.discordapp.com/banners/' + uid + '/' + data.banner + '.' + ext + '?size=600';
            }
            _bannerCache.set(uid, { url, at: Date.now() });
            return url;
        } catch (_) { /* try next client */ }
    }
    _bannerCache.set(uid, { url: null, at: Date.now() });
    return null;
}

// Like userMiniOf, but if the user isn't in any bot cache, force-fetch it via
// REST (cached 1h) so we still get a real username/avatar — used for referrals,
// whose referred users are usually not cached.
const _userCache = new Map();
async function userMiniLive(clients, uid) {
    uid = String(uid);
    const cached = userMiniOf(clients, uid);
    if (cached.username) return cached; // already resolvable from a cache
    const hit = _userCache.get(uid);
    if (hit && (Date.now() - hit.at) < 3600e3) return hit.v;
    for (const c of Array.isArray(clients) ? clients : []) {
        try {
            const d = await c.rest.get('/users/' + uid);
            const av = (d && d.avatar) ? `https://cdn.discordapp.com/avatars/${uid}/${d.avatar}.${String(d.avatar).startsWith('a_') ? 'gif' : 'png'}?size=128` : null;
            const v = { userId: uid, name: (d && (d.global_name || d.username)) || null, username: (d && d.username) || null, avatar: av };
            _userCache.set(uid, { v, at: Date.now() });
            return v;
        } catch (_) { /* try next client */ }
    }
    return cached;
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
        return send(res, 200, sess ? { authed: true, ...(await userMiniLive(clients, sess.userId)), banner: await userBannerOf(clients, sess.userId), role: sess.role, isAdmin: Boolean(adminAuth.roleOf(sess.userId)) } : { authed: false }, cors);
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
        const q = new URL(req.url, 'http://x').searchParams;
        const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 300));
        const action = (q.get('action') || '').trim();   // exact action or a group ('bot', 'card', …)
        const user = (q.get('user') || '').trim();
        const periodMs = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[q.get('period')];
        const since = periodMs ? Date.now() - periodMs : 0;
        const oldest = q.get('sort') === 'oldest';
        let list = audit.loadAudit();
        if (action) list = list.filter((e) => e.action === action || String(e.action).split('.')[0] === action);
        if (/^\d{17,20}$/.test(user)) list = list.filter((e) => e.userId === user);
        if (since) list = list.filter((e) => (e.ts || 0) >= since);
        list = list.slice().sort((a, b) => oldest ? (a.ts || 0) - (b.ts || 0) : (b.ts || 0) - (a.ts || 0));
        const entries = list.slice(0, limit).map((e) => ({ ...e, userName: userNameOf(clients, e.userId) }));
        return send(res, 200, { entries, total: list.length }, cors);
    }

    // Auction lots: list history/results, and launch a new lot. Any admin may
    // view and launch; only the owner may edit the launch-message template.
    if (path === '/admin/lots' && req.method === 'GET') {
        const view = lots.list().map((l) => ({
            id: l.id, status: l.status, stays: l.stays, start: l.start, step: l.step,
            highest: l.highest, highestBidder: l.highestBidder,
            highestBidderName: l.highestBidder ? (userNameOf(clients, l.highestBidder) || null) : null,
            bidsCount: Array.isArray(l.bids) ? l.bids.length : 0,
            guildId: l.guildId, channelId: l.channelId,
            createdAt: l.createdAt, closedAt: l.closedAt, lastBidAt: l.lastBidAt,
            winnerId: l.winnerId, winnerBid: l.winnerBid,
            winnerName: l.winnerId ? (userNameOf(clients, l.winnerId) || null) : null,
            bids: (Array.isArray(l.bids) ? l.bids : []).slice(-20).map((b) => ({
                userId: b.userId, name: b.username || userNameOf(clients, b.userId) || null, amount: b.amount, ts: b.ts
            }))
        }));
        // The launch-message template + channel name are owner-only — don't expose to admins.
        return send(res, 200, { lots: view, guildId: lotmon.GUILD_ID, winMs: lotmon.WIN_MS, template: isOwner ? lots.getTemplate() : null, channelName: isOwner ? lots.getChannelName() : null }, cors);
    }
    if (path === '/admin/lots/template' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const template = lots.setTemplate(body.text);
        auditDo('lots.template', `${String(template).length} chars`);
        return send(res, 200, { ok: true, template }, cors);
    }
    if (path === '/admin/lots/channel-name' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const channelName = lots.setChannelName(body.text);
        auditDo('lots.channelName', channelName);
        return send(res, 200, { ok: true, channelName }, cors);
    }
    if (path === '/admin/lots' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const r = await lotmon.createLot(clients, { stays: body.stays, start: body.start, step: body.step });
        if (!r.ok) return send(res, r.error === 'no-bot-on-guild' || r.error === 'no-guild' ? 409 : 400, r, cors);
        return send(res, 200, r, cors);
    }

    // Runtime settings (owner-only): view + edit env-backed config without Railway.
    // Most keys apply on the next restart; the reserve tokens apply live.
    if (path === '/admin/config' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        // Reserve status rides along so the token field can show what the
        // account(s) actually cover — the fastest way to spot a dead token.
        const covered = await usertoken.coveredGuildIds().catch(() => new Set());
        return send(res, 200, {
            categories: runtimeConfig.adminView(),
            reserve: {
                enabled: usertoken.enabled(),
                gateway: reservegw.enabled() && reservegw.ready(),
                guilds: [...covered].map((g) => ({ id: g, name: guildNameOf(clients, g) || g }))
            }
        }, cors);
    }
    // Reveal one secret's current value (owner only) — backs the "show tokens"
    // toggle, since the normal view masks secrets. Audited.
    if (path === '/admin/config/reveal' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
        if (!runtimeConfig.KEYS.has(key)) return send(res, 400, { error: 'bad key' }, cors);
        auditDo('config.reveal', key);
        return send(res, 200, { key, value: runtimeConfig.get(key) }, cors);
    }
    if (path === '/admin/config' && req.method === 'PUT') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null || !body.values || typeof body.values !== 'object') return send(res, 400, { error: 'bad json' }, cors);
        // Never store a self-bot token that Discord rejects — a dead token covers
        // nothing and only looks like a working reserve. Checked before saving.
        if (typeof body.values.USER_TOKEN === 'string' && body.values.USER_TOKEN.trim()) {
            const chk = await usertoken.validateTokens(body.values.USER_TOKEN).catch(() => null);
            if (!chk) return send(res, 502, { error: 'token-check-failed' }, cors);
            if (chk.bad.length) return send(res, 400, { error: 'bad-tokens', bad: chk.bad, okCount: chk.ok.length }, cors);
        }
        runtimeConfig.setMany(body.values);
        auditDo('config.change', Object.keys(body.values).join(', ').slice(0, 300));
        // Reserve changes apply live: reconnect the gateway for the new token set
        // and drop the cached coverage, so "Сохранить" is enough — no restart.
        if ('USER_TOKEN' in body.values || 'RESERVE_GATEWAY' in body.values) {
            usertoken.invalidate();
            try { reservegw.sync(); } catch (e) { console.error('[RESERVE_GW] sync failed:', e.message); }
        }
        // Bot presence applies live too — re-push it to every bot.
        if (['BOT_STATUS', 'BOT_STATUS_TYPE', 'BOT_PRESENCE', 'BOT_STATUS_URL'].some((k) => k in body.values)) {
            try { presence.applyAll(clients); } catch (e) { console.error('[PRESENCE] apply failed:', e.message); }
        }
        return send(res, 200, { ok: true, categories: runtimeConfig.adminView() }, cors);
    }
    if (path === '/admin/config/restart' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        auditDo('config.restart', '');
        send(res, 200, { ok: true }, cors);
        // Railway restart policy is ALWAYS (railway.json), so a clean exit is
        // restarted automatically. (Under the previous default ON_FAILURE policy
        // exit(0) did NOT restart — the container stayed down.)
        console.log('[CONFIG] restart requested from admin panel — exiting to reload');
        setTimeout(() => process.exit(0), 400);
        return;
    }

    // Verification-activity series for the Statistics chart. Returns ALL THREE
    // funnel stages at once so the panel can draw them together and toggle any of
    // them off: first click -> join checked -> still on the server. Counts are
    // bucketed over the range across every server with a LIVE card.
    //   ?servers=gid,gid  scopes the totals to those servers AND returns their
    //                     own bucketed rows (bounded to 8) for comparison.
    // Payload stays small: per-server ROWS only for the selected few; the chip
    // list carries scalar counts only. Any admin may read.
    if (path.startsWith("/admin/verif-series") && req.method === "GET") {
        const q = new URL(req.url, "http://x").searchParams;
        const range = ["day", "week", "month", "all"].includes(q.get("range")) ? q.get("range") : "day";
        const sel = String(q.get("servers") || "").split(",").map((x) => x.trim())
            .filter((x) => /^\d{17,20}$/.test(x)).slice(0, 8);
        const selSet = new Set(sel);
        const now = Date.now();

        // Only servers with a live (non-deleted) verification card.
        const activeGuilds = new Set();
        for (const c of cards.loadCards()) if (c && !c.deletedAt && c.guildId) activeGuilds.add(String(c.guildId));

        // Flatten each stage into { t, gid } events.
        //  clicks  - cardclicks.json (key "guildId:roleId:creatorId"); one event per
        //            started session, pruned to 7 days on write (see CLICK_TTL).
        //  stayed  - verified.json (leavers are removed from it).
        //  checked - everyone who verified: still-standing + clawed-back leavers.
        const vArr = (() => { const v = loadJSON("verified.json", []); return Array.isArray(v) ? v : []; })();
        const jArr = (() => { const j2 = loadJSON("joinlinks.json", []); return Array.isArray(j2) ? j2 : []; })();
        const cArr = (() => { const c2 = loadJSON("cardclicks.json", []); return Array.isArray(c2) ? c2 : []; })();
        const ev = { clicks: [], checked: [], stayed: [] };
        for (const e of cArr) { const gid = String(e.k || "").split(":")[0]; if (activeGuilds.has(gid)) ev.clicks.push({ t: Number(e.t) || 0, gid }); }
        for (const u of vArr) {
            const gid = String(u.guildId || ""); if (!activeGuilds.has(gid)) continue;
            const t = Number(u.timestamp) || 0;
            ev.stayed.push({ t, gid }); ev.checked.push({ t, gid });
        }
        for (const r of jArr) {
            if (!r || r.status !== "left") continue;
            const gid = String(r.cardGuildId || ""); if (!activeGuilds.has(gid)) continue;
            ev.checked.push({ t: Number(r.ts) || 0, gid });
        }

        const SPEC = {
            day: { span: 86400000, bucket: 15 * 60000 },
            week: { span: 7 * 86400000, bucket: 2 * 3600000 },
            month: { span: 30 * 86400000, bucket: 12 * 3600000 },
            all: { span: null, bucket: 86400000 }
        }[range];
        let span = SPEC.span;
        if (span == null) { // "all time" -> from the earliest event on a carded server
            let first = now;
            for (const k of ["clicks", "checked", "stayed"]) for (const e of ev[k]) if (e.t && e.t < first) first = e.t;
            span = Math.max(86400000, now - first);
        }
        const bucket = SPEC.bucket;
        const n = Math.max(1, Math.min(400, Math.ceil(span / bucket)));
        const from = now - n * bucket;
        const idxOf = (t) => (!t || t < from) ? -1 : Math.min(n - 1, Math.floor((t - from) / bucket));

        // One pass per stage: totals over the scope, rows for the selected servers,
        // and scalar per-server counts for the chip list.
        const scoped = selSet.size > 0;
        const totals = {}; const rows = new Map(); const chips = new Map();
        for (const k of ["clicks", "checked", "stayed"]) {
            const total = new Array(n).fill(0);
            for (const e of ev[k]) {
                const i = idxOf(e.t); if (i < 0) continue;
                if (!scoped || selSet.has(e.gid)) total[i]++;
                if (selSet.has(e.gid)) {
                    let r2 = rows.get(e.gid); if (!r2) { r2 = {}; rows.set(e.gid, r2); }
                    let a = r2[k]; if (!a) { a = r2[k] = new Array(n).fill(0); }
                    a[i]++;
                }
                let ch = chips.get(e.gid); if (!ch) { ch = { clicks: 0, checked: 0, stayed: 0 }; chips.set(e.gid, ch); }
                ch[k]++;
            }
            totals[k] = total;
        }
        const servers = [...chips.entries()]
            .map(([gid, o]) => ({ gid, name: guildNameOf(clients, gid) || gid, icon: guildIconOf(clients, gid), ...o }))
            .sort((a, b) => b.checked - a.checked || b.clicks - a.clicks);
        const perServer = sel.map((gid) => {
            const meta = servers.find((x) => x.gid === gid);
            const r2 = rows.get(gid) || {};
            const z = () => new Array(n).fill(0);
            return { gid, name: (meta && meta.name) || gid, icon: (meta && meta.icon) || null, clicks: r2.clicks || z(), checked: r2.checked || z(), stayed: r2.stayed || z() };
        });
        return send(res, 200, { range, from, bucketMs: bucket, points: n, totals, perServer, servers, clicksTtlDays: 7 }, cors);
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
        // Solvency is measured against the NOWPayments custody balance — that's
        // where partner payouts actually come from now (LTC auto-payouts).
        const npBal = await nowpaymentsBalanceUsd();
        return send(res, 200, {
            owed: money(owed), accountsOwed,
            negative: money(negative), accountsNeg,
            withdrawnDone: money(withdrawnDone), withdrawnPending: money(withdrawnPending),
            paidOutJoins: money(paidOutJoins), clawedBack: money(clawedBack),
            adSales: sales.salesWindows(),
            walletsHeld: wallet.totalHeld(),
            prepaidUndelivered: money(prepaidUndelivered),
            nowpaymentsBalance: npBal, solvency: npBal != null ? money(npBal - owed) : null,
            solvent: npBal != null ? npBal >= owed : null
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
                if (t > start && t <= end) { rev += Number.isFinite(Number(r.revenue)) ? Number(r.revenue) : shares.REVENUE_PER_JOIN; joins++; }
            }
            weeks.push({ revenue: money(rev), joins });
        }

        const partners7 = new Set(), partners30 = new Set();
        for (const r of paid) { const t = Number(r.ts) || 0; if (t > now - WEEK) partners7.add(r.creatorId); if (t > now - 4 * WEEK) partners30.add(r.creatorId); }
        const joins7 = paid.filter((r) => (Number(r.ts) || 0) > now - WEEK).length;
        const joins30 = paid.filter((r) => (Number(r.ts) || 0) > now - 4 * WEEK).length;
        const left30 = jArr.filter((r) => r.status === 'left' && (Number(r.leftAt || r.ts) || 0) > now - 4 * WEEK).length;
        const churn = (joins30 + left30) > 0 ? left30 / (joins30 + left30) : 0;
        let rev30 = 0; for (const r of paid) if ((Number(r.ts) || 0) > now - 4 * WEEK) rev30 += Number.isFinite(Number(r.revenue)) ? Number(r.revenue) : shares.REVENUE_PER_JOIN;

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
        // Service profit per confirmed join = what we charge (shares.REVENUE_PER_JOIN)
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
            const rev = Number.isFinite(Number(r.revenue)) ? Number(r.revenue) : shares.REVENUE_PER_JOIN;
            const mgrMargin = Math.max(0, shares.REVENUE_PER_JOIN - rev);
            const acq = amt * shares.ACQUIRING_RATE;
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
            salePricePer100: shares.SALE_PRICE_PER_100,
            revenuePerJoin: shares.REVENUE_PER_JOIN,
            acquiringRate: shares.ACQUIRING_RATE,
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

        // Network-wide funnel (Vemoni's side, summed across EVERY server): first
        // click → join verified → still on the server. Same three stages as a
        // partner card, aggregated over all cards. clicks = unique (card,user)
        // pairs, so it matches the sum of what each server's card shows.
        const nfClick = (() => {
            const cl = loadJSON('cardclicks.json', []);
            const h = new Set(), d = new Set(), w = new Set();
            for (const e of Array.isArray(cl) ? cl : []) {
                const k = e.k + '|' + e.u;
                if (e.t > now - 3600000) h.add(k);
                if (e.t > now - 86400000) d.add(k);
                if (e.t > now - 604800000) w.add(k);
            }
            return { hour: h.size, day: d.size, week: w.size };
        })();
        // Split the same way the headline cards do, so the panel's "С рекламой /
        // Без рекламы" switch drives the funnel too:
        //   ads  — paid verifications (an ad was shown); leavers were clawed back,
        //          so checked = still-standing + left.
        //   noAd — organic ones. They never join-check a sponsor, so there's
        //          nothing to claw back and checked == stayed.
        // Clicks can't be split (cardclicks carry no adKey) — they're all starts.
        const nfWin = (arr, tsField) => ({
            hour: arr.filter((x) => (Number(x[tsField]) || 0) > now - 3600000).length,
            day: arr.filter((x) => (Number(x[tsField]) || 0) > now - 86400000).length,
            week: arr.filter((x) => (Number(x[tsField]) || 0) > now - 604800000).length
        });
        const nfPaidStayed = nfWin(paidEntries, 'timestamp');
        const nfLeft = nfWin(leftRecs, 'ts');
        const nfNoAdStayed = nfWin(entries.filter((u) => u.noAd), 'timestamp');
        const networkFunnel = {
            servers: perGuild.length,
            clicks: nfClick,
            ads: {
                checked: { hour: nfPaidStayed.hour + nfLeft.hour, day: nfPaidStayed.day + nfLeft.day, week: nfPaidStayed.week + nfLeft.week },
                stayed: nfPaidStayed
            },
            noAd: { checked: nfNoAdStayed, stayed: nfNoAdStayed }
        };

        return send(res, 200, {
            adsOff: Boolean(cfg.adsOff),
            adsOffAt: cfg.adsOffAt || 0,
            networkFunnel,
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
            nowpaymentsBalance: await nowpaymentsBalanceUsd(),
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
        const wallets = loadJSON('wallets.json', {});

        let users = [...new Set([...Object.keys(settings), ...Object.keys(wallets)])].map((uid) => {
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
                walletBalance: money(wallets[uid]?.balance || 0),
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
                autoLtc: Boolean(s.autoLtc),
                ltcAddress: s.ltcAddress || null,
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
            u.balance !== 0 || u.walletBalance !== 0 || u.verifications > 0 || u.withdrawnTotal > 0 ||
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
            autoLtc: Boolean(s.autoLtc),
            ltcAddress: s.ltcAddress || null,
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
            try { partnerlog.logEvent(userId, delta >= 0
                ? { type: 'credit', reason: 'admin_credit', amount: Math.abs(delta), srcId: `adj:${userId}:${Date.now()}` }
                : { type: 'debit', reason: 'admin_debit', amount: Math.abs(delta), srcId: `adj:${userId}:${Date.now()}` }); } catch (_) { /* never block */ }
            auditDo('balance.change', `${userId}: ${delta > 0 ? '+' : ''}${delta} → $${s.balance}`);
            if (delta > 0) maybeAutoWithdraw(clients, userId).catch(() => null);
            return send(res, 200, { ok: true, balance: s.balance }, cors);
        }
        if (field === 'wallet') {
            // The order-cabinet (buyer) wallet balance that funds ad campaigns.
            const delta = Number(body.delta);
            if (!Number.isFinite(delta)) return send(res, 400, { error: 'delta must be a number' }, cors);
            if (Math.abs(delta) > 1_000_000) return send(res, 400, { error: 'delta too large' }, cors);
            let bal;
            if (delta >= 0) bal = wallet.credit(userId, delta);
            else { bal = wallet.debit(userId, -delta); if (bal === null) return send(res, 400, { error: 'insufficient wallet balance', have: wallet.balanceOf(userId) }, cors); }
            auditDo('wallet.change', `${userId}: ${delta > 0 ? '+' : ''}${delta} → $${bal}`);
            return send(res, 200, { ok: true, wallet: bal }, cors);
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
        // LTC auto-payout: a toggle + the partner's own LTC address. Can't be
        // enabled without an address to send to.
        if (field === 'autoltc') {
            if (body.ltcAddress !== undefined) {
                const addr = String(body.ltcAddress || '').trim();
                // Legacy (L/M/3…) and bech32 (ltc1…) — length-checked, not validated on-chain.
                if (addr && !/^(ltc1[a-z0-9]{20,70}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,40})$/.test(addr)) {
                    return send(res, 400, { error: 'bad-ltc-address' }, cors);
                }
                s.ltcAddress = addr || null;
            }
            s.autoLtc = Boolean(body.autoLtc);
            if (s.autoLtc && !s.ltcAddress) return send(res, 400, { error: 'ltc-address-required' }, cors);
            saveJSON('settings.json', settings);
            auditDo('autoltc', `${userId}: ${s.autoLtc ? 'on' : 'off'}${s.ltcAddress ? ' addr=' + s.ltcAddress : ''}`);
            return send(res, 200, { ok: true, autoLtc: s.autoLtc, ltcAddress: s.ltcAddress || null, payoutReady: nowpayments.payoutEnabled() }, cors);
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
        for (const c of clients) { inv = await rateLimit.schedule(() => c.fetchInvite(code)).catch(() => null); if (inv) break; }
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
    // Owner-only: set/clear a feed server's custom avatar (applies to the marquee
    // AND the hero globe everywhere the feed is used). Body: { code|id, img }.
    if (path === '/admin/feed/avatar' && req.method === 'POST') {
        if (!isOwner) return ownerOnly();
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const key = String(body?.code || body?.id || '');
        if (!key) return send(res, 400, { error: 'bad request' }, cors);
        const img = body?.img == null ? '' : String(body.img).trim();
        if (img && !/^https?:\/\/.{3,}/i.test(img)) return send(res, 400, { error: 'bad-url' }, cors);
        const servers = feed.setAvatar(key, img);
        if (!servers) return send(res, 404, { error: 'not-found' }, cors);
        auditDo('feed.avatar', `${key} → ${img || '(cleared)'}`);
        return send(res, 200, { ok: true, servers }, cors);
    }

    // Owner-only: verification-card registry + remote management.
    if (path === '/admin/cards' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const { list, avgVerifySeconds } = enrichCards(clients, cards.loadCards());
        const active = list.filter((c) => !c.deletedAt).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const deleted = list.filter((c) => c.deletedAt).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
        return send(res, 200, { cards: active, deletedCards: deleted, avgVerifySeconds, extra: extraad.stats() }, cors);
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
    // guildId -> { ownerId, messageId } for one active card on each server, so the
    // admin panel can deep-link a server name to its owner's partner cabinet at
    // that card. When a server has several active cards, a pseudo-random one is
    // kept (deterministic, but not always the same first one).
    if (path === '/admin/guild-cards' && req.method === 'GET') {
        if (!isOwner) return ownerOnly();
        const byGuild = {};
        for (const c of cards.loadCards()) {
            if (!c || c.deletedAt || !c.guildId || !c.creatorId || !c.messageId) continue;
            (byGuild[c.guildId] ||= []).push({ ownerId: String(c.creatorId), messageId: String(c.messageId) });
        }
        const map = {};
        for (const [gid, list] of Object.entries(byGuild)) map[gid] = list[Math.floor(Math.random() * list.length)]; // random active card
        return send(res, 200, { guildCards: map }, cors);
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
            ? { authed: true, ...(await userMiniLive(clients, sess.userId)), banner: await userBannerOf(clients, sess.userId), isOwner: sess.userId === adminAuth.OWNER_ID, isManager: managers.isManager(sess.userId), isAdmin: Boolean(adminAuth.roleOf(sess.userId)), dmall: dmaccess.isDmall(sess.userId) }
            : { authed: false }, cors);
    }
    if (await handleLoginCode(req, res, path, clients, cors)) return;

    const sess = buyerSessionOf(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' }, cors);
    const buyerId = sess.userId;
    // Owner or an assigned admin may view and manage ANY buyer's campaigns.
    const isAdminBuyer = buyerId === adminAuth.OWNER_ID || Boolean(adminAuth.roleOf(buyerId));

    if (path === '/order/config' && req.method === 'GET') {
        const isMgr = managers.isManager(buyerId);
        return send(res, 200, {
            networkLoad: networkLoadEstimate(),
            pricePer100: isMgr ? managers.PRICE_PER_100 : campaigns.PRICE_PER_100,
            publicPricePer100: campaigns.PRICE_PER_100,
            minJoins: campaigns.MIN_JOINS,
            cryptoEnabled: cryptopay.enabled(),
            isOwner: buyerId === adminAuth.OWNER_ID,
            isAdmin: Boolean(adminAuth.roleOf(buyerId)),
            isManager: isMgr,
            botInviteUrl: process.env.BOT_INVITE_URL || 'https://discord.com/oauth2/authorize?client_id=1522609323090509905&permissions=268435456&scope=bot'
        }, cors);
    }

    // The buyer's admin guilds (captured at OAuth login) for the DMALL server
    // picker. `bot` reflects whether a network bot is already in the guild.
    if (path === '/order/servers' && req.method === 'GET') {
        const cdn = (kind, id, hash, size) => hash ? `https://cdn.discordapp.com/${kind}/${id}/${hash}.${String(hash).startsWith('a_') ? 'gif' : 'png'}?size=${size}` : '';
        const list = (adminAuth.getUserGuilds(buyerId) || []).map((g) => ({
            id: g.id,
            name: g.name,
            avatar: cdn('icons', g.id, g.icon, 128),
            banner: cdn('banners', g.id, g.banner, 480),
            online: g.approximate_presence_count != null ? g.approximate_presence_count : (g.approximate_member_count != null ? g.approximate_member_count : null),
            bot: (Array.isArray(clients) ? clients : []).some((c) => c && c.guilds && c.guilds.cache && c.guilds.cache.has(g.id))
        }));
        list.sort((a, b) => (b.bot ? 1 : 0) - (a.bot ? 1 : 0) || ((b.online || 0) - (a.online || 0))); // bot-present first
        return send(res, 200, { servers: list }, cors);
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

    // Self-serve developer API key (for the "For developers" page). A logged-in
    // user can view or (re)generate their own key for the /api/* endpoints.
    if (path === '/order/api-key' && req.method === 'GET') {
        const keys = loadJSON('apikeys.json');
        const found = Object.keys(keys).find((k) => keys[k] && keys[k].userId === buyerId);
        return send(res, 200, { key: found || null }, cors);
    }
    if (path === '/order/api-key' && req.method === 'POST') {
        const body = await readBody(req);
        const regen = !!(body && body.regenerate);
        const keys = loadJSON('apikeys.json');
        const found = Object.keys(keys).find((k) => keys[k] && keys[k].userId === buyerId);
        if (found && !regen) return send(res, 200, { key: found, created: false }, cors);
        if (found) { for (const k of Object.keys(keys)) if (keys[k] && keys[k].userId === buyerId) delete keys[k]; saveJSON('apikeys.json', keys); }
        const key = createApiKey(buyerId, 'self-serve');
        audit.logAction(buyerId, regen ? 'apikey.regenerate' : 'apikey.create', '');
        return send(res, 200, { key, created: true }, cors);
    }

    // Developer webhook config (signed credited/reverted callbacks). The secret is
    // never returned — only whether one is set.
    if (path === '/order/webhook' && req.method === 'GET') {
        const c = webhooks.getConfig(buyerId);
        return send(res, 200, { url: (c && c.url) || null, hasSecret: !!(c && c.secret) }, cors);
    }
    if (path === '/order/webhook' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const url = String(body.url || '').trim();
        if (url && !/^https:\/\/.+/i.test(url)) return send(res, 400, { error: 'url must be https://…' }, cors);
        const rec = webhooks.setConfig(buyerId, url, body.secret != null ? String(body.secret) : undefined);
        audit.logAction(buyerId, url ? 'webhook.set' : 'webhook.clear', '');
        return send(res, 200, { url: (rec && rec.url) || null, hasSecret: !!(rec && rec.secret) }, cors);
    }

    // Developer API funnels, grouped by the caller's bots. Started = ad shown
    // (apiclicks), Checked = confirmed sponsor join (joinlinks, roleId 'api'),
    // Stayed = still a member. Unique users per hour/day/week.
    if (path === '/order/bot-funnels' && req.method === 'GET') {
        const now = Date.now(), H = 3600000, D = 86400000, W = 604800000;
        const clicks = loadJSON('apiclicks.json', []);
        const jl = loadJSON('joinlinks.json', []);
        const bots = new Map();
        const ensure = (b) => { if (!bots.has(b)) bots.set(b, { started: [new Set(), new Set(), new Set()], checked: [new Set(), new Set(), new Set()], stayed: [new Set(), new Set(), new Set()] }); return bots.get(b); };
        const add = (sets, t, u) => { if (t > now - H) sets[0].add(u); if (t > now - D) sets[1].add(u); if (t > now - W) sets[2].add(u); };
        for (const e of (Array.isArray(clicks) ? clicks : [])) { if (e.c !== buyerId || !e.b) continue; add(ensure(e.b).started, Number(e.t) || 0, e.u); }
        for (const r of (Array.isArray(jl) ? jl : [])) {
            if (!r || r.creatorId !== buyerId || r.roleId !== 'api' || !r.botId) continue;
            const t = Number(r.ts) || 0, rec = ensure(r.botId);
            add(rec.checked, t, r.userId);
            if (r.status === 'joined' || r.status === 'settled') add(rec.stayed, t, r.userId);
        }
        const win = (s) => ({ hour: s[0].size, day: s[1].size, week: s[2].size });
        const list = [];
        for (const [b, v] of bots) {
            const mini = await userMiniLive(clients, b).catch(() => ({}));
            list.push({ botId: b, name: mini.name || null, username: mini.username || null, avatar: mini.avatar || null, started: win(v.started), checked: win(v.checked), stayed: win(v.stayed) });
        }
        list.sort((a, b) => (b.checked.week - a.checked.week) || (b.started.week - a.started.week));
        return send(res, 200, { bots: list }, cors);
    }

    // Owner-only: list / add / remove users granted access to the DMALL console.
    if (path === '/order/dmall-access' && req.method === 'GET') {
        if (buyerId !== adminAuth.OWNER_ID) return send(res, 403, { error: 'owner only' }, cors);
        return send(res, 200, { users: dmaccess.loadAccess() }, cors);
    }
    if (path === '/order/dmall-access' && req.method === 'PUT') {
        if (buyerId !== adminAuth.OWNER_ID) return send(res, 403, { error: 'owner only' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const uid = String(body?.userId || '');
        if (!/^\d{17,20}$/.test(uid)) return send(res, 400, { error: 'bad user id' }, cors);
        const list = dmaccess.loadAccess();
        const next = body?.remove ? list.filter((x) => x !== uid) : [...list, uid];
        audit.logAction(buyerId, body?.remove ? 'dmall.remove' : 'dmall.add', uid);
        return send(res, 200, { ok: true, users: dmaccess.saveAccess(next) }, cors);
    }

    // Wallet: balance + recent top-ups (reconciles pending top-ups first).
    if (path === '/order/wallet' && req.method === 'GET') {
        // Reconcile pending top-ups against the payment gateways in the BACKGROUND.
        // These are slow external HTTP calls (CryptoBot / NOWPayments / Cryptomus)
        // and must never block the balance response — otherwise the whole cabinet
        // stalls and, since this response also carries the payment-enabled flags,
        // top-up falsely shows "unavailable" for the first seconds after a load.
        // Settlements still land via the gateway webhooks; this is just a fallback,
        // so a payment made right now appears on the next poll (every 15s). Skipped
        // when a reconcile for this buyer is already running.
        if (!_walletReconciling.has(buyerId)) {
            _walletReconciling.add(buyerId);
            (async () => {
                try {
                    await wallet.reconcileTopups(buyerId, campaigns.isInvoicePaid).catch(() => null);
                    if (nowpayments.enabled()) {
                        for (const t of wallet.pendingByProvider(buyerId, 'nowpayments')) {
                            if (!t.paymentId) continue;
                            const info = await nowpayments.paymentInfo(t.paymentId).catch(() => null);
                            if (info && String(info.order_id) === String(t.orderId) && nowpayments.isPaidStatus(info.payment_status)) {
                                wallet.settlePending(buyerId, { orderId: t.orderId });
                            }
                        }
                    }
                    if (cryptomus.enabled()) {
                        for (const t of wallet.pendingByProvider(buyerId, 'cryptomus')) {
                            const st = await cryptomus.paymentStatus(t.orderId).catch(() => null);
                            if (cryptomus.isPaidStatus(st)) wallet.settlePending(buyerId, { orderId: t.orderId });
                        }
                    }
                } catch (_) { /* background best-effort */ }
                finally { _walletReconciling.delete(buyerId); }
            })();
        }
        const minTopup = managers.isManager(buyerId) ? managers.MIN_TOPUP : wallet.MIN_TOPUP;
        return send(res, 200, {
            balance: wallet.balanceOf(buyerId),
            topups: wallet.recentTopups(buyerId),
            minTopup,
            cryptoEnabled: cryptopay.enabled(),
            cryptoWebEnabled: nowpayments.enabled() || cryptomus.enabled()
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

    // Top up the wallet via a hosted WEB checkout — the buyer pays from ANY crypto
    // wallet (no Telegram / no bot). Prefers NOWPayments, falls back to Cryptomus if
    // only that one is configured. Body: { amount }.
    if ((path === '/order/wallet/topup/web' || path === '/order/wallet/topup/cryptomus') && req.method === 'POST') {
        const useNow = nowpayments.enabled();
        if (!useNow && !cryptomus.enabled()) return send(res, 503, { error: 'Оплата криптой временно недоступна' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const amount = +(Number(body?.amount) || 0).toFixed(2);
        const minTopup = managers.isManager(buyerId) ? managers.MIN_TOPUP : wallet.MIN_TOPUP;
        if (!(amount >= minTopup)) return send(res, 400, { error: 'min-topup' }, cors);
        const provider = useNow ? 'nowpayments' : 'cryptomus';
        const orderId = `topup:${buyerId}:${crypto.randomBytes(5).toString('hex')}`;
        const apiBase = (process.env.PUBLIC_API_BASE || `https://${req.headers.host}`).replace(/\/+$/, '');
        let pay = null;
        try {
            pay = useNow
                ? await nowpayments.createPayment({ amount: amount.toFixed(2), orderId, callbackUrl: apiBase + '/nowpayments/webhook', returnUrl: 'https://vemoni.info/order/' })
                : await cryptomus.createPayment({ amount: amount.toFixed(2), orderId, callbackUrl: apiBase + '/cryptomus/webhook', returnUrl: 'https://vemoni.info/order/' });
        } catch (e) { return send(res, 502, { error: 'invoice-failed' }, cors); }
        if (!pay || !pay.url) return send(res, 502, { error: 'invoice-failed' }, cors);
        wallet.addTopup(buyerId, { provider, orderId, amount, status: 'pending', createdAt: Date.now() });
        return send(res, 200, { ok: true, invoiceUrl: pay.url, amount }, cors);
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
        for (const c of clients) { inv = await rateLimit.schedule(() => c.fetchInvite(inviteCode)).catch(() => null); if (inv) break; }
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
        // Fire-and-forget ops notification with full order details.
        notifyNewOrder(clients, {
            buyerId, serverName: inv.guild?.name || null, sponsorGuildId,
            invite: `https://discord.gg/${inviteCode}`, joins, price, pricePer100,
            isManager: isMgr, commissionRate: isMgr ? managers.COMMISSION_RATE : 0, campaignId: id
        });
        return send(res, 200, { ok: true, price, balance: wallet.balanceOf(buyerId), campaign: campaigns.publicView(camps[id]) }, cors);
    }

    // My campaigns (reconcile first: purges dead legacy unpaid campaigns and
    // completes finished ones).
    if (path === '/order/campaigns' && req.method === 'GET') {
        campaigns.reconcile(clients).catch(() => null); // fire-and-forget: don't block the list load on sequential invite re-checks (the 60s background sweep keeps statuses fresh)
        const camps = campaigns.loadCampaigns();
        const verified = loadJSON('verified.json', []);
        const joinlinks = loadJSON('joinlinks.json', []);
        // "botPresent" here drives the "add the bot" warning. Treat a server as
        // covered when a network bot is on it OR the reserve account is (invisible
        // fallback) — so a reserve-covered campaign doesn't show a false
        // "won't run without a bot" warning, without revealing the reserve.
        const covered = await coveredGuildIds(clients);
        const queueOf = queueResolver(camps, verified, covered);
        const mine = Object.values(camps).filter((c) => c.buyerId === buyerId && c.status !== 'pending_payment')
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .map((c) => ({ ...campaigns.publicView(c, verified), botPresent: campaigns.botPresent(c, covered), retention: campaigns.retention(c, verified, joinlinks), queue: queueOf(c) }));
        return send(res, 200, { campaigns: mine }, cors);
    }

    // Admin/owner/manager: every buyer's campaigns. ?scope=active (queue order) | done.
    // Managers get the same two "all orders" views as admins — that's where the
    // service-side priority pin is set.
    if (path === '/order/all-campaigns' && req.method === 'GET') {
        if (!isAdminBuyer && !managers.isManager(buyerId)) return send(res, 403, { error: 'staff only' }, cors);
        campaigns.reconcile(clients).catch(() => null); // fire-and-forget: don't block the list load on sequential invite re-checks (the 60s background sweep keeps statuses fresh)
        const scope = new URL(req.url, 'http://x').searchParams.get('scope') === 'done' ? 'done' : 'active';
        const camps = campaigns.loadCampaigns();
        const verified = loadJSON('verified.json', []);
        const joinlinks = loadJSON('joinlinks.json', []);
        const covered = await coveredGuildIds(clients);
        const queueOf = queueResolver(camps, verified, covered);
        const pinId = adminPriorityId();
        const wanted = scope === 'done'
            ? (c) => c.status !== 'active' && c.status !== 'pending_payment'
            : (c) => c.status === 'active';
        const fifoKey = (c) => Number(c.paidAt) || Number(c.createdAt) || 0;
        const list = Object.values(camps).filter((c) => c && wanted(c))
            .sort((a, b) => {
                if (scope !== 'done') { // pinned first, then real queue (FIFO) order
                    const ap = a.id === pinId ? 0 : 1, bp = b.id === pinId ? 0 : 1;
                    if (ap !== bp) return ap - bp;
                    return fifoKey(a) - fifoKey(b) || String(a.id).localeCompare(String(b.id));
                }
                return (Number(b.completedAt) || Number(b.createdAt) || 0) - (Number(a.completedAt) || Number(a.createdAt) || 0);
            })
            .map((c) => ({
                ...campaigns.publicView(c, verified),
                botPresent: campaigns.botPresent(c, covered),
                retention: campaigns.retention(c, verified, joinlinks),
                queue: queueOf(c),
                admin: true, pinned: c.id === pinId, buyerId: c.buyerId, buyerName: userNameOf(clients, c.buyerId) || null
            }));
        return send(res, 200, { campaigns: list, adminPriorityCampaignId: pinId }, cors);
    }

    // Service admin/manager: set (or clear) the GLOBAL priority pin. Body:
    // { campaignId } — empty clears. One campaign pinned network-wide; it leads the
    // queue wherever a partner hasn't set their own per-server pin (partner wins).
    if (path === '/order/priority' && req.method === 'PUT') {
        if (!isAdminBuyer && !managers.isManager(buyerId)) return send(res, 403, { error: 'staff only' }, cors);
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const cid = String(body?.campaignId || '').trim();
        const cfg = loadJSON('siteconfig.json', {});
        if (!cid) {
            delete cfg.adminPriorityCampaignId;
            saveJSON('siteconfig.json', cfg);
            audit.logAction(buyerId, 'order.priority', 'cleared');
            return send(res, 200, { ok: true, adminPriorityCampaignId: null }, cors);
        }
        const camps = campaigns.loadCampaigns();
        const c = camps[cid];
        if (!c || c.status !== 'active') return send(res, 400, { error: 'not-active' }, cors);
        cfg.adminPriorityCampaignId = cid;
        saveJSON('siteconfig.json', cfg);
        audit.logAction(buyerId, 'order.priority', `${cid} (buyer ${c.buyerId})`);
        return send(res, 200, { ok: true, adminPriorityCampaignId: cid }, cors);
    }

    // Per-server delivery breakdown for one campaign.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/servers') && req.method === 'GET') {
        const id = path.slice('/order/campaigns/'.length, -('/servers'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || (c.buyerId !== buyerId && !isAdminBuyer)) return send(res, 404, { error: 'not found' }, cors);
        const keys = campaigns.campaignAdKeys(c);
        const verified = loadJSON('verified.json', []);
        const perGuild = {};   // gid   -> { paid:Set, extra:Set }  (in-Discord / server delivery)
        const perBot = {};     // botId -> { paid:Set, extra:Set }  (developer-API delivery through a bot)
        for (const u of Array.isArray(verified) ? verified : []) {
            if (!keys.has(u.adKey) || (c.paidAt && u.timestamp < c.paidAt)) continue;
            // API deliveries are shown INSIDE a bot, not on a server card — group
            // them by the bot (so the buyer sees the bot's name, not a guild).
            if (u.roleId === 'api' && u.botId) {
                const b = (perBot[u.botId] ||= { paid: new Set(), extra: new Set() });
                (u.viaExtra ? b.extra : b.paid).add(u.id);
            } else {
                const g = (perGuild[u.guildId] ||= { paid: new Set(), extra: new Set() });
                (u.viaExtra ? g.extra : g.paid).add(u.id);
            }
        }
        const rowOf = (extra, paidSize, base) => {
            // `count` = PAID joins (partner was paid). Admin also sees how many came
            // via the EXTRA bonus ad (a paid join for the same user counts as paid).
            const row = { ...base, count: paidSize };
            if (isAdminBuyer) row.extra = extra;
            return row;
        };
        let servers = Object.entries(perGuild).map(([gid, g]) =>
            rowOf([...g.extra].filter((uid) => !g.paid.has(uid)).length, g.paid.size,
                { gid, name: guildNameOf(clients, gid), icon: guildIconOf(clients, gid), disabled: (c.disabledGuilds || []).includes(gid) }));
        // Resolve each bot's name/avatar and render it as a row alongside servers.
        const botRows = await Promise.all(Object.entries(perBot).map(async ([bid, b]) => {
            const mini = await userMiniLive(clients, bid).catch(() => null);
            return rowOf([...b.extra].filter((uid) => !b.paid.has(uid)).length, b.paid.size,
                { isBot: true, botId: bid, name: (mini && (mini.name || mini.username)) || `Bot ${bid}`, icon: (mini && mini.avatar) || null, disabled: (c.disabledBots || []).includes(bid) });
        }));
        servers = servers.concat(botRows);
        // Non-admins (buyer / partner / manager) don't see extra-only rows.
        if (!isAdminBuyer) servers = servers.filter((s) => s.count > 0);
        servers.sort((a, b) => b.count - a.count || ((b.extra || 0) - (a.extra || 0)));
        return send(res, 200, { servers }, cors);
    }

    // Pause / resume a campaign.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/pause') && req.method === 'POST') {
        const id = path.slice('/order/campaigns/'.length, -('/pause'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || (c.buyerId !== buyerId && !isAdminBuyer)) return send(res, 404, { error: 'not found' }, cors);
        // Only a running campaign can be paused/resumed — pausing a complete or
        // invalid one would show a misleading "active, not paused" state.
        if (c.status !== 'active') return send(res, 400, { error: 'not-active' }, cors);
        const body = await readBody(req);
        c.paused = Boolean(body?.paused);
        campaigns.saveCampaigns(camps);
        if (c.buyerId !== buyerId) audit.logAction(buyerId, 'order.pause', `${id} ${c.paused ? 'pause' : 'resume'} (owner ${c.buyerId})`);
        return send(res, 200, { ok: true, paused: c.paused }, cors);
    }

    // Toggle a server on/off for this campaign.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/server') && req.method === 'PUT') {
        const id = path.slice('/order/campaigns/'.length, -('/server'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || (c.buyerId !== buyerId && !isAdminBuyer)) return send(res, 404, { error: 'not found' }, cors);
        const body = await readBody(req);
        const gid = String(body?.gid || '');
        if (!/^\d{17,20}$/.test(gid)) return send(res, 400, { error: 'bad gid' }, cors);
        if (!Array.isArray(c.disabledGuilds)) c.disabledGuilds = [];
        if (body?.disabled) { if (!c.disabledGuilds.includes(gid)) c.disabledGuilds.push(gid); }
        else c.disabledGuilds = c.disabledGuilds.filter((x) => x !== gid);
        campaigns.saveCampaigns(camps);
        return send(res, 200, { ok: true, disabledGuilds: c.disabledGuilds }, cors);
    }

    // Toggle a BOT on/off for this campaign (developer-API delivery) — mirrors the
    // per-server toggle above, keyed by the bot's application id.
    if (path.startsWith('/order/campaigns/') && path.endsWith('/bot') && req.method === 'PUT') {
        const id = path.slice('/order/campaigns/'.length, -('/bot'.length));
        const camps = campaigns.loadCampaigns();
        const c = camps[id];
        if (!c || (c.buyerId !== buyerId && !isAdminBuyer)) return send(res, 404, { error: 'not found' }, cors);
        const body = await readBody(req);
        const bid = String(body?.botId || '');
        if (!/^\d{17,20}$/.test(bid)) return send(res, 400, { error: 'bad botId' }, cors);
        if (!Array.isArray(c.disabledBots)) c.disabledBots = [];
        if (body?.disabled) { if (!c.disabledBots.includes(bid)) c.disabledBots.push(bid); }
        else c.disabledBots = c.disabledBots.filter((x) => x !== bid);
        campaigns.saveCampaigns(camps);
        return send(res, 200, { ok: true, disabledBots: c.disabledBots }, cors);
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
        if (!c || (c.buyerId !== buyerId && !isAdminBuyer)) return send(res, 404, { error: 'not found' }, cors);
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
        for (const cl of clients) { inv = await rateLimit.schedule(() => cl.fetchInvite(inviteCode)).catch(() => null); if (inv) break; }
        const newGuildId = inv?.guild?.id || null;
        if (!newGuildId) return send(res, 400, { error: 'bad-invite' }, cors);
        // …and the server must be join-checkable: a network bot on it, OR the
        // reserve user account (selfbot) is a member (invisible fallback).
        const covered = await coveredGuildIds(clients);
        if (!covered.has(newGuildId)) return send(res, 400, { error: 'no-bot' }, cors);

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
        // New link is verified covered above → clear any coverage auto-pause.
        if (c.autoPaused || c.uncoveredSince) { c.autoPaused = false; c.autoPauseReason = ''; c.uncoveredSince = 0; dirty = true; }
        // Optional per-link join cap. `limit` > 0 arms a cap; empty/0 clears it (the
        // campaign runs to its purchased total). Either way we (re)start the window
        // from the current delivered count, so saving here also RESUMES a campaign
        // that was stopped on a previous cap — "continue with the same or new link".
        const verified = loadJSON('verified.json', []);
        const curDel = campaigns.delivered(c, verified, camps);
        const lim = Math.floor(Number(body?.limit));
        c.linkLimit = Number.isFinite(lim) && lim > 0 ? lim : 0;
        c.linkBaseline = curDel;
        dirty = true;
        if (dirty) campaigns.saveCampaigns(camps);
        if (c.buyerId !== buyerId) audit.logAction(buyerId, 'order.invite', `${id} → ${c.invite} (owner ${c.buyerId})`);
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
        return send(res, 200, { authed: true, ...(await userMiniLive(clients, sess.userId)), banner: await userBannerOf(clients, sess.userId), isAdmin: Boolean(adminAuth.roleOf(sess.userId)), isOwner: sess.userId === adminAuth.OWNER_ID }, cors);
    }
    // Owner-only universal search (header search box). Given one Discord id, find
    // whatever it matches: a partner (→ open their cabinet via acting-as), a
    // server card (by the server's guild id), or a specific card (by the bot
    // message id). Returns every match; the header renders them as a pick list.
    if (path === '/partner/owner-search' && req.method === 'GET') {
        const sess = buyerSessionOf(req);
        if (!sess) return send(res, 401, { error: 'unauthorized' }, cors);
        if (sess.userId !== adminAuth.OWNER_ID) return send(res, 403, { error: 'owner only' }, cors);
        const q = String((new URL(req.url, 'http://x')).searchParams.get('q') || '').trim();
        if (!/^\d{16,20}$/.test(q)) return send(res, 200, { q, results: [] }, cors);
        const results = [];
        // Cards: by message id (exact) first, then by guild id.
        const allCards = cards.loadCards().filter((c) => c && !c.deletedAt);
        const cardRows = [];
        const byMsg = allCards.find((c) => String(c.messageId) === q);
        if (byMsg) cardRows.push(byMsg);
        for (const c of allCards) {
            if (String(c.guildId) === q && !cardRows.some((x) => x.messageId === c.messageId)) cardRows.push(c);
        }
        for (const c of cardRows.slice(0, 25)) {
            const om = c.creatorId ? userMiniOf(clients, c.creatorId) : null;
            results.push({
                type: 'card',
                matchedBy: String(c.messageId) === q ? 'message' : 'server',
                messageId: c.messageId, guildId: c.guildId || null, channelId: c.channelId || null,
                guildName: c.guildId ? guildNameOf(clients, c.guildId) : null,
                creatorId: c.creatorId || null,
                ownerName: om ? (om.name || om.username || ('ID ' + c.creatorId)) : (c.creatorId ? ('ID ' + c.creatorId) : null),
                discordUrl: (c.guildId && c.channelId && c.messageId) ? `https://discord.com/channels/${c.guildId}/${c.channelId}/${c.messageId}` : null,
                cabinetUrl: c.creatorId ? `/partner/?as=${c.creatorId}` : null
            });
        }
        // Partner: any user id opens their cabinet (acting-as). Flag if they have data.
        if (/^\d{17,20}$/.test(q)) {
            const s = loadJSON('settings.json')[q];
            const mini = await userMiniLive(clients, q).catch(() => null);
            const hasData = Boolean(s && ((Number(s.balance) || 0) !== 0 || (Array.isArray(s.withdrawals) && s.withdrawals.length) || (Array.isArray(s.partners) && s.partners.length) || (Array.isArray(s.referrals) && s.referrals.length) || (s.advText && String(s.advText).trim()) || (s.serverAds && Object.keys(s.serverAds).length) || s.referrer));
            results.push({
                type: 'partner', id: q,
                name: (mini && (mini.name || mini.username)) || null,
                username: (mini && mini.username) || null,
                avatar: (mini && mini.avatar) || null,
                hasData, cabinetUrl: `/partner/?as=${q}`
            });
        }
        return send(res, 200, { q, results }, cors);
    }
    if (await handleLoginCode(req, res, path, clients, cors)) return;

    const sess = buyerSessionOf(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' }, cors);
    const actorId = sess.userId;
    const actorIsAdmin = actorId === adminAuth.OWNER_ID || Boolean(adminAuth.roleOf(actorId));
    // Admin "view / edit as another partner": ?as=<userId> makes EVERY partner
    // endpoint below operate on that user (their data AND their edits), exactly as
    // if the admin were signed in as them. Only a real admin may use it; a normal
    // user's ?as= is ignored.
    const asParam = (() => { try { return (new URL(req.url, 'http://x').searchParams.get('as') || '').trim(); } catch { return ''; } })();
    const actingAs = (actorIsAdmin && /^\d{17,20}$/.test(asParam) && asParam !== actorId) ? asParam : null;
    const userId = actingAs || actorId;

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

    // Referral stats for this partner, reconstructed from existing data (no new
    // events needed): who they referred, how much they earned from each (the
    // referrer earns REFERRAL_RATE of every referred user's withdrawals), the
    // referred user's server and its verification funnel (click → checked → stayed).
    if (path === '/partner/referrals' && req.method === 'GET') {
        const settings = loadJSON('settings.json', {});
        const s = settings[userId] || {};
        const refs = (Array.isArray(s.referrals) ? s.referrals : []).filter((r) => /^\d{17,20}$/.test(String(r)));
        const refSet = new Set(refs.map(String));

        // One enrichCards pass over all referred users' live cards, grouped per referrer.
        const theirCards = cards.loadCards().filter((c) => c && !c.deletedAt && refSet.has(String(c.creatorId)));
        const enriched = enrichCards(clients, theirCards).list;
        const zero = () => ({ hour: 0, day: 0, week: 0 });
        const addW = (a, b) => { a.hour += b.hour || 0; a.day += b.day || 0; a.week += b.week || 0; };
        const byRef = {};
        for (const ec of enriched) {
            const cid = String(ec.creatorId || '');
            const g = byRef[cid] || (byRef[cid] = { servers: new Set(), funnel: { clicks: zero(), checked: zero(), stayed: zero() } });
            if (ec.guildName) g.servers.add(ec.guildName);
            addW(g.funnel.clicks, ec.stats.clicks); addW(g.funnel.checked, ec.stats.checked); addW(g.funnel.stayed, ec.stats.stayed);
        }

        // Referral bonuses are credited per-join and stored on the joinlink
        // (refBonus + referrerId); a leave reverses that exact record. So my
        // earnings from each referral = sum of refBonus on their STILL-ACTIVE
        // joins where I'm the referrer (left/reversed joins are excluded).
        const jlAll = loadJSON('joinlinks.json', []);
        const earnedByRef = {};
        for (const r of (Array.isArray(jlAll) ? jlAll : [])) {
            if (!r || String(r.referrerId || '') !== String(userId) || !(Number(r.refBonus) > 0)) continue;
            if (r.status !== 'joined' && r.status !== 'settled') continue;
            earnedByRef[String(r.creatorId)] = (earnedByRef[String(r.creatorId)] || 0) + Number(r.refBonus);
        }

        const list = await Promise.all(refs.map(async (rid) => {
            const rs = settings[rid] || {};
            const wds = Array.isArray(rs.withdrawals) ? rs.withdrawals : [];
            const withdrawn = money(wds.reduce((a, w) => a + (Number(w.amount) || 0), 0));
            const earned = money(earnedByRef[String(rid)] || 0);
            const g = byRef[String(rid)] || { servers: new Set(), funnel: { clicks: zero(), checked: zero(), stayed: zero() } };
            const active = withdrawn > 0 || (Number(rs.balance) || 0) > 0 || g.funnel.checked.week > 0;
            const mini = await userMiniLive(clients, rid);
            return { ...mini, withdrawn, earned, active, server: [...g.servers].join(', ') || null, funnel: g.funnel };
        }));
        list.sort((a, b) => (b.earned - a.earned) || (b.funnel.checked.week - a.funnel.checked.week));
        const myReferrer = /^\d{17,20}$/.test(String(s.referrer || ''))
            ? { id: String(s.referrer), ...(await userMiniLive(clients, s.referrer)) }
            : null;
        return send(res, 200, {
            count: refs.length,
            activeCount: list.filter((r) => r.active).length,
            totalEarned: money(list.reduce((a, r) => a + r.earned, 0)),
            pending: 0,   // referral bonuses are credited at join time — nothing is deferred
            rate: REFERRAL_RATE,
            referrals: list,
            myReferrer   // who referred THIS user (null if none set yet)
        }, cors);
    }

    // Set the user's own referrer (who referred them) — the web equivalent of the
    // /bal "Referrer" button. One-time: can't change once set, can't be yourself.
    // The referrer earns 10% of this user's withdrawals; the user gets the boost.
    if (path === '/partner/referrer' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const referrerId = String(body?.referrerId || '').trim();
        const settings = loadJSON('settings.json');
        if (settings[userId]?.referrer) return send(res, 400, { error: 'already-set' }, cors);
        if (!/^\d{17,20}$/.test(referrerId)) return send(res, 400, { error: 'bad-id' }, cors);
        if (referrerId === String(userId)) return send(res, 400, { error: 'self' }, cors);
        if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };
        settings[userId].referrer = referrerId;
        settings[userId].referrerAt = Date.now();
        if (!settings[referrerId]) settings[referrerId] = { advText: '', serverAds: {}, partners: [] };
        if (!Array.isArray(settings[referrerId].referrals)) settings[referrerId].referrals = [];
        if (!settings[referrerId].referrals.includes(userId)) settings[referrerId].referrals.push(userId);
        saveJSON('settings.json', settings);
        return send(res, 200, { ok: true, referrer: { id: referrerId, ...(await userMiniLive(clients, referrerId)) } }, cors);
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
        // Split out income earned through the developer API (joinlinks tagged
        // roleId 'api' by /api/join-check) from income earned by a verification
        // bot the user runs on a Discord server.
        const apiStanding = standing.filter((r) => r.roleId === 'api');

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
            // Admin acting-as: who's being viewed/edited (null in a normal session).
            actingAs: actingAs ? { id: actingAs, ...userMiniOf(clients, actingAs) } : null,
            canActAs: actorIsAdmin,
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
            autoLtc: Boolean(s.autoLtc),
            ltcAddress: s.ltcAddress || null,
            standingJoins: standing.length,
            standingPaid: sumAmt(standing),
            apiJoins: apiStanding.length,
            apiPaid: sumAmt(apiStanding),
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
        const fleet = await coveredGuildIds(clients); // bots + reserve (selfbot) sponsors
        const camps = campaigns.loadCampaigns();
        const shows = sponsorshow.loadShows();
        const now = Date.now();
        const stampedRecently = (sgid) => { const last = Number(shows[sgid]) || 0; return last > 0 && (now - last) <= QUEUE_SHOWING_MS; };
        const servers = partnerGuildIds().map((gid) => {
            const prio = priorityByGuild[gid] || null;
            const hiddenSet = new Set(Array.isArray(hiddenByGuild[gid]) ? hiddenByGuild[gid] : []);
            const eligible = campaigns.eligibleForGuild(gid, verified, fleet);
            const prioValid = eligible.some((e) => e.id === prio);
            // The ACTUAL serve order on this server: strict FIFO by paidAt, minus
            // the partner's hidden ads, with their pinned priority moved to the
            // front — exactly what the in-Discord / API ad picker does. Hidden ads
            // aren't served, so they get no queue position. This is the queue the
            // partner sees, and the priority pin is what reorders it.
            let served = campaigns.weightedOrder(eligible).filter((e) => !hiddenSet.has(e.id));
            if (prioValid && !hiddenSet.has(prio)) {
                const i = served.findIndex((e) => e.id === prio);
                if (i > 0) { const [p] = served.splice(i, 1); served.unshift(p); }
            }
            const posOf = new Map(served.map((e, i) => [e.id, i + 1]));
            const queueTotal = served.length;
            // "showing now" on this server = the front-most served ad whose sponsor
            // actually ran recently (network-wide stamp). null on a quiet network.
            const showingId = (served.find((e) => stampedRecently(e.sponsorGuildId)) || {}).id || null;
            const ads = eligible
                .map((e) => {
                    const isPriority = e.id === prio && prioValid;
                    const isHidden = hiddenSet.has(e.id);
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
                        isHidden,
                        queuePos: isHidden ? null : (posOf.get(e.id) || null),
                        queueTotal,
                        showing: e.id === showingId
                    };
                })
                // Show in serve order (queue position); hidden ads sink to the bottom.
                .sort((a, b) => (a.isHidden - b.isHidden) || ((a.queuePos || 1e9) - (b.queuePos || 1e9)));
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
        const fleet = await coveredGuildIds(clients); // bots + reserve (selfbot) sponsors
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
        if (body.title !== undefined) patch.title = String(body.title).slice(0, 256);
        if (body.buttonLabel !== undefined) patch.buttonLabel = String(body.buttonLabel).slice(0, 80);
        if (body.buttonEmoji !== undefined) patch.buttonEmoji = String(body.buttonEmoji).slice(0, 100);
        if (body.color !== undefined) patch.color = String(body.color).slice(0, 9);
        const r = await cards.edit(clients, mid, patch).catch((e) => ({ ok: false, error: e.message }));
        // Template flag (one per guild) is set after the edit so the record exists.
        if (r.ok && body.isTemplate !== undefined) { const rec = cards.setTemplate(mid, !!body.isTemplate); if (rec) r.card = rec; }
        return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, card: r.card } : { error: r.error || 'failed' }, cors);
    }
    // List the custom emojis of the card's server (for the button-emoji picker).
    if (path === '/partner/cards/emojis' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        const card = ownCard(mid);
        if (!card) return send(res, 403, { error: 'not-your-card' }, cors);
        const arr = Array.isArray(clients) ? clients : [];
        const client = arr.find((cl) => cl.guilds?.cache?.has(card.guildId));
        const guild = client?.guilds?.cache?.get(card.guildId);
        if (!guild) return send(res, 200, { emojis: [] }, cors);
        let coll = guild.emojis?.cache;
        if (!coll || !coll.size) coll = await guild.emojis.fetch().catch(() => null);
        const emojis = coll ? [...coll.values()].map((e) => ({
            id: e.id, name: e.name, animated: !!e.animated,
            markup: e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`,
            url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=64`
        })) : [];
        return send(res, 200, { emojis }, cors);
    }
    // Auto-reset the card's role on a cooldown (days + hours). Empty/0 disables it;
    // the countdown restarts from now whenever this is saved.
    if (path === '/partner/cards/autoreset' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        if (!ownCard(mid)) return send(res, 403, { error: 'not-your-card' }, cors);
        const days = Math.max(0, Math.floor(Number(body?.days) || 0));
        const hours = Math.max(0, Math.floor(Number(body?.hours) || 0));
        let ms = (days * 24 + hours) * 3600 * 1000;
        const MAX_MS = 365 * 24 * 3600 * 1000;
        if (ms > MAX_MS) ms = MAX_MS;
        const rec = cards.setAutoReset(mid, ms);
        if (!rec) return send(res, 400, { error: 'not-tracked' }, cors);
        return send(res, 200, { ok: true, autoResetMs: rec.autoResetMs || 0 }, cors);
    }
    // Toggle "always at bottom" — keep the card the last message in its channel.
    if (path === '/partner/cards/always-bottom' && req.method === 'POST') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const mid = String(body?.messageId || '');
        if (!/^\d{17,20}$/.test(mid)) return send(res, 400, { error: 'bad message id' }, cors);
        if (!ownCard(mid)) return send(res, 403, { error: 'not-your-card' }, cors);
        const rec = cards.setAlwaysBottom(mid, !!body?.on);
        if (!rec) return send(res, 400, { error: 'not-tracked' }, cors);
        return send(res, 200, { ok: true, alwaysBottom: !!rec.alwaysBottom }, cors);
    }

    if (path === '/partner/requisites' && req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'bad json' }, cors);
        const settings = loadJSON('settings.json');
        if (!settings[userId]) settings[userId] = blankUser();
        const reqStr = String(body?.requisites ?? '').trim().slice(0, 1000);
        settings[userId].requisites = reqStr;
        // Developer cabinet sends ltcAuto: when the requisites is a valid Litecoin
        // address, switch on LTC auto-payout to it automatically; otherwise off.
        let autoLtc = Boolean(settings[userId].autoLtc);
        if (body?.ltcAuto) {
            const isLtc = /^(ltc1[a-z0-9]{20,70}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,40})$/.test(reqStr);
            settings[userId].autoLtc = isLtc;
            if (isLtc) settings[userId].ltcAddress = reqStr;
            autoLtc = isLtc;
        }
        saveJSON('settings.json', settings);
        return send(res, 200, { ok: true, requisites: settings[userId].requisites, autoLtc, ltcAddress: settings[userId].ltcAddress || null }, cors);
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
        return send(res, 200, sess ? { authed: true, ...(await userMiniLive(clients, sess.userId)), banner: await userBannerOf(clients, sess.userId), isAdmin: Boolean(adminAuth.roleOf(sess.userId)) } : { authed: false }, cors);
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
            .map((s) => ({
                ...s,
                name: guildNameOf(clients, s.serverId),
                icon: guildIconOf(clients, s.serverId),
                broken: investors.serverBroken(s.serverId, clients)
            }))
            // A broken server (no bot / no active card) is only shown to investors
            // who still hold UNSOLD invites there (they get the refund notice);
            // for everyone else it drops out of the list until it recovers.
            .filter((s) => (s.broken || s.brokenSince) ? Boolean(s.mine && s.mine.outstanding > 0) : true)
            .slice(0, 60);
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
            const perInvite = investors.buyinProfitPerInvite(bid, shares.ACQUIRING_RATE);
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
            if (rateLimited(req)) return send(res, 429, { error: 'rate limited', code: 'rate_limited' });
            let p = (new URL(req.url, 'http://x').pathname).replace(/\/+$/, '') || '/';
            // API versioning: /v1/api/* is the versioned alias of /api/* (bare
            // /api/* stays supported for existing integrations). Strip the prefix
            // once here so every route matches unchanged.
            if (p.startsWith('/v1/api/')) p = p.slice(3);

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
            // Read-only, no credentials → open to any origin. Carries the live retail
            // join price so static marketing pages show the current number, not a
            // hardcoded one.
            if (req.method === 'GET' && p === '/feed') return send(res, 200, { servers: feed.loadFeed(), pricePer100: campaigns.PRICE_PER_100 }, { 'Access-Control-Allow-Origin': '*' });

            // Public: just the live pricing (retail join price) for marketing pages.
            if (req.method === 'GET' && p === '/pricing') return send(res, 200, { pricePer100: campaigns.PRICE_PER_100, pricePerJoin: campaigns.PRICE_PER_100 / 100 }, { 'Access-Control-Allow-Origin': '*' });

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
                    if (!name) continue;                          // nobody (bot or reserve) sees it → skip
                    // Both resolve through the reserve too, so selfbot-covered
                    // sponsors get an avatar and a member count like any other.
                    const icon = guildIconOf(clients, gid);
                    const members = guildMembersOf(clients, gid);
                    events.push({ ts: Number(r.ts) || 0, name, icon, members });
                    if (events.length >= 25) break;
                }
                return send(res, 200, { events }, { 'Access-Control-Allow-Origin': '*' });
            }

            // Public: Cryptomus payment webhook (server-to-server, no session). We
            // never trust the posted status — we re-fetch it from Cryptomus and, if
            // paid, credit the matching pending wallet top-up (idempotent).
            if (req.method === 'POST' && p === '/cryptomus/webhook') {
                try {
                    const body = await readBody(req);
                    const orderId = body && body.order_id;
                    if (orderId && /^topup:\d{17,20}:/.test(String(orderId))) {
                        const status = await cryptomus.paymentStatus(orderId).catch(() => null);
                        if (cryptomus.isPaidStatus(status)) {
                            const buyerId = String(orderId).split(':')[1];
                            const credited = wallet.settlePending(buyerId, { orderId });
                            if (credited > 0) console.log(`[CRYPTOMUS] credited $${credited} to ${buyerId} (${orderId})`);
                        }
                    }
                } catch (e) { console.error('[CRYPTOMUS] webhook:', e.message); }
                return send(res, 200, { ok: true }); // always 200 so Cryptomus doesn't retry-storm
            }

            // Public: NOWPayments IPN webhook. We never trust the posted status — we
            // re-fetch the payment from NOWPayments with our API key and require its
            // order_id to match, then credit the matching pending top-up (idempotent).
            // If an IPN secret is set, we also verify the HMAC signature.
            if (req.method === 'POST' && p === '/nowpayments/webhook') {
                try {
                    const body = await readBody(req);
                    const orderId = body && body.order_id;
                    const paymentId = body && body.payment_id;
                    if (orderId && paymentId && /^topup:\d{17,20}:/.test(String(orderId))
                        && !(nowpayments.hasSecret() && !nowpayments.verifyWebhook(body, req.headers['x-nowpayments-sig']))) {
                        const buyerId = String(orderId).split(':')[1];
                        wallet.updatePending(buyerId, orderId, { paymentId: String(paymentId) });
                        const info = await nowpayments.paymentInfo(paymentId).catch(() => null);
                        if (info && String(info.order_id) === String(orderId) && nowpayments.isPaidStatus(info.payment_status)) {
                            const credited = wallet.settlePending(buyerId, { orderId });
                            if (credited > 0) console.log(`[NOWPAYMENTS] credited $${credited} to ${buyerId} (${orderId})`);
                        }
                    }
                } catch (e) { console.error('[NOWPAYMENTS] webhook:', e.message); }
                return send(res, 200, { ok: true }); // always 200 so NOWPayments doesn't retry-storm
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

            // Most /api/* calls are server-to-server (no browser, no CORS). The
            // developer cabinet, however, calls /api/test-reset straight from the
            // browser with the dev's key, so answer its CORS preflight and echo the
            // allowed origin on the response.
            const apiCors = corsHeaders(req);
            if (req.method === 'OPTIONS') { res.writeHead(204, apiCors); return res.end(); }

            // Auth
            const userId = resolveKey(getKey(req));
            if (!userId) return send(res, 401, { error: 'Invalid or missing API key', code: 'invalid_key' }, apiCors);

            // Account info (balance, stats, requisites, withdrawals) is not exposed
            // over the API — developers view and manage it in their cabinet on the
            // site. Only the two operational endpoints (/api/ad, /api/join-check)
            // remain.

            // Public changelog + current version for the API.
            if (p === '/api/changelog' && req.method === 'GET') {
                return send(res, 200, { version: API_VERSION, changelog: CHANGELOG }, apiCors);
            }

            // The ad to show on YOUR server right now — the owner's per-server
            // ad if they set one for it, else the global ad (same rule as
            // every network bot). Poll this, show adText to your users.
            // adText null → no ad, just verify. Query: ?serverId=<your guild>.
            if (p === '/api/ad' && req.method === 'GET') {
                const qs = (new URL(req.url, 'http://x')).searchParams;
                const serverId = String(qs.get('serverId') || '').trim();
                const botId = String(qs.get('botId') || '').trim();
                const endUserId = String(qs.get('userId') || '').trim();
                if (!/^\d{17,20}$/.test(serverId)) return send(res, 400, { error: 'serverId is required — the guild your bot is operating in', code: 'serverId_required' });
                if (!/^\d{17,20}$/.test(botId)) return send(res, 400, { error: 'botId is required — your bot application (client) ID', code: 'botId_required' });
                if (!/^\d{17,20}$/.test(endUserId)) return send(res, 400, { error: 'userId is required — the Discord user you are serving', code: 'userId_required' });
                const ad = await adForServer(clients, config.ownerId, serverId, endUserId, botId);
                try { recordApiClick({ creatorId: userId, botId, serverId, memberId: endUserId, sponsorGuildId: ad.sponsor ? ad.sponsor.guildId : null }); } catch { /* never block */ }
                console.log('[API ad]', JSON.stringify({ dev: userId, botId, serverId, user: endUserId, sponsor: ad.sponsor ? ad.sponsor.guildId : null, campaignId: ad.campaignId || null, src: ad.campaignId ? 'campaign' : (ad.sponsor ? 'house' : 'none') }));
                // Build your own message from sponsor.name + sponsor.invite.
                // fallbackText is the owner's "заглушка" to show when there's no ad.
                const cfg = loadJSON('siteconfig.json', {});
                return send(res, 200, {
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
                if (body === null) return send(res, 400, { error: 'Invalid JSON body', code: 'bad_json' });
                const memberId = String(body.userId || '').trim();
                if (!/^\d{17,20}$/.test(memberId)) return send(res, 400, { error: 'userId is required — the Discord user you are serving', code: 'userId_required' });
                const botId = String(body.botId || '').trim();
                if (!/^\d{17,20}$/.test(botId)) return send(res, 400, { error: 'botId is required — your bot application (client) ID', code: 'botId_required' });
                const serverId = /^\d{17,20}$/.test(String(body.serverId || '')) ? String(body.serverId)
                    : (/^\d{17,20}$/.test(String(body.cardGuildId || '')) ? String(body.cardGuildId) : null);
                // Optional but recommended: the guildId /api/ad returned. Pins the
                // check to that exact sponsor so it's deterministic when your bot ran
                // several ad commands at once. Omitted → we use the most recent ad
                // shown to this user through this bot.
                const wantSponsorId = /^\d{17,20}$/.test(String(body.sponsorId || '')) ? String(body.sponsorId) : null;

                // The reward is for the sponsor we actually SHOWED this user (recorded
                // on /api/ad, keyed by bot+user) — the serverId in the body isn't
                // trusted for that; effServerId is the guild the ad really ran in.
                const match = await matchJoinedSponsor(clients, config.ownerId, serverId, memberId, botId, wantSponsorId);
                const effServerId = match.serverId || serverId || 'api';
                console.log('[API join-check]', JSON.stringify({ dev: userId, botId, serverId: effServerId, user: memberId, result: match.none ? 'none(no-ad)' : match.notMember ? 'notMember' : match.uncertain ? 'uncertain(503)' : ('sponsor:' + (match.ad && match.ad.sponsor && match.ad.sponsor.guildId)) }));
                // Membership couldn't be checked right now (Discord transient). This
                // is the one non-2xx business response: 503 = retry, not a client bug.
                if (match.uncertain) return send(res, 503, { joined: null, credited: false, status: 'uncertain', error: 'membership check temporarily unavailable, retry', code: 'uncertain' });

                // Not a member of the shown sponsor yet — a normal business outcome,
                // so 200 (not 403). Ask the user to join, then check again.
                if (match.notMember) return send(res, 200, { joined: false, credited: false, status: 'not_joined' });

                // Nothing was shown / no verifiable sponsor → verify without an ad:
                // no-ad stat, hub role, no payout.
                if (match.none) {
                    recordApiVerified({ creatorId: userId, memberId, serverId: effServerId, noAd: true, botId });
                    try { partnerlog.logEvent(userId, { type: 'grant', reason: 'no_ad', userId: memberId, guildId: effServerId, roleId: 'api', srcId: `v:${memberId}:${effServerId}:api` }); } catch { /* never block */ }
                    syncHubMember(clients, userId).catch(() => null); // partner (card owner)
                    return send(res, 200, { joined: true, credited: false, status: 'no_ad', ad: false });
                }

                const ad = match.ad;
                const sponsor = ad.sponsor;

                // Dedup by (sponsor, user) — one credit per ACTIVE membership, no
                // matter which network server / partner delivered the join. A user
                // who left (clawed back or settled) and genuinely rejoins counts
                // again; only a still-live 'joined' record blocks. Mirrors
                // creditJoin's guard.
                const links = loadJSON('joinlinks.json', []);
                const already = (Array.isArray(links) ? links : []).some(
                    (r) => r && r.status === 'joined' && r.guildId === sponsor.guildId && r.userId === memberId
                );
                if (already) {
                    console.log('[API join-check] outcome', JSON.stringify({ botId, user: memberId, sponsor: sponsor.guildId, outcome: 'already_counted' }));
                    try { partnerlog.logEvent(userId, { type: 'grant', reason: 'dup_join', userId: memberId, guildId: effServerId, roleId: 'api', srcId: `dup:${memberId}:${sponsor.guildId}` }); } catch { /* never block */ }
                    return send(res, 200, { joined: true, credited: false, status: 'already_counted', alreadyCounted: true, reason: 'already_counted', sponsor: sponsor.guildId, note: 'already counted' });
                }

                // Full parity with the in-Discord flow: joinlinks (clawback-
                // watched, roleId 'api' + serverId), share split, verified.json
                // tagged with the shown creative's adKey, hub role, audit log,
                // campaign-complete notice.
                const adKey = touchCreative(ad.raw);
                // Manager economics (same as the in-Discord flow): lower revenue
                // for manager campaigns, no commission paid.
                const camp = ad.campaignId ? campaigns.loadCampaigns()[ad.campaignId] : null;
                const econ = managers.joinEconomics(camp, shares.REVENUE_PER_JOIN);
                const credit = creditJoin(userId, sponsor.guildId, memberId, effServerId, 'api', null,
                    { revenue: econ.revenue, managerId: econ.managerId, botId });
                // Race backstop: creditJoin's atomic guard caught a concurrent
                // credit for the same (user, sponsor) — treat as already counted.
                if (credit.duplicate) {
                    console.log('[API join-check] outcome', JSON.stringify({ botId, user: memberId, sponsor: sponsor.guildId, outcome: 'already_counted(race)' }));
                    try { partnerlog.logEvent(userId, { type: 'grant', reason: 'dup_join', userId: memberId, guildId: effServerId, roleId: 'api' }); } catch { /* never block */ }
                    return send(res, 200, { joined: true, credited: false, status: 'already_counted', alreadyCounted: true, reason: 'already_counted', sponsor: sponsor.guildId, note: 'already counted' });
                }
                const amount = credit.amount;
                try { partnerlog.logEvent(userId, { type: 'grant', reason: 'paid', amount, userId: memberId, guildId: effServerId, roleId: 'api', srcId: credit.linkId }); } catch { /* never block */ }
                // Parity with the in-Discord flow: if this server has outstanding
                // investor invites, this paid join fills one — its share split
                // already happened at the investor buy-in, so skip payShares.
                let investorOwnedJoin = false;
                try { investorOwnedJoin = investors.serverOutstanding(effServerId, loadJSON('verified.json', [])) > 0; } catch { /* never block verification */ }
                if (!investorOwnedJoin) await payShares(clients, amount, { revenuePerJoin: econ.revenue }).catch(() => null);
                const fresh = recordApiVerified({ creatorId: userId, memberId, serverId: effServerId, adKey, botId });
                syncHubMember(clients, userId).catch(() => null); // partner (card owner)
                await logFunds(clients, {
                    type: 'credit', creatorId: userId, userId: memberId, guildId: effServerId,
                    amount, sponsorGuildId: sponsor.guildId,
                    reason: 'Join verified (API) — member joined the sponsor server'
                }).catch(() => null);
                maybeNotifyAdComplete(clients, adKey, fresh).catch(() => null);
                await maybeAutoWithdraw(clients, userId).catch(() => null);
                if (credit.referrerId) maybeAutoWithdraw(clients, credit.referrerId).catch(() => null); // referral bonus credited at join
                console.log('[API join-check] outcome', JSON.stringify({ botId, user: memberId, sponsor: sponsor.guildId, outcome: 'credited', amount: money(amount) }));
                webhooks.fire(userId, 'credited', { user: memberId, sponsorId: sponsor.guildId, serverId: effServerId, botId, amount: money(amount) }).catch(() => null);
                return send(res, 200, { joined: true, credited: true, status: 'credited', sponsor: sponsor.guildId, amount: money(amount) });
            }

            // Testing aid — reverse YOUR OWN active API joins for a given end user
            // (simulate a leave) so you can re-run the join→reward flow with the
            // same account without waiting for the leave-reconciliation sweep. Only
            // touches joins THIS key delivered (creatorId === you), applies the
            // normal clawback, and never affects another developer's earnings.
            if (p === '/api/test-reset' && req.method === 'POST') {
                const body = await readBody(req);
                if (body === null) return send(res, 400, { error: 'Invalid JSON body' }, apiCors);
                const memberId = String(body.userId || '').trim();
                if (!/^\d{17,20}$/.test(memberId)) return send(res, 400, { error: 'userId is required — the Discord user whose test join to reset' }, apiCors);
                const links = loadJSON('joinlinks.json', []);
                const ids = (Array.isArray(links) ? links : [])
                    .filter((r) => r && r.status === 'joined' && r.roleId === 'api' && r.creatorId === userId && r.userId === memberId)
                    .map((r) => r.id);
                if (ids.length) await finalizeLeavers(clients, new Set(ids)).catch(() => null);
                console.log('[API test-reset]', JSON.stringify({ dev: userId, user: memberId, reset: ids.length }));
                return send(res, 200, { reset: ids.length }, apiCors);
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

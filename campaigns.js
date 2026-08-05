// Buyer ad campaigns ("Купить рекламу").
//
// A buyer logs in with Discord, orders N verified joins for their server,
// pays a CryptoBot invoice, and the campaign starts showing across the
// network. Delivery is counted as unique verified joins to the buyer's
// server; the campaign auto-completes when the purchased count is reached.
//
// Several campaigns run at once: the verification flow round-robins across
// all eligible ones per shown ad, so every buyer gets a steady stream of
// joins without one order hogging the network. Each campaign's per-server
// opt-outs and the "never advertise a server on itself" rule are respected.
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');
const { adKeyOf, joinerCount } = require('./adcreative.js');
const cryptopay = require('./cryptopay.js');
const usertoken = require('./usertoken.js');
const calibtrack = require('./calibtrack.js');
const rateLimit = require('./ratelimit.js');
const proxy = require('./proxy.js');

const pricePer100 = () => Number(process.env.JOIN_SALE_PRICE) || 10; // $ per 100 verified joins (live: applies on Save)
const minJoins = () => Number(process.env.MIN_ORDER_JOINS) || 1;
const { round2 } = require('./round.js');
const newId = () => crypto.randomBytes(9).toString('hex');

function priceFor(joins) { return round2((Number(joins) || 0) * pricePer100() / 100); }

function loadCampaigns() {
    const c = loadJSON('campaigns.json', {});
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
}
function saveCampaigns(c) { saveJSON('campaigns.json', c); }

// The campaign is keyed by the buyer's invite link (raw), same scheme as
// house ads — so delivery counting shares the unique-joiner logic.
function campaignAdKey(campaign) { return adKeyOf(campaign.invite); }

// Every ad-key this campaign has ever run under. The buyer can swap the invite
// link mid-flight (e.g. the old one expired); the previous keys are kept in
// `adKeys` so already-delivered joins still count toward the purchased total.
function campaignAdKeys(campaign) {
    const set = new Set();
    const cur = campaignAdKey(campaign);
    if (cur) set.add(cur);
    for (const k of (Array.isArray(campaign?.adKeys) ? campaign.adKeys : [])) if (k) set.add(k);
    return set;
}

// Unique verified joins delivered to a campaign since it went active — counted
// across every invite the campaign has used (deduped by user), so changing the
// link never resets progress.
//
// When SEVERAL live campaigns share the same invite (same ad-key), a join can't
// be told apart between them from the data. To avoid double-counting (each
// seeing all the joins → "308 / 200"), the shared joins are ALLOCATED — every
// join goes to exactly one campaign, so the totals across the cohort add up to
// the real number of joins. Allocation is strict FIFO: each join fills the
// EARLIEST-PAID campaign that still has room, and only once it's full does the
// next one start receiving joins — the same order the ad is served in
// (weightedOrder by paidAt). So orders complete one after another, not evenly.
function delivered(campaign, verifiedList, allCampaigns) {
    if (!campaign || !campaign.paidAt) return 0;
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const myKeys = campaignAdKeys(campaign);
    if (!myKeys.size) return 0;

    // The order is sold PER STAY ("$X per 100 stays"), so a joiner who has since
    // LEFT the sponsor server must NOT count toward delivery — otherwise the site's
    // counter drifts above the real member count and the buyer is short-changed. A
    // leave is recorded as a clawed-back joinlink (status 'left') on the sponsor
    // (guildId === sponsorGuildId). Cohort members share an invite ⇒ the same
    // sponsor, so one left-set covers the whole allocation.
    const sponsor = String(campaign.sponsorGuildId || '');
    const left = new Set();
    if (sponsor) {
        const jl = loadJSON('joinlinks.json', []);
        for (const r of (Array.isArray(jl) ? jl : [])) {
            if (r && r.status === 'left' && String(r.guildId) === sponsor) left.add(String(r.userId));
        }
    }

    // Calibration campaigns ALL share ONE sponsor invite (the same adKey), but each
    // shows on only its OWN server and stamps its own campaignId at credit time. Count
    // by that authoritative campaignId — never the shared-adKey cohort below, which
    // would lump every server's calibration joins into the earliest-paid one (the
    // "counter grows on one server, fed by other servers' joins" bug).
    if (campaign.calibration) {
        // Calibration delivery = REAL members our bot tracked joining the sponsor
        // (calibtrack, net of leavers) — NOT the 2-click join-check count, which
        // drops ~half of real joiners (the "counter lags ~2×" symptom).
        try { return calibtrack.netJoins(campaign.calibrationGuild); } catch { return 0; }
    }

    // Simple own-count (used for the fast path and dead campaigns).
    const ownCount = () => {
        const seen = new Set();
        for (const u of list) if (u && myKeys.has(u.adKey) && Number(u.timestamp) > campaign.paidAt && !left.has(String(u.id))) seen.add(u.id);
        return seen.size;
    };
    // Only running/finished orders share allocation; a cancelled/invalid one
    // keeps its own frozen count and doesn't claim new joins.
    if (campaign.status !== 'active' && campaign.status !== 'complete') return ownCount();

    const pool = allCampaigns ? (Array.isArray(allCampaigns) ? allCampaigns : Object.values(allCampaigns)) : Object.values(loadCampaigns());
    // Cohort = the FULL connected component of campaigns linked by shared ad-keys
    // (directly or through a chain). It MUST be identical no matter which campaign
    // in the group asks: a per-query "campaigns that share MY keys" filter is
    // neither transitive nor symmetric, so two campaigns sharing one key compute
    // DIFFERENT cohorts, their FIFO allocations disagree, and the same join is
    // counted by BOTH (the double-count bug — e.g. one invite tallying into two
    // campaigns at once). The connected component makes the allocation global and
    // consistent, so every join is assigned to exactly one campaign.
    const active = pool.filter((c) => c && c.paidAt && (c.status === 'active' || c.status === 'complete'));
    const keysById = new Map(active.map((c) => [c.id, campaignAdKeys(c)]));
    if (!keysById.has(campaign.id)) { active.push(campaign); keysById.set(campaign.id, myKeys); }
    const shareKey = (a, b) => { for (const k of keysById.get(a.id)) if (keysById.get(b.id).has(k)) return true; return false; };
    const inCohort = new Set([campaign.id]);
    const cohort = [campaign];
    for (let i = 0; i < cohort.length; i++) {            // BFS over the share-graph
        for (const c of active) {
            if (inCohort.has(c.id)) continue;
            if (shareKey(cohort[i], c)) { inCohort.add(c.id); cohort.push(c); }
        }
    }
    if (cohort.length <= 1) return ownCount();   // unique invite → no sharing

    cohort.sort((a, b) => (a.paidAt || 0) - (b.paidAt || 0) || String(a.id).localeCompare(String(b.id)));
    const keySets = new Map(cohort.map((c) => [c.id, campaignAdKeys(c)]));
    const cohortKeys = new Set();
    for (const ks of keySets.values()) for (const k of ks) cohortKeys.add(k);

    // Earliest verification per user (with the invite it came in on). Users who
    // left the sponsor are dropped here so they never claim a delivery slot.
    const firstByUser = new Map();
    for (const u of list) {
        if (!u || !cohortKeys.has(u.adKey) || left.has(String(u.id))) continue;
        const t = Number(u.timestamp) || 0;
        const cur = firstByUser.get(u.id);
        if (!cur || t < cur.t) firstByUser.set(u.id, { t, k: u.adKey });
    }
    const joins = [...firstByUser.entries()]
        .map(([u, o]) => ({ u, t: o.t, k: o.k }))
        .sort((a, b) => a.t - b.t || (a.u < b.u ? -1 : 1));

    const counts = new Map(cohort.map((c) => [c.id, 0]));
    for (const j of joins) {
        // cohort is sorted by paidAt, so the FIRST eligible campaign with room is
        // the earliest-paid one — it fills completely before the next gets any.
        for (const c of cohort) {
            if ((c.paidAt || 0) >= j.t) continue;             // not yet paid when this join happened
            if (!keySets.get(c.id).has(j.k)) continue;        // this campaign didn't use that invite
            if (counts.get(c.id) >= (Number(c.purchased) || 0)) continue; // already full → next in queue
            counts.set(c.id, counts.get(c.id) + 1);
            break;                                             // one join → one (earliest) campaign
        }
    }
    return counts.get(campaign.id) || 0;
}

// Optional per-link join cap. When (re)setting the invite the buyer may set a
// limit; the campaign then delivers up to `linkLimit` joins measured from
// `linkBaseline` (the delivered count when the limit was armed) and STOPS serving
// once reached — until the buyer manually resumes (which re-arms a fresh window).
// 0/absent = no per-link cap (the campaign runs to its purchased total as usual).
function linkProgress(campaign, del) {
    const limit = Math.floor(Number(campaign?.linkLimit) || 0);
    if (!(limit > 0)) return { limit: 0, delivered: 0, reached: false };
    const base = Math.floor(Number(campaign?.linkBaseline) || 0);
    const d = Math.max(0, (Number(del) || 0) - base);
    return { limit, delivered: Math.min(d, limit), reached: d >= limit };
}

// Owner/admin-only: of a campaign's delivered joins, how many were NO-CHECK (CPC
// virtual) joins rather than confirmed join-check joins. Virtual joins are stamped
// with their delivering campaignId at credit time (index.js) and marked noCheck, so
// we attribute by that authoritative stamp — capped at `del` so the split never
// exceeds the displayed delivered count, and excluding users who left the sponsor
// (same as delivered()). This is NOT put in publicView: buyers see one unified
// "delivered"; only the staff order view breaks it into checked vs statistical.
function noCheckDelivered(campaign, del, verifiedList) {
    if (!campaign || !campaign.paidAt) return 0;
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const sponsor = String(campaign.sponsorGuildId || '');
    const left = new Set();
    if (sponsor) {
        const jl = loadJSON('joinlinks.json', []);
        for (const r of (Array.isArray(jl) ? jl : [])) {
            if (r && r.status === 'left' && String(r.guildId) === sponsor) left.add(String(r.userId));
        }
    }
    const seen = new Set();
    for (const u of list) {
        if (!u || !u.noCheck || !u.adKey) continue;
        if (String(u.campaignId || '') !== String(campaign.id)) continue;
        if ((Number(u.timestamp) || 0) <= campaign.paidAt) continue;
        if (left.has(String(u.id))) continue;
        seen.add(u.id);
    }
    return Math.min(seen.size, Number(del) || 0);
}

// A public-safe view of a campaign for the buyer dashboard.
function publicView(campaign, verifiedList) {
    // Cap the shown count at what was ordered: two campaigns for the same server
    // can share an invite (one ad-key), so each sees all the joins and the raw
    // count can run past the purchased amount. A campaign never delivers more
    // than it bought — clamp the display so it can't read e.g. "308 / 200".
    const raw = delivered(campaign, verifiedList);
    const del = Math.min(raw, campaign.purchased);
    const lp = linkProgress(campaign, raw);
    return {
        id: campaign.id,
        invite: campaign.invite,
        sponsorGuildId: campaign.sponsorGuildId,
        serverName: campaign.serverName || null,
        purchased: campaign.purchased,
        delivered: del,
        remaining: Math.max(0, campaign.purchased - del),
        price: campaign.price,
        status: campaign.status,
        paused: Boolean(campaign.paused),
        autoPaused: Boolean(campaign.autoPaused),
        autoPauseReason: campaign.autoPaused ? (campaign.autoPauseReason || 'verifier-offline') : '',
        linkLimit: lp.limit,
        linkDelivered: lp.delivered,
        limitReached: lp.reached,
        disabledGuilds: Array.isArray(campaign.disabledGuilds) ? campaign.disabledGuilds : [],
        disabledBots: Array.isArray(campaign.disabledBots) ? campaign.disabledBots : [],
        onlySfw: Boolean(campaign.onlySfw),
        noCheck: Boolean(campaign.noCheck),
        invoiceUrl: campaign.invoiceUrl || null,
        createdAt: campaign.createdAt || 0,
        paidAt: campaign.paidAt || 0,
        completedAt: campaign.completedAt || 0
    };
}

// The set of guild ids the whole bot fleet is currently a member of.
function fleetGuildIds(clients) {
    const set = new Set();
    for (const c of Array.isArray(clients) ? clients : []) {
        for (const id of (c.guilds?.cache?.keys?.() || [])) set.add(id);
    }
    return set;
}

// Is a network bot present on a campaign's own server? A campaign can't run
// without one (join verification is impossible), so it's excluded until the
// buyer adds the bot. `botGuildIds` = the set of guilds the fleet is on.
function botPresent(campaign, botGuildIds) {
    return Boolean(botGuildIds && campaign && botGuildIds.has(campaign.sponsorGuildId));
}

// Every campaign showable on a display guild: active, not paused, not
// self-targeted, not opted-out of this guild, not yet delivered, and whose own
// server has a network bot (so the join can be verified). Each carries `remaining`
// (unmet joins) and `paidAt` (queue position). Callers order these with
// weightedOrder (now FIFO by paidAt) and layer priority/hide/membership on top.
function eligibleForGuild(displayGuildId, verifiedList, botGuildIds, botId) {
    const camps = loadCampaigns();
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const bid = botId ? String(botId) : null;
    // NSFW gate: a buyer can restrict a campaign to SFW servers only (c.onlySfw);
    // servers the owner flagged NSFW live in siteconfig.nsfwServers (keyed by guild).
    const sc = loadJSON('siteconfig.json', {});
    const displayIsNsfw = Boolean(sc && sc.nsfwServers && sc.nsfwServers[displayGuildId]);
    const cpcCal = (sc && sc.cpcCalibrated && typeof sc.cpcCalibrated === 'object') ? sc.cpcCalibrated : {};
    const displayCalibrated = Boolean(cpcCal[displayGuildId]);
    const eligible = [];
    for (const c of Object.values(camps)) {
        if (!c || c.status !== 'active' || c.paused || c.autoPaused) continue;
        // A calibration ad is a targeted measurement — it shows ONLY on the one server
        // it's calibrating (never spills into the wider network).
        if (c.calibration && String(c.calibrationGuild || '') !== String(displayGuildId)) continue;
        if (c.sponsorGuildId === displayGuildId) continue;                 // never on itself
        if (c.onlySfw && displayIsNsfw) continue;                          // Only-SFW campaign never surfaces on an NSFW server
        if (Array.isArray(c.disabledGuilds) && c.disabledGuilds.includes(displayGuildId)) continue;
        // Developer API: the buyer can turn a campaign off for a specific bot,
        // exactly like the per-server opt-out (only applies when a botId is given).
        if (bid && Array.isArray(c.disabledBots) && c.disabledBots.includes(bid)) continue;
        // Coverage: the sponsor normally needs a bot/reserve on it so joins can be
        // verified. A no-check (CPC) campaign delivers statistically and can run
        // WITHOUT sponsor coverage — but only on a CALIBRATED display server, where
        // no-check actually fires (on a non-calibrated server it couldn't deliver, so
        // don't waste the show there).
        if (botGuildIds && !botGuildIds.has(c.sponsorGuildId) && !(c.noCheck && displayCalibrated)) continue;
        const del = delivered(c, list, camps);
        const remaining = c.purchased - del;
        if (remaining <= 0) continue;                                      // already done
        if (linkProgress(c, del).reached) continue;                        // per-link cap hit → stopped until resumed
        eligible.push({ id: c.id, invite: c.invite, sponsorGuildId: c.sponsorGuildId, remaining, paidAt: Number(c.paidAt) || Number(c.createdAt) || 0, calibration: Boolean(c.calibration) });
    }
    return eligible;
}

// The ORDER eligible campaigns are tried in — strict FIFO: the earliest-paid
// order is served first and stays first until it's fully delivered, so the queue
// actually drains instead of every new order stealing exposure (weighted-random
// spread attention across all orders at once, which never let the backlog clear).
// This only sets the base order; the caller still layers the partner/admin
// controls on top (hide removes a campaign, a pinned "priority" campaign is moved
// to the front) and skips sponsors the user already joined — none of that changes.
// Ties (same paidAt) fall back to id for a stable order.
function weightedOrder(eligible) {
    return (Array.isArray(eligible) ? eligible : [])
        .slice()
        .sort((a, b) => (a.paidAt || 0) - (b.paidAt || 0) || String(a.id).localeCompare(String(b.id)));
}

// Pick a campaign to show on a display guild — the FIRST in the queue (earliest
// paid) so orders finish in the order they came in. Returns { invite, campaignId,
// sponsorGuildId } or null. (User-membership-aware selection lives in the
// verification handler, which uses eligibleForGuild + weightedOrder.)
function pickForGuild(displayGuildId, verifiedList, botGuildIds) {
    const eligible = weightedOrder(eligibleForGuild(displayGuildId, verifiedList, botGuildIds));
    const e = eligible[0];
    return e ? { invite: e.invite, campaignId: e.id, sponsorGuildId: e.sponsorGuildId } : null;
}

// Is a CryptoBot invoice paid? Best-effort; false on any error.
async function isInvoicePaid(invoiceId) {
    if (!cryptopay.enabled() || !invoiceId) return false;
    try {
        const r = await cryptopay.call('getInvoices', { invoice_ids: String(invoiceId), count: 1 });
        const inv = (r && (r.items || r.invoices) || [])[0];
        return Boolean(inv && inv.status === 'paid');
    } catch { return false; }
}

// Best-effort DM to the buyer from any bot instance.
async function notifyBuyer(clients, campaign, kind) {
    const list = Array.isArray(clients) ? clients : [];
    const server = campaign.serverName || campaign.invite;
    const messages = {
        started: `✅ Payment received — your campaign is live!\nServer: ${server}\nJoins ordered: **${campaign.purchased}**. Track progress in your dashboard.`,
        complete: `🎉 Campaign complete!\nServer: ${server}\nJoins delivered: **${campaign.purchased}/${campaign.purchased}**. Thanks for your order!`,
        invalid: `⚠️ Campaign stopped: the invite link is no longer valid.\nServer: ${server}\nUpdate the invite and contact support to resume delivery.`,
        autopaused: `⏸️ Campaign paused: we can no longer verify joins on your server (our checker was removed/banned there, or lost access).\nServer: ${server}\nAdd our bot back — it resumes automatically once access is restored. No charges happen while paused.`,
        autoresumed: `▶️ Campaign resumed — access to your server is back and joins are being verified again.\nServer: ${server}`
    };
    const msg = messages[kind];
    if (!msg) return;
    for (const c of list) {
        const u = await c.users?.fetch(campaign.buyerId).catch(() => null);
        if (!u) continue;
        const ok = await u.send({ content: msg }).then(() => true).catch(() => false);
        if (ok) return;
    }
}

// Auto-pause any active campaign whose sponsor server we can no longer verify
// joins on — our checker (a network bot OR the reserve selfbot) was kicked,
// banned, or otherwise lost access. `covered` is the set of sponsor guilds still
// reachable (bot ∪ reserve). Auto-resumes when access returns (but never overrides
// a manual pause). A GRACE period debounces transient blips (a bot reconnecting, a
// momentary cache/REST miss) so a short hiccup can't flap campaigns on and off.
async function autoPauseUncovered(clients, covered, graceMs) {
    const grace = Number.isFinite(graceMs) ? graceMs : (Number(process.env.COVERAGE_GRACE_MS) || 10 * 60 * 1000);
    if (!covered || typeof covered.has !== 'function') return { paused: 0, resumed: 0, needBotNotify: [], clearBotNotify: [] };
    const repeat = Number(process.env.BOTFARM_NO_BOT_REPEAT_MS) || 10 * 60 * 1000;   // re-ping cadence while uncovered
    const camps = loadCampaigns();
    const now = Date.now();
    let changed = false;
    const paused = [], resumed = [], needBotNotify = [], clearBotNotify = [];
    const NOTIFY_CAP = 5;   // don't flood the ops channel on a big backlog — trickle over sweeps
    for (const c of Object.values(camps)) {
        if (!c || c.status !== 'active') continue;
        // No-check (CPC) campaigns deliver statistically and DON'T need sponsor
        // coverage — never auto-pause them for "no verifier", never ping for a bot.
        // AND lift any auto-pause / no-bot state left over from before it became
        // no-check (else a previously auto-paused order would stay stuck forever).
        if (c.noCheck) {
            if (c.autoPaused) { c.autoPaused = false; c.autoPauseReason = ''; c.autoResumedAt = now; changed = true; resumed.push(c); }
            if (c.uncoveredSince) { c.uncoveredSince = 0; changed = true; }
            if (c.noBotNotifMsgId) clearBotNotify.push({ channelId: c.noBotNotifChannelId || '', msgId: c.noBotNotifMsgId });
            if (c.noBotNotifiedAt || c.noBotNotifMsgId) { c.noBotNotifiedAt = 0; c.noBotNotifMsgId = ''; c.noBotNotifChannelId = ''; changed = true; }
            continue;
        }
        if (covered.has(String(c.sponsorGuildId))) {
            if (c.uncoveredSince) { c.uncoveredSince = 0; changed = true; }
            // Coverage returned (a fleet bot or reserve is on the server now) → pull the
            // standing "no bots" ping from the ops channel.
            if (c.noBotNotifMsgId) clearBotNotify.push({ channelId: c.noBotNotifChannelId || '', msgId: c.noBotNotifMsgId });
            if (c.noBotNotifiedAt || c.noBotNotifMsgId) { c.noBotNotifiedAt = 0; c.noBotNotifMsgId = ''; c.noBotNotifChannelId = ''; changed = true; }
            if (c.autoPaused) { c.autoPaused = false; c.autoPauseReason = ''; c.autoResumedAt = now; changed = true; resumed.push(c); }
        } else {
            if (!c.uncoveredSince) { c.uncoveredSince = now; changed = true; }          // start the grace timer
            else if (!c.autoPaused && now - c.uncoveredSince >= grace) {
                c.autoPaused = true; c.autoPauseReason = 'verifier-offline'; c.autoPausedAt = now; changed = true; paused.push(c);
                console.error(`[COVERAGE] auto-paused ${c.id} — no verifier on sponsor ${c.sponsorGuildId} for ${Math.round((now - c.uncoveredSince) / 60000)}m`);
            }
            // No coverage (no fleet bot, no reserve) → ping the ops channel to bring a
            // user-bot in. Fires right away, then REPEATS every `repeat` ms while still
            // uncovered — the caller deletes the previous message and posts a fresh one,
            // so only the latest ping stands.
            const due = !c.noBotNotifiedAt || (now - c.noBotNotifiedAt >= repeat);
            if (due && needBotNotify.length < NOTIFY_CAP) {
                needBotNotify.push({ campaign: c, oldMsgId: c.noBotNotifMsgId || '', oldChannelId: c.noBotNotifChannelId || '' });
                c.noBotNotifiedAt = now; changed = true;   // msgId is written back by the caller after sending
            }
        }
    }
    if (changed) saveCampaigns(camps);
    for (const c of paused) notifyBuyer(clients, c, 'autopaused').catch(() => null);
    for (const c of resumed) notifyBuyer(clients, c, 'autoresumed').catch(() => null);
    return { paused: paused.length, resumed: resumed.length, needBotNotify, clearBotNotify };
}

// Record the ops-channel message id of the current "no bots" ping for a campaign
// (so the next sweep can delete it when replacing or clearing). Load-mutate-save,
// synchronous — safe against the shared-ref cache.
function setNoBotNotifMsg(campaignId, msgId, channelId) {
    const camps = loadCampaigns();
    const c = camps[String(campaignId)];
    if (!c) return;
    c.noBotNotifMsgId = msgId || '';
    c.noBotNotifChannelId = channelId || '';
    saveCampaigns(camps);
}

const inviteCodeOf = (invite) => { const m = String(invite || '').match(/([a-z0-9-]{2,32})\/?$/i); return m ? m[1] : ''; };

// true = valid, false = definitely invalid (Unknown Invite), null = couldn't
// tell (network/transient) — don't act on null.
async function isInviteValid(clients, invite) {
    const code = inviteCodeOf(invite);
    if (!code) return false;
    // Public invite lookup (optionally proxied), independent of any bot.
    const inv = await rateLimit.schedule(() => proxy.getInvite(code));
    if (!inv) return null;              // transient (timeout / rate-limit) — don't act
    if (inv.notFound) return false;     // 404 Unknown Invite → genuinely dead
    return Boolean(inv.guild && inv.guild.id);
}

// Periodic reconciliation: activate paid pending campaigns and complete
// finished ones. Also usable on demand (dashboard load) for one campaign.
async function reconcile(clients) {
    const camps = loadCampaigns();
    const verified = loadJSON('verified.json', []);
    let changed = false;
    const now = Date.now();

    // Can this campaign still be DELIVERED right now? A join can only be verified
    // (and thus credited) when a network bot — or the reserve — is on the sponsor
    // server. If neither is, the order can't progress no matter what: it must NOT
    // be reopened, and if it's somehow 'active' below target it should freeze.
    // Only trust this once the fleet is actually connected (fleet has guilds or
    // the reserve is enabled) — otherwise a cold start would look "no bot".
    const fleet = fleetGuildIds(clients);
    const canJudgePresence = fleet.size > 0;   // only once the fleet is actually connected
    const serveable = async (c) => {
        const gid = String(c.sponsorGuildId || '');
        if (fleet.has(gid)) return true;
        if (usertoken.enabled()) { try { return await usertoken.coversGuild(gid); } catch { return false; } }
        return false;
    };

    for (const c of Object.values(camps)) {
        if (!c) continue;
        // Legacy invoice-checkout campaigns are gone — orders are now paid
        // straight from the prepaid wallet and created 'active'. Any lingering
        // unpaid campaign is a dead checkout from the old system: purge it.
        if (c.status === 'pending_payment') { delete camps[c.id]; changed = true; continue; }
        if (c.status === 'active') {
            // No-check (CPC) campaigns deliver without sponsor coverage → lift any
            // coverage auto-pause right here, so a dashboard refresh un-sticks it
            // instantly (not only on the 3-min coverage sweep).
            if (c.noCheck && (c.autoPaused || c.uncoveredSince)) {
                if (c.autoPaused) { c.autoPaused = false; c.autoPauseReason = ''; c.autoResumedAt = now; }
                c.uncoveredSince = 0; changed = true;
            }
            // Stop the campaign if its invite went invalid (deleted/expired).
            // Checked at most every 10 min to keep API calls light.
            if (now - (c.inviteCheckedAt || 0) > 10 * 60 * 1000) {
                c.inviteCheckedAt = now; changed = true;
                const valid = await isInviteValid(clients, c.invite);
                if (valid === false) {
                    c.status = 'invalid'; c.invalidAt = now;
                    console.error(`[CAMPAIGN] invite invalid → stopped campaign ${c.id} buyer=${c.buyerId} invite=${c.invite}`);
                    notifyBuyer(clients, c, 'invalid').catch(() => null);
                    continue;
                }
            }
            const del = delivered(c, verified, camps);
            if (del >= c.purchased) {
                // FULFILLED: reached its target. This is TERMINAL — mark it so
                // reconcile never reopens it, even if later clawbacks/re-allocation
                // drop the count below target (that churn is the buyer's; reopening
                // would re-deliver past what was paid and re-fire "Campaign complete").
                c.status = 'complete'; c.completedAt = now; c.fulfilled = true; changed = true;
                notifyBuyer(clients, c, 'complete').catch(() => null);
            }
            // A not-yet-fulfilled campaign whose sponsor has no verifier (bot/reserve)
            // is NOT frozen to 'complete' anymore — it stays 'active' and
            // autoPauseUncovered moves it to PAUSED (autoPaused) after the grace
            // window, so it shows in "На паузе" (resumable when a bot returns) instead
            // of being hidden away in "Завершено".
        } else if (c.status === 'complete') {
            // A campaign that reached its target is TERMINAL — never reopen it.
            if (c.fulfilled) continue;
            const del = delivered(c, verified, camps);
            // Backfill: a legacy completion that IS at/above target is genuinely
            // fulfilled → stamp it terminal (so it can never re-open / re-notify).
            if (del >= c.purchased) { c.fulfilled = true; changed = true; continue; }
            // What's left is a NON-fulfilled 'complete' = a legacy frozen order that
            // never reached target (no bot, or partial delivery then the bot left).
            // Reopen it to 'active' regardless of current coverage: a serveable one
            // resumes delivering, and an uncovered one is moved to PAUSED by
            // autoPauseUncovered — so nothing stays hidden in "Завершено".
            if (canJudgePresence) {
                c.status = 'active'; changed = true;   // keep completedAt for history
                console.log(`[CAMPAIGN] resume ${c.id} — never fulfilled (${del}/${c.purchased})`);
            }
        }
    }
    if (changed) saveCampaigns(camps);
}

function startCampaignSweep(clients) {
    const every = Number(process.env.CAMPAIGN_SWEEP_MS) || 60 * 1000;
    const tick = () => reconcile(clients).catch((e) => console.error('[CAMPAIGN] sweep error:', e.message));
    setInterval(tick, every);
    setTimeout(tick, 20 * 1000);
    console.log(`[CAMPAIGN] reconciliation every ${Math.round(every / 1000)}s`);
}

// Retention: of the joiners this campaign delivered, how many were still on the
// sponsor server 1 / 7 / 30 days after joining. A joiner still present now is
// retained at every window up to their tenure; a leaver is retained only if
// they stayed at least that long. Only joiners who joined ≥ the window ago are
// eligible (younger ones can't have hit that mark yet).
function retention(campaign, verifiedList, joinlinks, now = Date.now()) {
    const keys = campaignAdKeys(campaign);
    const since = campaign.paidAt || 0;
    const verified = Array.isArray(verifiedList) ? verifiedList : [];
    const jl = Array.isArray(joinlinks) ? joinlinks : [];

    const joinTime = new Map(); // still-present joiners → earliest join ts
    for (const u of verified) {
        if (!keys.has(u.adKey) || (Number(u.timestamp) || 0) < since) continue;
        const t = Number(u.timestamp) || 0;
        if (!joinTime.has(u.id) || t < joinTime.get(u.id)) joinTime.set(u.id, t);
    }
    const left = new Map(); // leavers of this sponsor → { joinTs, leftAt }
    for (const r of jl) {
        if (r.status !== 'left' || r.guildId !== campaign.sponsorGuildId || (Number(r.ts) || 0) < since) continue;
        if (joinTime.has(r.userId)) continue; // rejoined → treat as present
        const prev = left.get(r.userId);
        if (!prev || (Number(r.ts) || 0) < prev.joinTs) left.set(r.userId, { joinTs: Number(r.ts) || 0, leftAt: Number(r.leftAt) || now });
    }

    const joiners = [];
    for (const t of joinTime.values()) joiners.push({ joinTs: t, tenure: now - t });
    for (const v of left.values()) joiners.push({ joinTs: v.joinTs, tenure: Math.max(0, v.leftAt - v.joinTs) });

    const windows = { d1: 86400000, d7: 604800000, d30: 2592000000 };
    const out = {};
    for (const [k, ms] of Object.entries(windows)) {
        const eligible = joiners.filter((j) => (now - j.joinTs) >= ms);
        const retained = eligible.filter((j) => j.tenure >= ms).length;
        out[k] = eligible.length ? Math.round(retained / eligible.length * 100) : null;
        out[`${k}_n`] = eligible.length;
    }
    return out;
}

module.exports = {
    get PRICE_PER_100() { return pricePer100(); }, get MIN_JOINS() { return minJoins(); }, priceFor, round2, newId,
    loadCampaigns, saveCampaigns, campaignAdKey, campaignAdKeys, delivered, noCheckDelivered, linkProgress, publicView, pickForGuild, eligibleForGuild, weightedOrder, botPresent, fleetGuildIds, autoPauseUncovered, setNoBotNotifMsg,
    isInvoicePaid, reconcile, startCampaignSweep, retention
};

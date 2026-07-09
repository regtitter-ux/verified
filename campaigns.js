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

const PRICE_PER_100 = Number(process.env.JOIN_SALE_PRICE) || 10; // $ per 100 verified joins
const MIN_JOINS = Number(process.env.MIN_ORDER_JOINS) || 100;
const round2 = (n) => +(Number(n) || 0).toFixed(2);
const newId = () => crypto.randomBytes(9).toString('hex');

function priceFor(joins) { return round2((Number(joins) || 0) * PRICE_PER_100 / 100); }

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

// Unique verified joins delivered since the campaign went active — counted
// across every invite the campaign has used (deduped by user), so changing the
// link never resets progress or lets the campaign over-deliver.
function delivered(campaign, verifiedList) {
    if (!campaign || !campaign.paidAt) return 0;
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const keys = campaignAdKeys(campaign);
    if (!keys.size) return 0;
    const seen = new Set();
    for (const u of list) {
        if (u && keys.has(u.adKey) && Number(u.timestamp) > campaign.paidAt) seen.add(u.id);
    }
    return seen.size;
}

// A public-safe view of a campaign for the buyer dashboard.
function publicView(campaign, verifiedList) {
    const del = delivered(campaign, verifiedList);
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
        disabledGuilds: Array.isArray(campaign.disabledGuilds) ? campaign.disabledGuilds : [],
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
// server has a network bot (so the join can be verified). Each carries its
// `remaining` (unmet joins) as the selection weight. Callers pick from this —
// weighted-random for a single ad, or in weighted order to skip sponsors the
// verifying user is already a member of.
function eligibleForGuild(displayGuildId, verifiedList, botGuildIds) {
    const camps = loadCampaigns();
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const eligible = [];
    for (const c of Object.values(camps)) {
        if (!c || c.status !== 'active' || c.paused) continue;
        if (c.sponsorGuildId === displayGuildId) continue;                 // never on itself
        if (Array.isArray(c.disabledGuilds) && c.disabledGuilds.includes(displayGuildId)) continue;
        if (botGuildIds && !botGuildIds.has(c.sponsorGuildId)) continue;   // no bot on buyer's server
        const remaining = c.purchased - delivered(c, list);
        if (remaining <= 0) continue;                                      // already done
        eligible.push({ id: c.id, invite: c.invite, sponsorGuildId: c.sponsorGuildId, remaining });
    }
    return eligible;
}

// A weighted-random ORDER of eligible campaigns (Efraimidis–Spirakis reservoir:
// key = random^(1/weight), sort desc). Lets a caller try candidates in a fair,
// remaining-weighted order — e.g. to pick the first sponsor the user isn't on.
function weightedOrder(eligible) {
    return (Array.isArray(eligible) ? eligible : [])
        .map((e) => ({ e, key: Math.pow(Math.random() || 1e-12, 1 / Math.max(1e-9, e.remaining)) }))
        .sort((a, b) => b.key - a.key)
        .map((x) => x.e);
}

// Pick a campaign to show on a display guild, WEIGHTED BY REMAINING JOINS so
// bigger unmet orders get more exposure while smaller ones still finish — no
// single order hogs, no congestion. Returns { invite, campaignId,
// sponsorGuildId } or null. (User-membership-aware selection lives in the
// verification handler, which uses eligibleForGuild + weightedOrder.)
function pickForGuild(displayGuildId, verifiedList, botGuildIds) {
    const eligible = eligibleForGuild(displayGuildId, verifiedList, botGuildIds);
    const total = eligible.reduce((s, e) => s + e.remaining, 0);
    if (!eligible.length || total <= 0) return null;
    let r = Math.random() * total;
    for (const e of eligible) { r -= e.remaining; if (r <= 0) return { invite: e.invite, campaignId: e.id, sponsorGuildId: e.sponsorGuildId }; }
    const e = eligible[eligible.length - 1];
    return { invite: e.invite, campaignId: e.id, sponsorGuildId: e.sponsorGuildId };
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
        started: `✅ Оплата получена — твоя реклама запущена!\nСервер: ${server}\nЗаказано заходов: **${campaign.purchased}**. Следи за прогрессом в личном кабинете.`,
        complete: `🎉 Реклама выполнена!\nСервер: ${server}\nДоставлено заходов: **${campaign.purchased}/${campaign.purchased}**. Спасибо за заказ!`,
        invalid: `⚠️ Реклама остановлена: ссылка-приглашение стала недействительной.\nСервер: ${server}\nОбнови приглашение и обратись в поддержку, чтобы возобновить показ.`
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

const inviteCodeOf = (invite) => { const m = String(invite || '').match(/([a-z0-9-]{2,32})\/?$/i); return m ? m[1] : ''; };

// true = valid, false = definitely invalid (Unknown Invite), null = couldn't
// tell (network/transient) — don't act on null.
async function isInviteValid(clients, invite) {
    const code = inviteCodeOf(invite);
    if (!code) return false;
    const client = (Array.isArray(clients) ? clients : [])[0];
    if (!client) return null;
    try { const inv = await client.fetchInvite(code); return Boolean(inv?.guild?.id); }
    catch (e) { return e?.code === 10006 ? false : null; } // 10006 = Unknown Invite
}

// Periodic reconciliation: activate paid pending campaigns and complete
// finished ones. Also usable on demand (dashboard load) for one campaign.
async function reconcile(clients) {
    const camps = loadCampaigns();
    const verified = loadJSON('verified.json', []);
    let changed = false;
    const now = Date.now();
    for (const c of Object.values(camps)) {
        if (!c) continue;
        // Legacy invoice-checkout campaigns are gone — orders are now paid
        // straight from the prepaid wallet and created 'active'. Any lingering
        // unpaid campaign is a dead checkout from the old system: purge it.
        if (c.status === 'pending_payment') { delete camps[c.id]; changed = true; continue; }
        if (c.status === 'active') {
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
            if (delivered(c, verified) >= c.purchased) {
                c.status = 'complete'; c.completedAt = now; changed = true;
                notifyBuyer(clients, c, 'complete').catch(() => null);
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
    PRICE_PER_100, MIN_JOINS, priceFor, round2, newId,
    loadCampaigns, saveCampaigns, campaignAdKey, campaignAdKeys, delivered, publicView, pickForGuild, eligibleForGuild, weightedOrder, botPresent, fleetGuildIds,
    isInvoicePaid, reconcile, startCampaignSweep, retention
};

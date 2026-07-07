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

// Unique verified joins delivered since the campaign went active.
function delivered(campaign, verifiedList) {
    if (!campaign || !campaign.paidAt) return 0;
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    return joinerCount(list, campaignAdKey(campaign), campaign.paidAt);
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

// Round-robin the eligible campaigns for a display guild. Returns
// { invite, campaignId, sponsorGuildId } or null. Stateless-ish: a global
// rotating counter spreads exposure across concurrent campaigns.
let _rr = 0;
function pickForGuild(displayGuildId, verifiedList) {
    const camps = loadCampaigns();
    const list = Array.isArray(verifiedList) ? verifiedList : loadJSON('verified.json', []);
    const eligible = [];
    for (const c of Object.values(camps)) {
        if (!c || c.status !== 'active' || c.paused) continue;
        if (c.sponsorGuildId === displayGuildId) continue;                 // never on itself
        if (Array.isArray(c.disabledGuilds) && c.disabledGuilds.includes(displayGuildId)) continue;
        if (delivered(c, list) >= c.purchased) continue;                   // already done
        eligible.push(c);
    }
    if (!eligible.length) return null;
    const c = eligible[_rr % eligible.length];
    _rr = (_rr + 1) % 1e9;
    return { invite: c.invite, campaignId: c.id, sponsorGuildId: c.sponsorGuildId };
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
    for (const c of list) {
        const u = await c.users?.fetch(campaign.buyerId).catch(() => null);
        if (!u) continue;
        const msg = kind === 'started'
            ? `✅ Оплата получена — твоя реклама запущена!\nСервер: ${campaign.serverName || campaign.invite}\nЗаказано заходов: **${campaign.purchased}**. Следи за прогрессом в личном кабинете.`
            : `🎉 Реклама выполнена!\nСервер: ${campaign.serverName || campaign.invite}\nДоставлено заходов: **${campaign.purchased}/${campaign.purchased}**. Спасибо за заказ!`;
        const ok = await u.send({ content: msg }).then(() => true).catch(() => false);
        if (ok) return;
    }
}

// Periodic reconciliation: activate paid pending campaigns and complete
// finished ones. Also usable on demand (dashboard load) for one campaign.
async function reconcile(clients) {
    const camps = loadCampaigns();
    const verified = loadJSON('verified.json', []);
    let changed = false;
    for (const c of Object.values(camps)) {
        if (!c) continue;
        if (c.status === 'pending_payment' && await isInvoicePaid(c.invoiceId)) {
            c.status = 'active'; c.paidAt = Date.now(); changed = true;
            notifyBuyer(clients, c, 'started').catch(() => null);
        }
        if (c.status === 'active' && delivered(c, verified) >= c.purchased) {
            c.status = 'complete'; c.completedAt = Date.now(); changed = true;
            notifyBuyer(clients, c, 'complete').catch(() => null);
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

module.exports = {
    PRICE_PER_100, MIN_JOINS, priceFor, round2, newId,
    loadCampaigns, saveCampaigns, campaignAdKey, delivered, publicView, pickForGuild,
    isInvoicePaid, reconcile, startCampaignSweep
};

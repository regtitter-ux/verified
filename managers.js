// Sales managers.
//
// The owner can appoint sales managers on the order page. A manager buys joins
// from us at a discounted rate (MANAGER_PRICE per 100 instead of the public
// price) and keeps their margin at the deal — buyers pay the manager the retail
// price directly, the manager pays us the discounted price. So we DON'T credit
// managers anything; a manager sale simply brings less revenue ($9/100 instead
// of $10/100). That discount is surfaced as "manager margin" in the stats and
// naturally lowers profit before shares are split (see shares.js / api.js).
const { loadJSON, saveJSON } = require('./database.js');

const PRICE_PER_100 = Number(process.env.MANAGER_PRICE) || 9;          // $ per 100 joins for managers
// Manager margin as a fraction of retail = (retail − manager) / retail. Only
// used to describe the discount on the order page; no money is paid out.
const COMMISSION_RATE = Number.isFinite(Number(process.env.MANAGER_COMMISSION_RATE))
    ? Number(process.env.MANAGER_COMMISSION_RATE) : 0.10;

const round2 = (n) => +(Number(n) || 0).toFixed(2);
const round4 = (n) => +(Number(n) || 0).toFixed(4);

function loadManagers() {
    const raw = loadJSON('managers.json', null);
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.managers) ? raw.managers : []);
    return arr.filter((x) => /^\d{17,20}$/.test(String(x)));
}
function saveManagers(list) {
    const clean = [...new Set((list || []).map((x) => String(x)).filter((x) => /^\d{17,20}$/.test(x)))];
    saveJSON('managers.json', clean);
    return clean;
}
function isManager(id) { return loadManagers().includes(String(id || '')); }

// Per-join price ($) for a buyer, and the manager commission per join at that
// price (0 for non-managers). priceFor100 is passed so the public price stays
// the single source of truth in campaigns.js.
function priceForBuyer(buyerId, publicPricePer100) {
    const manager = isManager(buyerId);
    const per100 = manager ? PRICE_PER_100 : Number(publicPricePer100) || 0;
    return { manager, pricePer100: per100 };
}

// Per-join revenue for a confirmed join, given the campaign it belongs to (or
// null for a house-ad join). Manager campaigns bring the discounted price;
// everything else keeps the public revenue. No commission is ever paid — the
// manager's margin lives entirely in the retail-vs-discount spread.
function joinEconomics(campaign, publicRevenuePerJoin) {
    const pub = Number(publicRevenuePerJoin) || 0;
    if (!campaign || !campaign.managerId) return { revenue: pub, managerId: null };
    const per100 = Number(campaign.pricePer100) || PRICE_PER_100;
    return { revenue: round4(per100 / 100), managerId: String(campaign.managerId) };
}

module.exports = { PRICE_PER_100, COMMISSION_RATE, loadManagers, saveManagers, isManager, priceForBuyer, joinEconomics, round2, round4 };

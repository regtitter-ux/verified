// Sales managers.
//
// The owner can appoint sales managers on the order page. A manager buys joins
// at a discounted rate (MANAGER_PRICE per 100 instead of the public price) and
// earns a commission (MANAGER_COMMISSION_RATE of every join they sell) credited
// to their bot balance. That commission is a real cost, so it's subtracted from
// service profit before shares are split (see shares.js / api.js stats).
const { loadJSON, saveJSON } = require('./database.js');

const PRICE_PER_100 = Number(process.env.MANAGER_PRICE) || 9;          // $ per 100 joins for managers
const COMMISSION_RATE = Number.isFinite(Number(process.env.MANAGER_COMMISSION_RATE))
    ? Number(process.env.MANAGER_COMMISSION_RATE) : 0.10;               // 10% of the sale

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

// Per-join economics for a confirmed join, given the campaign it belongs to
// (or null for a house-ad join) and the public per-join revenue. Manager
// campaigns charge less and owe a commission; everything else keeps the
// public revenue with no commission.
function joinEconomics(campaign, publicRevenuePerJoin) {
    const pub = Number(publicRevenuePerJoin) || 0;
    if (!campaign || !campaign.managerId) return { revenue: pub, managerCommission: 0, managerId: null };
    const per100 = Number(campaign.pricePer100) || PRICE_PER_100;
    const revenue = round4(per100 / 100);
    const rate = Number.isFinite(Number(campaign.commissionRate)) ? Number(campaign.commissionRate) : COMMISSION_RATE;
    return { revenue, managerCommission: round4(revenue * rate), managerId: String(campaign.managerId) };
}

// Credit a manager's commission straight to their bot balance. Loads settings
// fresh so it never clobbers a concurrent partner/share credit.
function creditCommission(managerId, amount) {
    const amt = round4(amount);
    if (!managerId || !(amt > 0)) return 0;
    const settings = loadJSON('settings.json');
    if (!settings[managerId]) settings[managerId] = { advText: '', serverAds: {}, partners: [] };
    settings[managerId].balance = round2((Number(settings[managerId].balance) || 0) + amt);
    saveJSON('settings.json', settings);
    return amt;
}

module.exports = { PRICE_PER_100, COMMISSION_RATE, loadManagers, saveManagers, isManager, priceForBuyer, joinEconomics, creditCommission, round2, round4 };

// Ad-sales ledger.
//
// Records every paid ad campaign (wallet debit or a paid invoice) as an
// explicit revenue event, so ad purchases are visible in the stats instead of
// only surfacing indirectly as per-join profit. The per-join share split
// (payShares) still distributes the service margin to shareholders as joins
// actually deliver; this ledger is the top-line "what buyers paid" view and
// lets us show prepaid-but-undelivered money.
const { loadJSON, saveJSON } = require('./database.js');

function loadSales() { const r = loadJSON('adsales.json', []); return Array.isArray(r) ? r : []; }

// Record a sale once per campaign (idempotent — safe to call from both the
// wallet path and the invoice-activation path).
function recordSale(rec) {
    if (!rec || !rec.amount) return;
    const list = loadSales();
    if (rec.campaignId && list.some((s) => s.campaignId === rec.campaignId)) return;
    list.push({
        campaignId: rec.campaignId || null,
        buyerId: rec.buyerId || null,
        amount: +(Number(rec.amount) || 0).toFixed(2),
        joins: Number(rec.joins) || 0,
        sponsorGuildId: rec.sponsorGuildId || null,
        managerId: rec.managerId || null,
        via: rec.via || null,               // 'wallet' | 'invoice'
        at: Date.now()
    });
    saveJSON('adsales.json', list);
}

function salesWindows(now = Date.now()) {
    const list = loadSales();
    const sum = (ms) => list.filter((s) => (s.at || 0) > now - ms).reduce((a, s) => a + (Number(s.amount) || 0), 0);
    const r2 = (n) => +((Number(n) || 0).toFixed(2));
    return {
        day: r2(sum(86400000)), week: r2(sum(604800000)), month: r2(sum(2592000000)),
        total: r2(list.reduce((a, s) => a + (Number(s.amount) || 0), 0)),
        count: list.length
    };
}

module.exports = { loadSales, recordSale, salesWindows };

// Public, no-auth, read-only routes — the first slice extracted from the api.js
// mega-handler, and the template for decomposing the rest.
//
// Route-module contract: `handle(ctx)` returns true iff it served the request,
// else false (so the caller falls through to the next handler / module). `ctx`
// carries the per-request primitives (res, method, path, the `send` helper, the
// DOCS payload) so route logic can live outside the 3990-line handler. The
// remaining domains (order/partner/admin/webhooks) move out the same way,
// incrementally — each verified by booting the API standalone and smoke-testing.
const feed = require('../feed.js');
const campaigns = require('../campaigns.js');

function handle(ctx) {
    const { res, method, p, send, DOCS } = ctx;
    if (method === 'GET' && (p === '/' || p === '/api')) return send(res, 200, DOCS), true;
    if (method === 'GET' && p === '/health') return send(res, 200, { ok: true }), true;
    if (method === 'GET' && p === '/feed') return send(res, 200, { servers: feed.loadFeed(), pricePer100: campaigns.PRICE_PER_100 }, { 'Access-Control-Allow-Origin': '*' }), true;
    if (method === 'GET' && p === '/pricing') return send(res, 200, { pricePer100: campaigns.PRICE_PER_100, pricePerJoin: campaigns.PRICE_PER_100 / 100 }, { 'Access-Control-Allow-Origin': '*' }), true;
    return false;
}

module.exports = { handle };

// NOWPayments crypto payment gateway — hosted WEB checkout (invoice), so a buyer
// pays from ANY wallet (no Telegram / no bot). Non-custodial-friendly, RF-ok, and
// no mandatory KYC for standard acceptance. Used as the primary web checkout.
//
// Configure: NOWPAYMENTS_API_KEY (required, from Dashboard → Settings → API keys)
// + NOWPAYMENTS_IPN_SECRET (recommended — used to authenticate webhook callbacks;
// crediting is authoritative regardless, via a server-side status re-fetch).
// Docs: https://documenter.getpostman.com/view/7907941/S1a32n38
const https = require('https');
const crypto = require('crypto');

const API_KEY = (process.env.NOWPAYMENTS_API_KEY || '').trim();
const IPN_SECRET = (process.env.NOWPAYMENTS_IPN_SECRET || '').trim();
const HOST = 'api.nowpayments.io';

const enabled = () => Boolean(API_KEY);
const hasSecret = () => Boolean(IPN_SECRET);

function call(path, method, params, extraHeaders) {
    return new Promise((resolve, reject) => {
        const body = params ? JSON.stringify(params) : null;
        const headers = { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(extraHeaders || {}) };
        if (body) headers['Content-Length'] = Buffer.byteLength(body);
        const req = https.request({ host: HOST, path, method, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
                    else reject(new Error(j.message || `nowpayments ${res.statusCode}`));
                } catch (e) { reject(new Error('bad response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        if (body) req.write(body);
        req.end();
    });
}

// Default coin the buyer is sent straight to (LTC — low minimum, cheap fees).
// Override with NOWPAYMENTS_PAY_CURRENCY, or set it '' to let the buyer choose.
const PAY_CURRENCY = 'NOWPAYMENTS_PAY_CURRENCY' in process.env
    ? (process.env.NOWPAYMENTS_PAY_CURRENCY || '').trim().toLowerCase()
    : 'ltc';

// Create a hosted invoice. Returns { url, id } — `url` is the page the buyer opens
// to pay. If a pay currency is set, they land straight on that coin's payment.
async function createPayment({ amount, orderId, currency = 'usd', callbackUrl, returnUrl }) {
    const params = {
        price_amount: Number(amount),
        price_currency: currency,
        order_id: String(orderId),
        order_description: 'Vemoni balance top-up'
    };
    if (PAY_CURRENCY) params.pay_currency = PAY_CURRENCY;
    if (callbackUrl) params.ipn_callback_url = callbackUrl;
    if (returnUrl) { params.success_url = returnUrl; params.cancel_url = returnUrl; }
    const r = await call('/v1/invoice', 'POST', params);
    return { url: r.invoice_url, id: r.id };
}

// Statuses that mean the money has actually arrived / is on-chain confirmed.
const PAID = new Set(['finished', 'confirmed']);
const isPaidStatus = (s) => PAID.has(String(s || ''));

// Full payment record from NOWPayments (authoritative), or null if unreachable.
// Fetched with our API key, so a forged webhook can't fake a paid status.
async function paymentInfo(paymentId) {
    return call('/v1/payment/' + encodeURIComponent(paymentId), 'GET', null).catch(() => null);
}
async function paymentStatus(paymentId) {
    const r = await paymentInfo(paymentId);
    return r ? r.payment_status : null;
}

// Verify an IPN callback signature (extra defence-in-depth; the credit decision
// relies on paymentInfo). NOWPayments signs HMAC-SHA512 of the JSON body with keys
// sorted alphabetically, using the IPN secret, sent in the x-nowpayments-sig header.
function sortDeep(obj) {
    if (Array.isArray(obj)) return obj.map(sortDeep);
    if (obj && typeof obj === 'object') {
        return Object.keys(obj).sort().reduce((a, k) => { a[k] = sortDeep(obj[k]); return a; }, {});
    }
    return obj;
}
function verifyWebhook(bodyObj, signature) {
    try {
        if (!IPN_SECRET || !signature || !bodyObj || typeof bodyObj !== 'object') return false;
        const hmac = crypto.createHmac('sha512', IPN_SECRET).update(JSON.stringify(sortDeep(bodyObj))).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(signature)));
    } catch { return false; }
}

// ---- Payouts (mass-payout API) ----
// Sending money out needs the account LOGIN (a short-lived JWT) on top of the API
// key. Read live from the env so a change in the admin panel applies on save.
// NOTE: NOWPayments gates payouts behind (a) address whitelisting and (b) 2FA
// verification per batch — both must be disabled by their support for payouts to
// go through unattended, otherwise the batch just sits WAITING.
const payoutEmail = () => (process.env.NOWPAYMENTS_EMAIL || '').trim();
const payoutPassword = () => (process.env.NOWPAYMENTS_PASSWORD || '').trim();
const payoutCurrency = () => (process.env.NOWPAYMENTS_PAYOUT_CURRENCY || 'ltc').trim().toLowerCase();
const payoutEnabled = () => Boolean(API_KEY && payoutEmail() && payoutPassword());

let _jwt = { at: 0, token: '' };
async function authJwt() {
    if (_jwt.token && Date.now() - _jwt.at < 4 * 60 * 1000) return _jwt.token; // JWT lives ~5 min
    const r = await call('/v1/auth', 'POST', { email: payoutEmail(), password: payoutPassword() });
    if (!r || !r.token) throw new Error('auth failed');
    _jwt = { at: Date.now(), token: r.token };
    return r.token;
}

// USD → the payout coin. Returns the coin amount, or null if it can't be estimated.
async function estimatePayout(amountUsd) {
    const p = `/v1/estimate?amount=${encodeURIComponent(amountUsd)}&currency_from=usd&currency_to=${encodeURIComponent(payoutCurrency())}`;
    const r = await call(p, 'GET', null).catch(() => null);
    const v = Number(r && r.estimated_amount);
    return Number.isFinite(v) && v > 0 ? v : null;
}

// Send `amount` (in the payout coin) to `address`. Returns the batch object.
async function createPayout({ address, amount, currency, ipnCallbackUrl }) {
    const jwt = await authJwt();
    const w = { address: String(address), currency: currency || payoutCurrency(), amount: Number(amount) };
    const body = { withdrawals: [w] };
    if (ipnCallbackUrl) { body.ipn_callback_url = ipnCallbackUrl; w.ipn_callback_url = ipnCallbackUrl; }
    return call('/v1/payout', 'POST', body, { Authorization: 'Bearer ' + jwt });
}

// Batch/withdrawal record, or null. Used to settle or refund a pending payout.
async function payoutInfo(id) {
    const jwt = await authJwt().catch(() => null);
    if (!jwt) return null;
    return call('/v1/payout/' + encodeURIComponent(id), 'GET', null, { Authorization: 'Bearer ' + jwt }).catch(() => null);
}
const PAYOUT_DONE = new Set(['FINISHED']);
const PAYOUT_DEAD = new Set(['FAILED', 'REJECTED', 'EXPIRED']);
const isPayoutDone = (s) => PAYOUT_DONE.has(String(s || '').toUpperCase());
const isPayoutDead = (s) => PAYOUT_DEAD.has(String(s || '').toUpperCase());

module.exports = {
    enabled, hasSecret, createPayment, paymentInfo, paymentStatus, isPaidStatus, verifyWebhook,
    payoutEnabled, payoutCurrency, estimatePayout, createPayout, payoutInfo, isPayoutDone, isPayoutDead
};

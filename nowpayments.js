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

function call(path, method, params) {
    return new Promise((resolve, reject) => {
        const body = params ? JSON.stringify(params) : null;
        const headers = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };
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

// Create a hosted invoice. Returns { url, id } — `url` is the page the buyer opens
// to pay from any crypto wallet (they choose the coin on that page).
async function createPayment({ amount, orderId, currency = 'usd', callbackUrl, returnUrl }) {
    const params = {
        price_amount: Number(amount),
        price_currency: currency,
        order_id: String(orderId),
        order_description: 'Vemoni balance top-up'
    };
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

module.exports = { enabled, hasSecret, createPayment, paymentInfo, paymentStatus, isPaidStatus, verifyWebhook };

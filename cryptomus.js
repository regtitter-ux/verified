// Cryptomus crypto payment gateway — hosted WEB checkout, so a buyer pays from ANY
// wallet (no Telegram / no bot required). Used alongside CryptoBot for people who
// aren't Telegram users.
//
// Configure: CRYPTOMUS_MERCHANT (merchant UUID) + CRYPTOMUS_API_KEY (Payment API key,
// from the Cryptomus merchant dashboard). Docs: https://doc.cryptomus.com
const https = require('https');
const crypto = require('crypto');

const MERCHANT = (process.env.CRYPTOMUS_MERCHANT || '').trim();
const API_KEY = (process.env.CRYPTOMUS_API_KEY || '').trim();
const HOST = 'api.cryptomus.com';

const enabled = () => Boolean(MERCHANT && API_KEY);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function call(path, params) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(params);
        // We sign exactly the bytes we send, so Cryptomus can verify regardless of
        // any JSON slash-escaping differences.
        const sign = md5(Buffer.from(body).toString('base64') + API_KEY);
        const req = https.request({
            host: HOST, path, method: 'POST',
            headers: { merchant: MERCHANT, sign, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j.state === 0) resolve(j.result);
                    else reject(new Error(j.message || (j.errors ? JSON.stringify(j.errors) : 'cryptomus error')));
                } catch (e) { reject(new Error('bad response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        req.write(body);
        req.end();
    });
}

// Create a hosted payment. Returns { uuid, order_id, url, ... } — `url` is the page
// the buyer opens to pay from any crypto wallet.
async function createPayment({ amount, orderId, currency = 'USD', callbackUrl, returnUrl }) {
    const params = { amount: String(amount), currency, order_id: String(orderId), lifetime: 3600 };
    if (callbackUrl) params.url_callback = callbackUrl;
    if (returnUrl) { params.url_return = returnUrl; params.url_success = returnUrl; }
    return call('/v1/payment', params);
}

const PAID = new Set(['paid', 'paid_over']);
const isPaidStatus = (s) => PAID.has(String(s || ''));

// Authoritative status re-fetch — the credit decision uses THIS, never the raw
// webhook body. Returns the status string, or null if unreachable.
async function paymentStatus(orderId) {
    const r = await call('/v1/payment/info', { order_id: String(orderId) }).catch(() => null);
    return r ? r.status : null;
}

// Best-effort webhook signature check (the authoritative check is paymentStatus).
function verifyWebhook(body) {
    try {
        if (!body || typeof body !== 'object' || !body.sign) return false;
        const { sign, ...rest } = body;
        const json = JSON.stringify(rest).replace(/\//g, '\\/');
        return md5(Buffer.from(json).toString('base64') + API_KEY) === sign;
    } catch { return false; }
}

module.exports = { enabled, createPayment, paymentStatus, isPaidStatus, verifyWebhook };

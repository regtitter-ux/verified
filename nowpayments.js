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

const apiKey = () => (process.env.NOWPAYMENTS_API_KEY || '').trim();
const ipnSecret = () => (process.env.NOWPAYMENTS_IPN_SECRET || '').trim();
const HOST = 'api.nowpayments.io';

const enabled = () => Boolean(apiKey());
const hasSecret = () => Boolean(ipnSecret());

function call(path, method, params, extraHeaders) {
    return new Promise((resolve, reject) => {
        const body = params ? JSON.stringify(params) : null;
        const headers = { 'x-api-key': apiKey(), 'Content-Type': 'application/json', ...(extraHeaders || {}) };
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
const payCurrency = () => 'NOWPAYMENTS_PAY_CURRENCY' in process.env
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
    if (payCurrency()) params.pay_currency = payCurrency();
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
        if (!ipnSecret() || !signature || !bodyObj || typeof bodyObj !== 'object') return false;
        const hmac = crypto.createHmac('sha512', ipnSecret()).update(JSON.stringify(sortDeep(bodyObj))).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(signature)));
    } catch { return false; }
}

// ---- Payouts (mass-payout API) ----
// Sending money out needs the account LOGIN (a short-lived JWT) on top of the API
// key. Read live from the env so a change in the admin panel applies on save.
// NOTE: NOWPayments gates payouts behind (a) address whitelisting and (b) per-batch
// verification. For unattended payouts either the account's support disables the
// per-batch verification entirely (current setup — a created batch just processes),
// OR 2FA (authenticator) stays on and we auto-verify each batch with the TOTP
// secret. With 2FA OFF and verification still required, the code arrives by email
// and CANNOT be automated — the batch would sit WAITING and expire in an hour.
const payoutEmail = () => (process.env.NOWPAYMENTS_EMAIL || '').trim();
const payoutPassword = () => (process.env.NOWPAYMENTS_PASSWORD || '').trim();
const payoutCurrency = () => (process.env.NOWPAYMENTS_PAYOUT_CURRENCY || 'ltc').trim().toLowerCase();
const payoutEnabled = () => Boolean(apiKey() && payoutEmail() && payoutPassword());

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

// ---- Payout 2FA ----
// NOWPayments guards each payout batch with a TOTP code (the same secret their
// dashboard shows when you set up 2FA). Generating it here lets payouts complete
// unattended WITHOUT asking support to disable 2FA — and an unverified batch is
// auto-rejected after an hour, so verifying immediately matters.
// RFC 6238, SHA-1/6 digits/30s — implemented on node's crypto, no dependency.
function base32Decode(str) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(str || '').toUpperCase().replace(/[=\s-]/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const c of clean) {
        const idx = A.indexOf(c);
        if (idx < 0) continue;
        value = (value << 5) | idx; bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
}
function totp(secret, at = Date.now()) {
    const key = base32Decode(secret);
    if (!key.length) return null;
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(Math.floor(at / 1000 / 30)));
    const h = crypto.createHmac('sha1', key).update(buf).digest();
    const o = h[h.length - 1] & 0x0f;
    const code = (((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff)) % 1000000;
    return String(code).padStart(6, '0');
}
const payout2faSecret = () => (process.env.NOWPAYMENTS_2FA_SECRET || '').trim();
const has2fa = () => Boolean(payout2faSecret());

// Verify a created batch so it actually goes out. Returns { ok } / { ok:false, reason }.
async function verifyPayout(batchId) {
    const secret = payout2faSecret();
    if (!secret) return { ok: false, reason: 'no-2fa-secret' };
    const code = totp(secret);
    if (!code) return { ok: false, reason: 'bad-2fa-secret' };
    try {
        const jwt = await authJwt();
        await call(`/v1/payout/${encodeURIComponent(batchId)}/verify`, 'POST', { verification_code: code }, { Authorization: 'Bearer ' + jwt });
        return { ok: true };
    } catch (e) { return { ok: false, reason: e.message || 'verify failed' }; }
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

// Total AVAILABLE custody balance across all coins, in USD. Best-effort: each
// non-zero coin balance is converted to USD via the estimate endpoint (stable-
// coins counted ~1:1). Excludes pendingAmount (still settling). Null when the API
// is unreachable. NOWPayments rate-limits hard, so callers MUST cache this.
async function balanceUsd() {
    if (!enabled()) return null;
    const bal = await call('/v1/balance', 'GET', null).catch(() => null);
    if (!bal || typeof bal !== 'object') return null;
    let usd = 0;
    for (const [coin, info] of Object.entries(bal)) {
        const amt = Number(info && info.amount) || 0;
        if (amt <= 0) continue;
        const c = String(coin).toLowerCase();
        if (c === 'usd' || c.startsWith('usdt') || c.startsWith('usdc') || c.startsWith('dai') || c.startsWith('busd')) { usd += amt; continue; }
        const est = await call(`/v1/estimate?amount=${amt}&currency_from=${encodeURIComponent(c)}&currency_to=usd`, 'GET', null).catch(() => null);
        usd += Number(est && est.estimated_amount) || 0;
    }
    return Math.round(usd * 100) / 100;
}

module.exports = {
    enabled, hasSecret, createPayment, paymentInfo, paymentStatus, isPaidStatus, verifyWebhook,
    payoutEnabled, payoutCurrency, estimatePayout, createPayout, payoutInfo, isPayoutDone, isPayoutDead,
    has2fa, verifyPayout, totp, balanceUsd
};

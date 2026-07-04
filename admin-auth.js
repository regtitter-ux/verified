// Admin panel authentication — TOTP (RFC 6238) + HMAC-signed session cookies.
// Zero external deps; uses Node's built-in `crypto`.
//
// Setup: set two env vars in Railway.
//   TOTP_SECRET           — base32-encoded shared secret, scan-able as
//                           otpauth://totp/Vemoni:admin?secret=…&issuer=Vemoni
//                           in Google Authenticator / Authy / 1Password.
//   ADMIN_SESSION_SECRET  — any long random string; signs session cookies so
//                           they can't be forged. Rotating it invalidates
//                           every active admin session (log everyone out).
const crypto = require('crypto');

const TOTP_SECRET = (process.env.TOTP_SECRET || '').trim().replace(/\s+/g, '').toUpperCase();
const ADMIN_SESSION_SECRET = (process.env.ADMIN_SESSION_SECRET || '').trim();
const SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS) || 30 * 24 * 3600 * 1000; // 30 days
const SESSION_COOKIE = 'vemoni_admin';
const TOTP_STEP = 30;      // seconds
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;     // ± 1 step of drift accepted

const enabled = () => Boolean(TOTP_SECRET) && Boolean(ADMIN_SESSION_SECRET);

// ---------- Base32 (RFC 4648, no padding required) ----------
const B32_ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(str) {
    const cleaned = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = '';
    for (const ch of cleaned) {
        const i = B32_ALPH.indexOf(ch);
        if (i < 0) throw new Error('bad base32');
        bits += i.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}

function base32Encode(buf) {
    let bits = '';
    for (const b of buf) bits += b.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) out += B32_ALPH[parseInt(bits.slice(i, i + 5), 2)];
    return out;
}

// Standalone helper — used once to mint an initial secret for the operator.
// Not called from any live code path; just makes `node -e "…"` handy.
function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20)); // 160 bits, RFC-recommended
}

// ---------- TOTP verification (RFC 6238, HMAC-SHA1) ----------
function hotp(secretBuf, counter) {
    const buf = Buffer.alloc(8);
    // counter as big-endian 64-bit
    for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
    const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
    const off = h[h.length - 1] & 0x0f;
    const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
    return (bin % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

// Verify against current + adjacent steps to tolerate small clock skew.
// Returns true on match, false otherwise.
function verifyTotp(code) {
    if (!enabled()) return false;
    const digits = String(code || '').replace(/\D/g, '');
    if (digits.length !== TOTP_DIGITS) return false;
    let secretBuf;
    try { secretBuf = base32Decode(TOTP_SECRET); } catch { return false; }
    const step = Math.floor(Date.now() / 1000 / TOTP_STEP);
    for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
        // constant-time compare guards against timing side channels
        const expected = hotp(secretBuf, step + w);
        if (expected.length === digits.length &&
            crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return true;
    }
    return false;
}

// ---------- Session cookies ----------
// Format: `<expiresMs>.<hmac>` — no session state on the server; validity is
// proven by the HMAC, expiry by the timestamp. Rotating ADMIN_SESSION_SECRET
// invalidates every issued token.
function sign(payload) {
    return crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex');
}

function issueSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const payload = String(expires);
    return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
    if (!enabled() || !token) return false;
    const [payload, mac] = String(token).split('.');
    if (!payload || !mac) return false;
    const expected = sign(payload);
    if (expected.length !== mac.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return false;
    const expires = Number(payload);
    return Number.isFinite(expires) && expires > Date.now();
}

// Parse the session token out of a Cookie header.
function readSessionCookie(cookieHeader) {
    if (!cookieHeader) return '';
    for (const chunk of String(cookieHeader).split(';')) {
        const [k, ...v] = chunk.trim().split('=');
        if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
    }
    return '';
}

function sessionCookieHeader(token, { clear = false } = {}) {
    const parts = [
        `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=None',                  // cross-origin (vemoni.info → api)
    ];
    if (clear) parts.push('Max-Age=0');
    else parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return parts.join('; ');
}

module.exports = {
    SESSION_COOKIE, SESSION_TTL_MS,
    enabled, verifyTotp, issueSession, verifySession,
    readSessionCookie, sessionCookieHeader, generateTotpSecret
};

// One-time login codes — an alternative to Discord OAuth for users who share a
// server with any of our fleet bots (so we can DM them the code).
//
// Flow: user enters their Discord id → we DM a 6-digit code (valid 10 min) →
// they paste it back → we issue the normal session cookies. A new code can be
// requested at most once per hour. Codes are kept in memory only (never written
// to disk) and are single-shot with a small attempt cap to stop brute force.
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;        // code lives 10 minutes
const REQUEST_COOLDOWN_MS = 60 * 60 * 1000; // one new code per hour
const MAX_ATTEMPTS = 5;                      // wrong-code tries before the code dies

const store = new Map();        // userId -> { code, expires, attempts }
const lastRequest = new Map();  // userId -> ts (cooldown gate)

function newCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Cooldown check — call BEFORE generating/DMing so a rejected request doesn't
// burn the hour.
function canRequest(userId) {
    const last = lastRequest.get(String(userId)) || 0;
    const wait = REQUEST_COOLDOWN_MS - (Date.now() - last);
    return wait <= 0 ? { ok: true } : { ok: false, retryAfterMs: wait };
}

// Commit a freshly-DMed code: store it and start the 1-hour cooldown. Only call
// this once the DM actually went out.
function save(userId, code) {
    const id = String(userId);
    store.set(id, { code, expires: Date.now() + CODE_TTL_MS, attempts: 0 });
    lastRequest.set(id, Date.now());
}

// Verify a submitted code. Reasons: 'no-code' | 'expired' | 'too-many' | 'bad-code'.
function verify(userId, code) {
    const id = String(userId);
    const rec = store.get(id);
    if (!rec) return { ok: false, reason: 'no-code' };
    if (Date.now() > rec.expires) { store.delete(id); return { ok: false, reason: 'expired' }; }
    if (rec.attempts >= MAX_ATTEMPTS) { store.delete(id); return { ok: false, reason: 'too-many' }; }
    rec.attempts++;
    const given = String(code || '').trim();
    if (given.length !== 6 || !crypto.timingSafeEqual(Buffer.from(given.padEnd(6).slice(0, 6)), Buffer.from(rec.code))) {
        const left = MAX_ATTEMPTS - rec.attempts;
        if (left <= 0) store.delete(id);
        return { ok: false, reason: 'bad-code', attemptsLeft: Math.max(0, left) };
    }
    store.delete(id); // single-shot
    return { ok: true };
}

// Occasional cleanup so the maps can't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [id, r] of store) if (now > r.expires) store.delete(id);
    for (const [id, ts] of lastRequest) if (now - ts > REQUEST_COOLDOWN_MS) lastRequest.delete(id);
}, 15 * 60 * 1000).unref?.();

module.exports = { newCode, canRequest, save, verify, CODE_TTL_MS, REQUEST_COOLDOWN_MS };

// Admin-panel 2FA gate. First factor: a login + password (password stored hashed,
// changeable via a Telegram bot slash command). Second factor: a 6-digit code sent
// to the owner's Telegram — ONE attempt per code, a fresh one auto-sent on a wrong
// try, and at most 3 codes per rolling 24h. Passing both issues the gate cookie
// (see admin-auth.js) that /admin routes require on top of the session, so a stolen
// Discord session alone can't open the panel.
//
// Env (Railway — SECRETS, never committed):
//   TG_ADMIN_BOT_TOKEN  — Telegram bot token (sends codes, takes /setpass)
//   ADMIN_GATE_CHAT_ID  — owner's Telegram user id (code recipient + /setpass authority)
//   ADMIN_GATE_LOGIN    — the login (default 'allanwood')
//   ADMIN_GATE_PASSWORD — seeds the password hash on first boot ONLY (then the hash
//                         in admin2fa.json is authoritative and changeable via TG)
const crypto = require('crypto');
const https = require('https');
const { loadJSON, saveJSON } = require('./database.js');

const TG_TOKEN = (process.env.TG_ADMIN_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.ADMIN_GATE_CHAT_ID || '').trim();
const LOGIN = (process.env.ADMIN_GATE_LOGIN || 'allanwood').trim();
const SEED_PASSWORD = (process.env.ADMIN_GATE_PASSWORD || '').trim();

const CODE_TTL_MS = 10 * 60 * 1000;   // a code is valid 10 minutes
const MAX_CODES_PER_DAY = 3;
const DAY_MS = 24 * 3600 * 1000;

// The gate is only enforced when a bot token + chat id are configured — otherwise
// codes can't be delivered and enforcing it would lock the panel out entirely.
const enabled = () => Boolean(TG_TOKEN && CHAT_ID);

// ---------- password store (admin2fa.json) ----------
function hashPass(pw, salt) { return crypto.createHash('sha256').update(String(salt) + '|' + String(pw)).digest('hex'); }
function loadStore() { const r = loadJSON('admin2fa.json', {}); return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {}; }
function ensureSeeded() {
    const s = loadStore();
    if (!s.passHash) {
        const salt = crypto.randomBytes(8).toString('hex');
        // Seed from env on first boot; if unset, use an un-guessable random password
        // (the owner then sets a real one via the Telegram /setpass command).
        const pw = SEED_PASSWORD || crypto.randomBytes(12).toString('hex');
        s.salt = salt; s.passHash = hashPass(pw, salt); s.seededAt = Date.now();
        saveJSON('admin2fa.json', s);
    }
    return loadStore();
}
function checkPassword(login, password) {
    if (String(login || '') !== LOGIN) return false;
    const s = ensureSeeded();
    const a = Buffer.from(hashPass(password, s.salt));
    const b = Buffer.from(String(s.passHash));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPassword(newPass) {
    const s = ensureSeeded();
    const salt = crypto.randomBytes(8).toString('hex');
    s.salt = salt; s.passHash = hashPass(newPass, salt); s.updatedAt = Date.now();
    saveJSON('admin2fa.json', s);
}

// ---------- code request rate limit (persisted so redeploys don't reset it) ----------
function reqTimes() { const s = loadStore(); const now = Date.now(); return (Array.isArray(s.codeReqTimes) ? s.codeReqTimes : []).filter((t) => now - Number(t) < DAY_MS); }
function saveReqTimes(arr) { const s = ensureSeeded(); s.codeReqTimes = arr; saveJSON('admin2fa.json', s); }
function clearReqTimes() { const s = ensureSeeded(); s.codeReqTimes = []; saveJSON('admin2fa.json', s); }
function remainingCodes() { return Math.max(0, MAX_CODES_PER_DAY - reqTimes().length); }

// ---------- codes (in-memory; ephemeral by design) ----------
const _challenges = new Map();   // challengeId -> { code, expiresAt, used }
function gen6() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function pruneChallenges() { const now = Date.now(); for (const [k, v] of _challenges) if (v.expiresAt < now) _challenges.delete(k); }

// Generate + Telegram-deliver a fresh code, honoring the 3-per-24h cap. Returns
// { challenge, remaining } on success, or { error: 'rate' | 'tg' }.
async function requestCode() {
    const times = reqTimes();
    if (times.length >= MAX_CODES_PER_DAY) return { error: 'rate', retryMs: DAY_MS - (Date.now() - Math.min(...times)) };
    const code = gen6();
    const id = crypto.randomBytes(12).toString('hex');
    pruneChallenges();
    _challenges.set(id, { code, expiresAt: Date.now() + CODE_TTL_MS, used: false });
    const left = MAX_CODES_PER_DAY - times.length - 1;
    const sent = await tgSend(`🔐 Код входа в админ-панель Vemoni: <b>${code}</b>\nДействует 10 минут, одна попытка. Осталось кодов за 24ч: ${left}.`).catch(() => false);
    if (!sent) { _challenges.delete(id); return { error: 'tg' }; }
    saveReqTimes([...times, Date.now()]);
    return { challenge: id, remaining: remainingCodes() };
}

// One attempt per code (consumed win or lose). Returns { ok } — caller auto-requests
// a fresh code on a miss (if under the cap).
function verifyCode(challengeId, code) {
    const ch = _challenges.get(String(challengeId || ''));
    if (!ch) return { ok: false, reason: 'no-challenge' };
    _challenges.delete(String(challengeId));   // consume: exactly one attempt
    if (ch.used || ch.expiresAt < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: String(code || '').trim() === ch.code };
}

// ---------- Telegram ----------
function tgApi(method, payload, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload || {});
        const req = https.request({ host: 'api.telegram.org', path: `/bot${TG_TOKEN}/${method}`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.write(data); req.end();
    });
}
async function tgSend(text) {
    if (!enabled()) return false;
    const r = await tgApi('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML' }).catch(() => null);
    return Boolean(r && r.ok);
}

// ---------- Telegram /setpass poller ----------
// Short-poll getUpdates; only the owner chat may change the password. /setpass also
// clears the code rate-limit window, so the owner can never lock themselves out.
let _offset = 0, _polling = false;
async function poll() {
    if (_polling) return; _polling = true;
    try {
        const r = await tgApi('getUpdates', { offset: _offset, timeout: 0 }).catch(() => null);
        if (r && r.ok && Array.isArray(r.result)) {
            for (const u of r.result) {
                _offset = u.update_id + 1;
                const msg = u.message; if (!msg || !msg.text) continue;
                const fromId = String((msg.from && msg.from.id) || '');
                const chatId = (msg.chat && msg.chat.id);
                const text = String(msg.text).trim();
                if (fromId !== CHAT_ID) { if (text.startsWith('/')) await tgApi('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' }).catch(() => {}); continue; }
                if (text === '/start') { await tgApi('sendMessage', { chat_id: chatId, text: 'Бот подключён. Сюда будут приходить коды входа в админ-панель. Сменить пароль: /setpass <новый пароль>.' }).catch(() => {}); continue; }
                if (text.startsWith('/setpass')) {
                    const np = text.slice('/setpass'.length).trim();
                    if (np.length < 4) { await tgApi('sendMessage', { chat_id: chatId, text: 'Использование: /setpass <новый пароль> (мин. 4 символа)' }).catch(() => {}); }
                    else { setPassword(np); clearReqTimes(); await tgApi('sendMessage', { chat_id: chatId, text: '✅ Пароль изменён. Лимит кодов сброшен.' }).catch(() => {}); }
                }
            }
        }
    } catch { /* ignore poll errors */ }
    finally { _polling = false; }
}
function startPoller() {
    if (!enabled()) { console.log('[ADMINGATE] no TG token/chat configured — 2FA gate DORMANT (panel keeps its normal auth)'); return; }
    ensureSeeded();
    setInterval(() => { poll().catch(() => {}); }, 4000);
    console.log('[ADMINGATE] 2FA gate active; Telegram /setpass poller running');
}

module.exports = { enabled, checkPassword, setPassword, requestCode, verifyCode, remainingCodes, startPoller, LOGIN };

// One-time login codes — an alternative to Discord OAuth for users who share a
// server with any of our fleet bots (so we can DM them the code).
//
// Flow: user enters their Discord id → we DM a 6-digit code (valid 10 min) →
// they paste it back → we issue the normal session cookies. A new code can be
// requested at most once per hour. Codes are kept in memory only (never written
// to disk) and are single-shot with a small attempt cap to stop brute force.
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;        // code lives 10 minutes
// Cooldown between code requests, in minutes, via LOGIN_CODE_COOLDOWN_MIN
// (default 60). 0 = no cooldown.
const _cd = process.env.LOGIN_CODE_COOLDOWN_MIN;
const COOLDOWN_MIN = _cd !== undefined && _cd !== '' && Number.isFinite(Number(_cd)) ? Math.max(0, Number(_cd)) : 60;
const REQUEST_COOLDOWN_MS = COOLDOWN_MIN * 60 * 1000;
const MAX_ATTEMPTS = 5;                      // wrong-code tries before the code dies

const store = new Map();        // userId -> { code, expires, attempts }
const lastRequest = new Map();  // userId -> ts (cooldown gate)

function newCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Cooldown check — call BEFORE generating/DMing so a rejected request doesn't
// burn the hour.
function canRequest(userId) {
    if (REQUEST_COOLDOWN_MS <= 0) return { ok: true }; // cooldown disabled
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

// ---- Localized DM text (default English; "Translation" button switches to the
// clicking user's Discord client locale) ----
const MESSAGES = {
    en: (c) => `🔐 **Login code for Vemoni:** \`${c}\`\nValid for 10 minutes. Enter it on the site to log in.\nIf you didn't request this, just ignore this message.`,
    ru: (c) => `🔐 **Код для входа на Vemoni:** \`${c}\`\nДействует 10 минут. Введите его на сайте, чтобы войти.\nЕсли вы это не запрашивали — просто проигнорируйте это сообщение.`,
    uk: (c) => `🔐 **Код для входу на Vemoni:** \`${c}\`\nДіє 10 хвилин. Введіть його на сайті, щоб увійти.\nЯкщо ви цього не запитували — просто проігноруйте це повідомлення.`,
    de: (c) => `🔐 **Login-Code für Vemoni:** \`${c}\`\nGültig für 10 Minuten. Gib ihn auf der Website ein, um dich anzumelden.\nFalls du das nicht angefordert hast, ignoriere diese Nachricht einfach.`,
    fr: (c) => `🔐 **Code de connexion pour Vemoni :** \`${c}\`\nValable 10 minutes. Saisis-le sur le site pour te connecter.\nSi tu n'es pas à l'origine de cette demande, ignore ce message.`,
    es: (c) => `🔐 **Código de acceso para Vemoni:** \`${c}\`\nVálido durante 10 minutos. Introdúcelo en el sitio para iniciar sesión.\nSi no solicitaste esto, simplemente ignora este mensaje.`,
    pt: (c) => `🔐 **Código de login do Vemoni:** \`${c}\`\nVálido por 10 minutos. Digite-o no site para entrar.\nSe você não solicitou isso, apenas ignore esta mensagem.`,
    pl: (c) => `🔐 **Kod logowania do Vemoni:** \`${c}\`\nWażny przez 10 minut. Wpisz go na stronie, aby się zalogować.\nJeśli tego nie żądałeś, po prostu zignoruj tę wiadomość.`,
    tr: (c) => `🔐 **Vemoni giriş kodu:** \`${c}\`\n10 dakika geçerlidir. Giriş yapmak için siteye girin.\nBunu siz talep etmediyseniz, bu mesajı görmezden gelin.`,
    it: (c) => `🔐 **Codice di accesso per Vemoni:** \`${c}\`\nValido per 10 minuti. Inseriscilo sul sito per accedere.\nSe non hai richiesto questo, ignora semplicemente questo messaggio.`
};
function localeToLang(locale) {
    const l = String(locale || '').toLowerCase();
    for (const k of ['ru', 'uk', 'de', 'fr', 'es', 'pt', 'pl', 'tr', 'it']) if (l.startsWith(k)) return k;
    return 'en';
}
function renderMessage(code, locale) {
    return (MESSAGES[localeToLang(locale)] || MESSAGES.en)(String(code || ''));
}

// Occasional cleanup so the maps can't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [id, r] of store) if (now > r.expires) store.delete(id);
    for (const [id, ts] of lastRequest) if (now - ts > REQUEST_COOLDOWN_MS) lastRequest.delete(id);
}, 15 * 60 * 1000).unref?.();

module.exports = { newCode, canRequest, save, verify, renderMessage, localeToLang, CODE_TTL_MS, REQUEST_COOLDOWN_MS };

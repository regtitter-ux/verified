// Runtime configuration overrides — edit selected settings from the admin panel
// WITHOUT touching Railway. Overrides live on the volume (runtimeconfig.json) and
// are applied onto process.env at BOOT, before the other modules read it, so every
// listed key takes effect on the next restart. A few keys (self-bot tokens) are
// also read live and apply immediately.
//
// Root/critical secrets — bot tokens (TOKENS), owner id, OAuth client id/secret,
// admin session secret, admin origin, data dir, ports — are deliberately NOT
// editable here; they stay in Railway.
//
// IMPORTANT: this module must be require()d FIRST in index.js so applyToEnv() runs
// before any other module captures a process.env value at load time.
const { loadJSON, saveJSON } = require('./database.js');

const FILE = 'runtimeconfig.json';

// The editable keys, grouped by category.
// type: number | text | secret | multiline. live:true = applies without a restart.
const REGISTRY = [
    { cat: 'Цены и заходы', key: 'JOIN_SALE_PRICE', label: 'Цена продажи, $ / 100 заходов', type: 'number', def: '10' },
    { cat: 'Цены и заходы', key: 'MANAGER_PRICE', label: 'Цена для менеджера, $ / 100', type: 'number', def: '9' },
    { cat: 'Цены и заходы', key: 'MANAGER_COMMISSION_RATE', label: 'Маржа менеджера (доля, напр. 0.10)', type: 'number', def: '0.10' },
    { cat: 'Цены и заходы', key: 'MIN_ORDER_JOINS', label: 'Мин. заходов в заказе', type: 'number', def: '1' },

    { cat: 'Балансы / пополнения', key: 'MIN_TOPUP', label: 'Мин. пополнение кошелька, $', type: 'number', def: '5' },
    { cat: 'Балансы / пополнения', key: 'MANAGER_MIN_TOPUP', label: 'Мин. пополнение (менеджер), $', type: 'number', def: '9' },
    { cat: 'Балансы / пополнения', key: 'INVEST_MIN_TOPUP', label: 'Мин. пополнение инвест-счёта, $', type: 'number', def: '5' },

    // Цена выкупа инвайтов больше не задаётся вручную — она автоматически = 10%
    // ниже цены продажи (JOIN_SALE_PRICE), с округлением до десятых.
    { cat: 'Инвестиции', key: 'INVEST_RETURN_RATE', label: 'Доходность инвестора (доля)', type: 'number', def: '0.10' },
    { cat: 'Инвестиции', key: 'INVEST_MIN_INVITES', label: 'Мин. инвайтов в покупке', type: 'number', def: '100' },
    { cat: 'Инвестиции', key: 'INVEST_MIN_DAYS', label: 'Мин. дней продаж в покупке', type: 'number', def: '30' },
    { cat: 'Инвестиции', key: 'INVEST_MAX_DAYS', label: 'Макс. дней продаж в покупке', type: 'number', def: '180' },
    { cat: 'Инвестиции', key: 'INVEST_MIN_DAILY', label: 'Порог продаж/день для списка', type: 'number', def: '10' },
    { cat: 'Инвестиции', key: 'INVEST_REFUND_GRACE_HOURS', label: 'Часы отсрочки возврата инвайтов', type: 'number', def: '24' },

    { cat: 'Селф-боты (резерв)', key: 'USER_TOKEN', label: 'Токены аккаунтов (по одному в строке или через запятую)', type: 'multiline', secret: true, live: true,
        help: 'Резервная проверка заходов через личные аккаунты для серверов без бота. Можно несколько токенов — боты подхватят серверы всех аккаунтов. Каждый токен проверяется у Discord при сохранении: нерабочий добавить нельзя. Невидимо для покупателей. Автоматизация аккаунта нарушает ToS Discord — на свой риск.' },
    { cat: 'Селф-боты (резерв)', key: 'RESERVE_GATEWAY', label: 'Gateway-режим (1 = вкл, 0 = только REST)', type: 'text', live: true,
        help: 'Пусто/1 — держать постоянное соединение аккаунта (надёжная проверка членства + мгновенный клофбэк). 0 — только REST-запросы (легче, но проверка членства может не работать). Применяется сразу по «Сохранить». Выше риск бана в gateway-режиме.' },

    { cat: 'Платежи', key: 'NOWPAYMENTS_API_KEY', label: 'NOWPayments API key', type: 'secret' },
    { cat: 'Платежи', key: 'NOWPAYMENTS_IPN_SECRET', label: 'NOWPayments IPN secret', type: 'secret' },
    { cat: 'Платежи', key: 'NOWPAYMENTS_PAY_CURRENCY', label: 'Монета оплаты по умолчанию (напр. ltc)', type: 'text', def: 'ltc' },
    { cat: 'Платежи', key: 'NOWPAYMENTS_EMAIL', label: 'NOWPayments: email аккаунта (для авто-выплат)', type: 'secret', live: true,
        help: 'Нужен только для АВТО-ВЫПЛАТ партнёрам (payout API требует логин, а не только ключ). У NOWPayments выплаты по умолчанию закрыты 2FA и белым списком адресов — попроси поддержку отключить оба, иначе выплаты будут висеть в WAITING.' },
    { cat: 'Платежи', key: 'NOWPAYMENTS_PASSWORD', label: 'NOWPayments: пароль аккаунта (для авто-выплат)', type: 'secret', live: true },
    { cat: 'Платежи', key: 'NOWPAYMENTS_2FA_SECRET', label: 'NOWPayments: 2FA-секрет (ключ для ручного ввода)', type: 'secret', live: true,
        help: 'TOTP-секрет из настройки 2FA в NOWPayments (строка вида JBSWY3DP…, показывается рядом с QR-кодом как «ключ для ручного ввода»). С ним выплаты подтверждаются автоматически, и 2FA отключать НЕ нужно. Без него батч ждёт ручного подтверждения в дашборде и через час авто-отклоняется (баланс вернётся).' },
    { cat: 'Платежи', key: 'NOWPAYMENTS_PAYOUT_CURRENCY', label: 'Монета авто-выплат партнёрам', type: 'text', def: 'ltc', live: true },
    { cat: 'Платежи', key: 'CRYPTO_PAY_TOKEN', label: 'CryptoBot (Crypto Pay) token', type: 'secret' },
    { cat: 'Платежи', key: 'CRYPTOMUS_MERCHANT', label: 'Cryptomus merchant UUID', type: 'secret' },
    { cat: 'Платежи', key: 'CRYPTOMUS_API_KEY', label: 'Cryptomus API key', type: 'secret' },

    { cat: 'Статус ботов', key: 'BOT_STATUS', label: 'Текст статуса', type: 'text' },
    { cat: 'Статус ботов', key: 'BOT_STATUS_TYPE', label: 'Тип: playing / watching / listening / competing / streaming', type: 'text' },
    { cat: 'Статус ботов', key: 'BOT_PRESENCE', label: 'Присутствие: online / idle / dnd / invisible', type: 'text' },
    { cat: 'Статус ботов', key: 'BOT_STATUS_URL', label: 'URL для streaming-статуса', type: 'text' },

    { cat: 'Каналы уведомлений', key: 'ORDER_NOTIFY_GUILD', label: 'Сервер уведомлений о заказах (ID)', type: 'text', def: '1523103725609156719' },
    { cat: 'Каналы уведомлений', key: 'ORDER_NOTIFY_CHANNEL', label: 'Канал уведомлений о заказах (ID)', type: 'text', def: '1526627488527290419' },
    { cat: 'Каналы уведомлений', key: 'AD_COMPLETE_CHANNEL', label: 'Канал «реклама выполнена» (ID)', type: 'text' },
    { cat: 'Каналы уведомлений', key: 'AD_COMPLETE_PING', label: 'Пинг при выполнении (user ID)', type: 'text' },
    { cat: 'Каналы уведомлений', key: 'FUNDS_LOG_CHANNEL', label: 'Канал лога выплат (ID)', type: 'text' },
    { cat: 'Каналы уведомлений', key: 'ALERT_CHANNEL', label: 'Канал алертов (ID)', type: 'text' },
    { cat: 'Каналы уведомлений', key: 'BACKUP_CHANNEL', label: 'Канал бэкапов (ID)', type: 'text' },

    { cat: 'Лоты', key: 'LOT_GUILD_ID', label: 'Сервер лотов (ID)', type: 'text', def: '1523103725609156719' },
    { cat: 'Лоты', key: 'LOT_CATEGORY_ID', label: 'Категория каналов лотов (ID)', type: 'text', def: '1525954487649439875' },
    { cat: 'Лоты', key: 'LOT_WIN_MS', label: 'Окно без перебивания до победы, мс', type: 'number', def: '900000' },
    { cat: 'Лоты', key: 'LOT_SLOWMODE', label: 'Slowmode в канале лота, сек', type: 'number', def: '10' },

    { cat: 'Прочее', key: 'BOT_INVITE_URL', label: 'Ссылка «добавить бота»', type: 'text' },
    { cat: 'Прочее', key: 'JOIN_CHECK_GUILDS', label: 'Ограничить проверку заходов серверами (ID через запятую)', type: 'text' },
    { cat: 'Прочее', key: 'SPONSOR_SHOW_STALE_MS', label: 'Окно «реклама показывается», мс', type: 'number', def: '1800000' }
];

// Every listed key is read LIVE at use-time now (or re-applied on save — reserve
// tokens, bot presence), so a plain "Сохранить" is enough for all of them. Mark
// any future restart-only key with an explicit live:false above.
for (const r of REGISTRY) if (r.live === undefined) r.live = true;

const BY_KEY = new Map(REGISTRY.map((r) => [r.key, r]));
const KEYS = new Set(REGISTRY.map((r) => r.key));

function load() {
    const r = loadJSON(FILE, {});
    return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}
let overrides = load();

// Snapshot the boot (Railway) env for every editable key BEFORE overlaying
// overrides, so clearing an override live can restore the underlying Railway
// value (or unset it) instead of leaving the last override stuck in process.env.
const bootEnv = {};
for (const k of KEYS) bootEnv[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;

// Apply stored overrides onto process.env. Runs on module load — require this FIRST
// in index.js so modules that read process.env at load time see the overrides.
function applyToEnv() {
    for (const [k, v] of Object.entries(overrides)) {
        if (KEYS.has(k) && v != null && String(v) !== '') process.env[k] = String(v);
    }
}
applyToEnv();

// Live value: override wins, else current env, else ''.
function get(key) {
    if (overrides[key] != null && String(overrides[key]) !== '') return String(overrides[key]);
    return process.env[key] != null ? String(process.env[key]) : '';
}

// Update overrides (known keys only). Empty string clears the override (falls back
// to the Railway env / built-in default). Writes to disk + process.env immediately.
function setMany(obj) {
    overrides = load(); // fresh copy to avoid clobbering a concurrent write
    for (const [k, v] of Object.entries(obj || {})) {
        if (!KEYS.has(k)) continue;
        const val = v == null ? '' : String(v).trim();
        if (val === '') {
            // Clear the override AND revert process.env to the boot (Railway) value
            // — or unset it — so the change is live, not stuck at the last override.
            delete overrides[k];
            if (bootEnv[k] === undefined) delete process.env[k];
            else process.env[k] = bootEnv[k];
        } else { overrides[k] = val; process.env[k] = val; }
    }
    saveJSON(FILE, overrides);
    return overrides;
}

// Admin view: categories → fields with current value. Secret values are never
// returned in the clear — only whether they're set.
function adminView() {
    const cats = [];
    const byCat = new Map();
    for (const r of REGISTRY) {
        if (!byCat.has(r.cat)) { const fields = []; byCat.set(r.cat, fields); cats.push({ cat: r.cat, fields }); }
        const cur = get(r.key);
        const field = {
            key: r.key, label: r.label, type: r.type, help: r.help || '', def: r.def || '',
            overridden: overrides[r.key] != null && String(overrides[r.key]) !== '', live: Boolean(r.live)
        };
        if (r.secret) { field.secret = true; field.set = cur !== ''; field.value = ''; }
        else { field.value = cur; }
        byCat.get(r.cat).push(field);
    }
    return cats;
}

module.exports = { REGISTRY, KEYS, BY_KEY, applyToEnv, get, setMany, adminView, reload: () => { overrides = load(); } };

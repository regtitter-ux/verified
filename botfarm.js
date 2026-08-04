// "Bot breeders" (ботоводы) — manage the reserve USER-TOKEN accounts as friendly
// per-account CARDS: who added each, live status (active / unavailable), and the
// join stats it verified. The token SECRETS stay in the existing USER_TOKEN config
// blob (the reserve plumbing in usertoken.js / reservegw.js is unchanged); this
// module keeps a metadata sidecar (usertokenmeta.json — NO secrets) keyed by the
// account id, runs a health monitor, and posts ops notifications.
const config = require('./config.js');
const { loadJSON, saveJSON } = require('./database.js');
const usertoken = require('./usertoken.js');
const poster = require('./poster.js');

// Ops channel + role for the "need a self-bot / need to join a server" pings.
const NOTIFY_CHANNEL = () => (process.env.BOTFARM_NOTIFY_CHANNEL || '1534127050263367691').trim();
const NO_BOT_ROLE = () => (process.env.BOTFARM_NO_BOT_ROLE || '1534127262641946624').trim();

function parseTokens(raw) { return String(raw || '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean); }
function currentTokens() { return parseTokens(config.get('USER_TOKEN')); }

function loadMeta() { const m = loadJSON('usertokenmeta.json', {}); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; }
function saveMeta(m) { saveJSON('usertokenmeta.json', m); }

// Joins this reserve account verified: joined = every credited join it checked,
// stayed = those still standing (not clawed back on leave).
function statsFor(id) {
    const links = loadJSON('joinlinks.json', []);
    let joined = 0, stayed = 0;
    for (const r of (Array.isArray(links) ? links : [])) {
        if (!r || String(r.reserveBotId || '') !== String(id)) continue;
        joined++;
        if (r.status === 'joined' || r.status === 'settled') stayed++;
    }
    return { joined, stayed };
}

// Card view for the UI — one entry per configured token, NEVER exposing the token.
function publicList() {
    const meta = loadMeta();
    return currentTokens().map((tk) => {
        const id = usertoken.idFromToken(tk);
        if (!id) return null;
        const m = meta[id] || {};
        return {
            id,
            username: m.username || null,
            addedBy: m.addedBy || null,
            addedAt: m.addedAt || 0,
            status: m.status === 'unavailable' ? 'unavailable' : 'active',
            statusSince: m.statusSince || 0,
            ...statsFor(id)
        };
    }).filter(Boolean);
}

// Add a token as a new card: validated against Discord first (a dead token can't
// be added), then appended to the USER_TOKEN blob + a metadata record written.
async function addToken(clients, raw, addedBy) {
    const tk = parseTokens(raw)[0];
    if (!tk) return { ok: false, error: 'Пустой токен' };
    const chk = await usertoken.validateTokens(tk).catch(() => null);
    if (!chk) return { ok: false, error: 'Не удалось проверить токен — попробуй ещё раз' };
    if (chk.bad.length) return { ok: false, error: `Токен не принят: ${chk.bad[0].reason || 'невалиден'}` };
    const info = chk.ok[0];
    const id = info.id;
    const existing = currentTokens();
    if (existing.some((t) => usertoken.idFromToken(t) === id)) return { ok: false, error: 'Этот аккаунт уже добавлен' };
    config.setMany({ USER_TOKEN: existing.concat([tk]).join('\n') });
    const meta = loadMeta();
    meta[id] = { addedBy: String(addedBy || ''), addedAt: Date.now(), username: info.username || null, status: 'active', statusSince: Date.now() };
    saveMeta(meta);
    applyLive();
    return { ok: true, id, username: info.username || null };
}

// Remove a card by account id: drop its token from the blob + its metadata.
function removeToken(id) {
    const key = String(id);
    const existing = currentTokens();
    const next = existing.filter((t) => usertoken.idFromToken(t) !== key);
    if (next.length === existing.length) return { ok: false, error: 'Карточка не найдена' };
    config.setMany({ USER_TOKEN: next.join('\n') });
    const meta = loadMeta(); delete meta[key]; saveMeta(meta);
    applyLive();
    return { ok: true };
}

// Reserve changes apply without a restart: drop the coverage cache + reconnect
// the gateway to the new token set (mirrors the admin config-save path).
function applyLive() {
    try { usertoken.invalidate(); } catch { /* ignore */ }
    try { require('./reservegw.js').sync(); } catch (e) { console.error('[BOTFARM] reservegw sync failed:', e && e.message); }
}

// ---------- Health monitor ----------
// Probe each token; on a real active→unavailable transition (dead token / logged-
// out / banned account — 401), flag it and ping whoever added it. Transient
// failures (null) never flip the status.
async function checkHealth(clients) {
    const tokens = currentTokens();
    if (!tokens.length) return;
    const meta = loadMeta();
    let changed = false;
    for (const tk of tokens) {
        const id = usertoken.idFromToken(tk);
        if (!id) continue;
        const alive = await usertoken.pingToken(tk).catch(() => null);
        if (alive === null) continue;
        if (!meta[id]) meta[id] = { addedAt: Date.now(), status: 'active', statusSince: Date.now() };
        const prev = meta[id].status === 'unavailable' ? 'unavailable' : 'active';
        const next = alive ? 'active' : 'unavailable';
        if (next !== prev) {
            meta[id].status = next; meta[id].statusSince = Date.now(); changed = true;
            if (next === 'unavailable') notifyBotLost(clients, id, meta[id]).catch(() => null);
            else console.log(`[BOTFARM] user-bot ${id} back online`);
        }
    }
    if (changed) saveMeta(meta);
}
function startHealthMonitor(clients) {
    const every = Number(process.env.BOTFARM_HEALTH_MS) || 5 * 60 * 1000;
    setInterval(() => checkHealth(clients).catch((e) => console.error('[BOTFARM] health error:', e && e.message)), every);
    setTimeout(() => checkHealth(clients).catch(() => null), 60 * 1000);
    console.log(`[BOTFARM] user-bot health monitor every ${Math.round(every / 60000)}m`);
}

// ---------- Notifications ----------
async function notifyBotLost(clients, id, m) {
    const ch = await poster.posterChannel(clients, NOTIFY_CHANNEL()).catch(() => null);
    if (!ch || typeof ch.send !== 'function') { console.error(`[BOTFARM] user-bot ${id} lost but notify channel unreachable`); return; }
    const ping = (m && m.addedBy) ? `<@${m.addedBy}> ` : '';
    await ch.send({
        content: `${ping}connection with the user bot (${id}) has been lost\nPlease connect a new token as soon as possible`,
        allowedMentions: { users: (m && m.addedBy) ? [m.addedBy] : [] }
    }).catch((e) => console.error('[BOTFARM] notifyBotLost send failed:', e && e.message));
    console.log(`[BOTFARM] user-bot ${id} unavailable — notified ${m && m.addedBy ? m.addedBy : '(no owner)'}`);
}

// A live order whose sponsor server has NO coverage (no fleet bot AND no reserve
// account) — someone must bring a user-bot in. Includes the order's invite link.
async function notifyNoBotOrder(clients, campaign) {
    const ch = await poster.posterChannel(clients, NOTIFY_CHANNEL()).catch(() => null);
    if (!ch || typeof ch.send !== 'function') return;
    const role = NO_BOT_ROLE();
    const ping = role ? `<@&${role}> ` : '';
    const link = (campaign && campaign.invite) ? `\n${campaign.invite}` : '';
    await ch.send({
        content: `${ping}An order has appeared for which there are no bots on the server!\nHurry and access the server from any user bot to launch the ad${link}`,
        allowedMentions: { roles: role ? [role] : [] }
    }).catch((e) => console.error('[BOTFARM] notifyNoBotOrder send failed:', e && e.message));
    console.log(`[BOTFARM] no-bot order notified — sponsor ${campaign && campaign.sponsorGuildId}`);
}

module.exports = {
    publicList, addToken, removeToken, statsFor,
    startHealthMonitor, checkHealth, notifyBotLost, notifyNoBotOrder,
};

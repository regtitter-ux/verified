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
const ledger = require('./ledger.js');
const { round2 } = require('./round.js');

// Reward for the token OWNER (whoever added the reserve account): $0.01 for every
// 10 invites VERIFIED THROUGH their bot(s). Entries only — a leave is checked but
// pays nothing (not surfaced on the site). Credited to their normal payout balance.
const PAY_PER_10 = () => { const v = Number(process.env.BOTFARM_PAY_PER_10); return Number.isFinite(v) && v >= 0 ? v : 0.01; };

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

// ---------- Owner earnings (reserve verification reward) ----------
// Count VERIFIED ENTRIES per token owner: every credited join stamped with a
// reserveBotId whose account maps (via usertokenmeta.addedBy) to an owner. Leaves
// don't reduce it — the entry was still verified. joinlinks grow monotonically
// (leaves flip status, never delete), so this count only rises.
function ownerJoinCounts() {
    const links = loadJSON('joinlinks.json', []);
    const meta = loadMeta();
    const counts = {};
    for (const r of (Array.isArray(links) ? links : [])) {
        if (!r || !r.reserveBotId) continue;
        const owner = meta[String(r.reserveBotId)] && meta[String(r.reserveBotId)].addedBy;
        if (!owner) continue;                 // token not owned by a known account → nobody to pay
        counts[String(owner)] = (counts[String(owner)] || 0) + 1;
    }
    return counts;
}

// The owner's earned-to-date + how many entries they've verified.
function earningsFor(ownerId) {
    const led = loadJSON('reserveearnings.json', {});
    const e = led[String(ownerId)] || {};
    const paidCents = Number(e.paidCents) || 0;   // one cent = one paid group of 10
    return { earnedTotal: round2(paidCents * PAY_PER_10()), verifiedJoins: Number(e.joins) || 0 };
}

// Idempotent accrual: recompute owed groups (floor(entries/10)) per owner and
// credit only the NEW ones. `paidCents` is monotonic so pruning/edits never claw
// back. Safe to run on a timer.
function accrueReserveEarnings() {
    const rate = PAY_PER_10();
    const counts = ownerJoinCounts();
    const led = loadJSON('reserveearnings.json', {});
    let dirty = false;
    for (const [owner, joins] of Object.entries(counts)) {
        const owed = Math.floor(joins / 10);                 // completed groups of 10 → cents owed
        const prev = led[owner] || { paidCents: 0, joins: 0 };
        const paid = Number(prev.paidCents) || 0;
        if (owed > paid && rate > 0) {
            const amount = round2((owed - paid) * rate);
            if (amount > 0) ledger.credit(owner, amount, { reason: 'reserve_verify', srcId: `reserve:${owner}:${owed}` });
        }
        const nextPaid = Math.max(paid, owed);
        if (prev.joins !== joins || prev.paidCents !== nextPaid) { led[owner] = { joins, paidCents: nextPaid }; dirty = true; }
    }
    if (dirty) saveJSON('reserveearnings.json', led);
    return led;
}

function startEarningsAccrual() {
    const every = Number(process.env.BOTFARM_ACCRUE_MS) || 5 * 60 * 1000;
    setInterval(() => { try { accrueReserveEarnings(); } catch (e) { console.error('[BOTFARM] accrue error:', e && e.message); } }, every);
    setTimeout(() => { try { accrueReserveEarnings(); } catch { /* ignore */ } }, 45 * 1000);
    console.log(`[BOTFARM] reserve-verify earnings accrual every ${Math.round(every / 60000)}m`);
}

// Page summary for a viewer: their payout balance + reserve earnings, plus the
// OVERALL verified traffic across all configured bots.
function summaryFor(ownerId) {
    let totalJoined = 0, totalStayed = 0;
    for (const b of publicList()) { totalJoined += b.joined || 0; totalStayed += b.stayed || 0; }
    const bal = Number(loadJSON('settings.json', {})[String(ownerId)] && loadJSON('settings.json', {})[String(ownerId)].balance) || 0;
    const e = earningsFor(ownerId);
    return { balance: round2(bal), earnedTotal: e.earnedTotal, verifiedJoins: e.verifiedJoins, totalJoined, totalStayed, payPer10: PAY_PER_10() };
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
// Returns { channelId, msgId } of the posted ping (so it can be deleted later when
// coverage returns or the ping is refreshed), or null if it couldn't be sent.
async function notifyNoBotOrder(clients, campaign) {
    // Disabled by request: the repeating "no bots on this order" ping was too noisy.
    // Re-enable by setting BOTFARM_NO_BOT_NOTIFY=on. (The bot-lost alert stays on.)
    if ((process.env.BOTFARM_NO_BOT_NOTIFY || 'off').toLowerCase() !== 'on') return null;
    const chId = NOTIFY_CHANNEL();
    const ch = await poster.posterChannel(clients, chId).catch(() => null);
    if (!ch || typeof ch.send !== 'function') return null;
    const role = NO_BOT_ROLE();
    const ping = role ? `<@&${role}> ` : '';
    const link = (campaign && campaign.invite) ? `\n${campaign.invite}` : '';
    const msg = await ch.send({
        content: `${ping}An order has appeared for which there are no bots on the server!\nHurry and access the server from any user bot to launch the ad${link}`,
        allowedMentions: { roles: role ? [role] : [] }
    }).catch((e) => { console.error('[BOTFARM] notifyNoBotOrder send failed:', e && e.message); return null; });
    if (!msg) return null;
    console.log(`[BOTFARM] no-bot order notified — sponsor ${campaign && campaign.sponsorGuildId} (msg ${msg.id})`);
    return { channelId: chId, msgId: msg.id };
}

// Delete a previously-posted "no bots" ping (coverage returned, or we're replacing
// it with a fresh one). Best-effort — a missing/already-deleted message is fine.
async function deleteNoBotNotif(clients, channelId, msgId) {
    if (!msgId) return;
    const ch = await poster.posterChannel(clients, channelId || NOTIFY_CHANNEL()).catch(() => null);
    if (!ch || !ch.messages || typeof ch.messages.fetch !== 'function') return;
    const m = await ch.messages.fetch(String(msgId)).catch(() => null);
    if (m) await m.delete().catch(() => null);
}

module.exports = {
    publicList, addToken, removeToken, statsFor, summaryFor, earningsFor,
    accrueReserveEarnings, startEarningsAccrual,
    startHealthMonitor, checkHealth, notifyBotLost, notifyNoBotOrder, deleteNoBotNotif,
};

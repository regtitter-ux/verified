// Verification-card registry + remote management ("Экстренно" admin tab).
//
// Every /verify card is tracked here so the owner can list them, "shake" a
// broken one (rebuild the embed + button in place), change its owner/role,
// delete it, or re-publish it — all without touching who created it unless
// explicitly asked. Only the bot instance that AUTHORED a message can edit or
// delete it, so each op locates that instance in the fleet.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AuditLogEvent, PermissionsBitField } = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');

function loadCards() { const r = loadJSON('cards.json', []); return Array.isArray(r) ? r : []; }
function saveCards(list) { saveJSON('cards.json', Array.isArray(list) ? list : []); return loadCards(); }

// Insert or update a card record keyed by messageId.
function addCard(rec) {
    if (!rec || !rec.messageId) return null;
    const list = loadCards();
    const now = Date.now();
    const i = list.findIndex((c) => c.messageId === rec.messageId);
    if (i >= 0) { list[i] = { ...list[i], ...rec, updatedAt: now }; saveCards(list); return list[i]; }
    const merged = { createdAt: now, updatedAt: now, ...rec };
    list.push(merged); saveCards(list); return merged;
}
function removeCard(messageId) { saveCards(loadCards().filter((c) => c.messageId !== messageId)); }
function getCard(messageId) { return loadCards().find((c) => c.messageId === messageId) || null; }

// Mark a card deleted (kept in the registry so its stats survive) rather than
// dropping it. deletedBy = who removed it, when known.
function markDeleted(messageId, deletedBy = null) {
    const list = loadCards();
    const i = list.findIndex((c) => c.messageId === messageId);
    if (i < 0) return null;
    if (!list[i].deletedAt) {
        list[i].deletedAt = Date.now();
        list[i].deletedBy = deletedBy || list[i].deletedBy || null;
        saveCards(list);
    } else if (deletedBy && !list[i].deletedBy) {
        list[i].deletedBy = deletedBy; saveCards(list);
    }
    return list[i];
}

const DEFAULT_DESCRIPTION = 'To gain full access to the server, you must complete verification\nClick the button';

// The canonical verification-card message payload. `description` overrides the
// embed body per card (empty → the default text).
function buildCard(guild, creatorId, roleId, description) {
    const icon = guild?.iconURL?.({ dynamic: true }) || null;
    const embed = new EmbedBuilder()
        .setAuthor({ name: guild?.name || 'Server', iconURL: icon })
        .setTitle('Get verified!')
        .setDescription((description && String(description).trim()) ? String(description) : DEFAULT_DESCRIPTION)
        .setThumbnail(icon)
        .setColor('#5865F2')
        .setFooter({ text: `Created by: ${creatorId}` });
    const btn = new ButtonBuilder()
        .setCustomId(roleId ? `start_verif_guild:${roleId}` : 'start_verif_guild')
        .setLabel('Start Verification').setEmoji('🔐').setStyle(ButtonStyle.Primary);
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
}

// Parse a message link / "channelId messageId" / "channelId-messageId".
function parseMsgRef(input) {
    const s = String(input || '').trim();
    let m = s.match(/channels\/\d+\/(\d+)\/(\d+)/);
    if (m) return { channelId: m[1], messageId: m[2] };
    m = s.match(/^(\d{17,20})\s*[-/\s]\s*(\d{17,20})$/);
    if (m) return { channelId: m[1], messageId: m[2] };
    return null;
}

// Recover a card's owner (footer), role (button customId) and embed body.
function extractCard(msg) {
    const footer = msg?.embeds?.[0]?.footer?.text || '';
    const creatorId = (footer.match(/Created by:\s*(\d{17,20})/) || [])[1] || null;
    const description = msg?.embeds?.[0]?.description || null;
    let roleId = null;
    for (const row of msg?.components || []) {
        for (const comp of row.components || []) {
            const cid = comp.customId || comp.custom_id || '';
            if (cid.startsWith('start_verif_guild')) { roleId = cid.includes(':') ? cid.split(':')[1] : null; break; }
        }
        if (roleId) break;
    }
    return { creatorId, roleId, description };
}

// Locate the message and the fleet client that AUTHORED it (the only one that
// can edit/delete). client is null when the message exists but no fleet bot
// wrote it. Returns null if the message can't be found at all.
async function locate(clients, channelId, messageId) {
    let seen = null;
    for (const c of Array.isArray(clients) ? clients : []) {
        const channel = await c.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (!msg) continue;
        seen = { client: null, channel, msg };
        if (msg.author?.id === c.user?.id) return { client: c, channel, msg };
    }
    return seen;
}

// Register (and shake) an existing card by reference — for cards created before
// tracking, or that fell out of the registry.
async function register(clients, ref) {
    const r = parseMsgRef(ref);
    if (!r) return { ok: false, error: 'bad-ref' };
    const loc = await locate(clients, r.channelId, r.messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const { creatorId, roleId, description } = extractCard(loc.msg);
    if (!creatorId) return { ok: false, error: 'not-a-card' };
    const desc = (description && description !== DEFAULT_DESCRIPTION) ? description : null;
    await loc.msg.edit({ content: loc.msg.content || '', ...buildCard(loc.channel.guild, creatorId, roleId, desc) }).catch(() => null);
    const rec = addCard({ messageId: r.messageId, channelId: r.channelId, guildId: loc.channel.guild?.id || null, creatorId, roleId, description: desc, botId: loc.client.user.id });
    return { ok: true, card: rec };
}

// "Shake" a tracked card — rebuild it in place, keeping owner + role.
async function fix(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const ex = extractCard(loc.msg);
    const creatorId = card.creatorId || ex.creatorId;
    const roleId = card.roleId ?? ex.roleId;
    const description = card.description ?? ((ex.description && ex.description !== DEFAULT_DESCRIPTION) ? ex.description : null);
    if (!creatorId) return { ok: false, error: 'no-owner' };
    await loc.msg.edit({ content: loc.msg.content || '', ...buildCard(loc.channel.guild, creatorId, roleId, description) });
    addCard({ ...card, creatorId, roleId, description });
    return { ok: true };
}

// Change a card's owner and/or granted role (edits the live message).
async function edit(clients, messageId, patch = {}) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const creatorId = patch.creatorId || card.creatorId;
    const roleId = patch.roleId !== undefined ? (patch.roleId || null) : card.roleId;
    let description = card.description ?? null;
    if (patch.description !== undefined) {
        const d = String(patch.description).trim();
        description = d ? patch.description : null; // empty → default text
    }
    if (!creatorId) return { ok: false, error: 'no-owner' };
    await loc.msg.edit({ content: loc.msg.content || '', ...buildCard(loc.channel.guild, creatorId, roleId, description) });
    const rec = addCard({ ...card, creatorId, roleId, description });
    return { ok: true, card: rec };
}

// Delete the card's message and move it to the "deleted" list (stats kept).
async function remove(clients, messageId, deletedBy = null) {
    const card = getCard(messageId);
    if (!card) return { ok: true, deleted: false };
    markDeleted(messageId, deletedBy); // set before the delete so the messageDelete event is a no-op
    const loc = await locate(clients, card.channelId, messageId);
    if (loc?.client) await loc.msg.delete().catch(() => null);
    return { ok: true, deleted: Boolean(loc?.client) };
}

// Re-publish: post a fresh card in the same channel, then delete the old one —
// keeping owner + role. Used when an in-place edit isn't enough.
async function republish(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc || !loc.client) return { ok: false, error: 'not-found' };
    const ex = extractCard(loc.msg);
    const creatorId = card.creatorId || ex.creatorId;
    const roleId = card.roleId ?? ex.roleId;
    const description = card.description ?? ((ex.description && ex.description !== DEFAULT_DESCRIPTION) ? ex.description : null);
    if (!creatorId) return { ok: false, error: 'no-owner' };
    const sent = await loc.channel.send(buildCard(loc.channel.guild, creatorId, roleId, description)).catch(() => null);
    if (!sent) return { ok: false, error: 'send-failed' };
    await loc.msg.delete().catch(() => null);
    removeCard(messageId);
    const rec = addCard({ messageId: sent.id, channelId: sent.channelId, guildId: loc.channel.guild?.id || null, creatorId, roleId, description, botId: loc.client.user.id, createdAt: card.createdAt });
    return { ok: true, card: rec };
}

// Can a deleted card be re-published in its original channel? Cache-based (no
// API calls) so it's cheap to compute for the whole deleted list. Returns
// { can, reason, botId }. reason ∈ 'no-owner' | 'no-bot' (kicked) |
// 'no-channel' (deleted) | 'no-perms' (can't post there).
function restoreInfo(clients, card) {
    if (!card || !card.creatorId) return { can: false, reason: 'no-owner' };
    if (!card.channelId || !card.guildId) return { can: false, reason: 'no-channel' };
    const arr = Array.isArray(clients) ? clients : [];
    // Prefer the bot that originally authored the card, then any fleet bot on the guild.
    let candidates = arr.filter((c) => c.guilds?.cache?.has(card.guildId));
    if (card.botId) {
        const own = candidates.find((c) => c.user?.id === card.botId);
        if (own) candidates = [own, ...candidates.filter((c) => c !== own)];
    }
    if (!candidates.length) return { can: false, reason: 'no-bot' };
    let sawChannel = false;
    for (const c of candidates) {
        const guild = c.guilds.cache.get(card.guildId);
        const channel = guild?.channels?.cache?.get(card.channelId);
        if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) continue;
        sawChannel = true;
        const me = guild.members?.me;
        const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
        if (perms && perms.has(PermissionsBitField.Flags.ViewChannel) && perms.has(PermissionsBitField.Flags.SendMessages)) {
            return { can: true, reason: null, botId: c.user.id };
        }
    }
    return { can: false, reason: sawChannel ? 'no-perms' : 'no-channel' };
}

// Re-publish a previously deleted card in its ORIGINAL channel, keeping owner +
// role + description. The record moves to the new message id and its deleted
// markers are cleared; funnel stats (keyed by guild/role/creator) carry over.
async function restore(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    if (!card.deletedAt) return { ok: false, error: 'not-deleted' };
    const info = restoreInfo(clients, card);
    if (!info.can) return { ok: false, error: info.reason };
    const arr = Array.isArray(clients) ? clients : [];
    const client = arr.find((c) => c.user?.id === info.botId) || arr.find((c) => c.guilds?.cache?.has(card.guildId));
    if (!client) return { ok: false, error: 'no-bot' };
    const guild = client.guilds.cache.get(card.guildId);
    const channel = await client.channels.fetch(card.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return { ok: false, error: 'no-channel' };
    const sent = await channel.send(buildCard(guild, card.creatorId, card.roleId, card.description || null)).catch(() => null);
    if (!sent) return { ok: false, error: 'send-failed' };
    removeCard(messageId); // fresh record (no deletedAt) under the new message id
    const rec = addCard({
        messageId: sent.id, channelId: sent.channelId, guildId: card.guildId,
        creatorId: card.creatorId, roleId: card.roleId, description: card.description || null,
        botId: client.user.id, createdAt: card.createdAt || Date.now()
    });
    return { ok: true, card: rec };
}

// ---- First-click tracking (funnel metric #1) ----
// A card is identified for stats by (guild, role, creator) — the same tuple a
// verified.json entry / joinlinks record carries, so all three funnel stages
// line up. First clicks aren't otherwise persisted, so we log them here. The
// first-click handler in index.js only fires once per ~5-minute session per
// user (pendingVerification gate), so this already counts "sessions started",
// not raw re-clicks. Events older than a week are pruned on write.
const CLICK_TTL = 7 * 86400000;
function clickKey(guildId, roleId, creatorId) { return `${guildId || ''}:${roleId || ''}:${creatorId || ''}`; }
function trackClick(guildId, roleId, creatorId, userId) {
    if (!guildId || !creatorId) return;
    const now = Date.now();
    const list = loadJSON('cardclicks.json', []);
    const arr = (Array.isArray(list) ? list : []).filter((e) => e.t > now - CLICK_TTL);
    arr.push({ k: clickKey(guildId, roleId, creatorId), u: String(userId || ''), t: now });
    saveJSON('cardclicks.json', arr);
}
// Raw first-click events [{ u, t }] for a card — used to measure the delay
// from the first click to a successful join-check verification.
function clicksForKey(guildId, roleId, creatorId) {
    const k = clickKey(guildId, roleId, creatorId);
    const list = loadJSON('cardclicks.json', []);
    return (Array.isArray(list) ? list : []).filter((e) => e.k === k).map((e) => ({ u: e.u, t: e.t }));
}

// Unique users who first-clicked this card in the last hour / day / week.
function clickWindows(guildId, roleId, creatorId, now = Date.now()) {
    const k = clickKey(guildId, roleId, creatorId);
    const list = loadJSON('cardclicks.json', []);
    const h = new Set(), d = new Set(), w = new Set();
    for (const e of Array.isArray(list) ? list : []) {
        if (e.k !== k) continue;
        if (e.t > now - 3600000) h.add(e.u);
        if (e.t > now - 86400000) d.add(e.u);
        if (e.t > now - 604800000) w.add(e.u);
    }
    return { hour: h.size, day: d.size, week: w.size };
}

// ---- Scan existing cards ----
// Walk every readable text channel across the fleet, find our own
// verification-card messages (our button + a "Created by" footer) and add any
// that aren't tracked yet. Runs in the background (Discord rate limits make it
// slow) with a live progress state the panel can poll.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let scanState = { running: false, found: 0, scannedChannels: 0, startedAt: 0, finishedAt: 0 };
const MAX_SCAN_CHANNELS = 5000; // runaway guard

function isCardMessage(msg, botId) {
    if (msg.author?.id !== botId) return false;
    for (const row of msg.components || []) {
        for (const comp of row.components || []) {
            if (String(comp.customId || comp.custom_id || '').startsWith('start_verif_guild')) return true;
        }
    }
    return false;
}

function scanAll(clients) {
    if (scanState.running) return scanState;
    scanState = { running: true, found: 0, scannedChannels: 0, startedAt: Date.now(), finishedAt: 0 };
    (async () => {
        try {
            const existing = new Set(loadCards().map((c) => c.messageId));
            for (const c of Array.isArray(clients) ? clients : []) {
                const botId = c.user?.id;
                if (!botId) continue;
                for (const guild of c.guilds.cache.values()) {
                    for (const ch of guild.channels.cache.values()) {
                        if (scanState.scannedChannels >= MAX_SCAN_CHANNELS) return;
                        if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased() || !ch.viewable) continue;
                        const msgs = await ch.messages.fetch({ limit: 50 }).catch(() => null);
                        scanState.scannedChannels++;
                        if (msgs) {
                            for (const msg of msgs.values()) {
                                if (!isCardMessage(msg, botId) || existing.has(msg.id)) continue;
                                const { creatorId, roleId } = extractCard(msg);
                                if (!creatorId) continue;
                                addCard({ messageId: msg.id, channelId: ch.id, guildId: guild.id, creatorId, roleId, botId });
                                existing.add(msg.id);
                                scanState.found++;
                            }
                        }
                        await sleep(250); // gentle on rate limits
                    }
                }
            }
        } catch (e) { console.error('[CARDS] scan error:', e.message); }
        finally { scanState.running = false; scanState.finishedAt = Date.now(); }
    })();
    return scanState;
}
function getScanState() { return scanState; }

// ---- Deletion detection ----
// Definitively decide whether a card's message still exists. Only a real
// "Unknown Message/Channel" (10008/10003) counts as gone — transient errors
// stay 'unknown' so we never false-mark a card as deleted.
async function checkExists(clients, card) {
    for (const c of Array.isArray(clients) ? clients : []) {
        let channel;
        try { channel = await c.channels.fetch(card.channelId); }
        catch (e) { if (e?.code === 10003) return 'gone'; channel = null; }
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        try { const msg = await channel.messages.fetch(card.messageId); if (msg) return 'exists'; }
        catch (e) { if (e?.code === 10008) return 'gone'; }
    }
    return 'unknown';
}

// Periodic sweep: mark any active card whose message is gone as deleted.
let sweepRunning = false;
async function sweepDeleted(clients) {
    if (sweepRunning) return 0;
    sweepRunning = true;
    let marked = 0;
    try {
        for (const card of loadCards()) {
            if (card.deletedAt) continue;
            const state = await checkExists(clients, card).catch(() => 'unknown');
            if (state === 'gone') { markDeleted(card.messageId, null); marked++; }
            await sleep(300);
        }
    } catch (e) { console.error('[CARDS] sweep error:', e.message); }
    finally { sweepRunning = false; }
    return marked;
}
function startCardSweep(clients) {
    const every = Number(process.env.CARD_SWEEP_MS) || 10 * 60 * 1000;
    const tick = () => sweepDeleted(clients).catch(() => null);
    setInterval(tick, every);
    setTimeout(tick, 90 * 1000); // first pass shortly after startup
    console.log(`[CARDS] deletion sweep every ${Math.round(every / 60000)}m`);
}

// Realtime: fired from Events.MessageDelete on any bot with the GuildMessages
// intent. If the deleted message is a tracked active card, mark it deleted and
// try to learn who removed it from the audit log (needs View Audit Log).
async function handleMessageDelete(clients, message) {
    const id = message?.id;
    if (!id) return;
    const card = getCard(id);
    if (!card || card.deletedAt) return;
    let deletedBy = null;
    try {
        const guild = message.guild;
        if (guild?.fetchAuditLogs) {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 6 }).catch(() => null);
            const now = Date.now();
            const entry = logs?.entries?.find((e) =>
                e?.target?.id === card.botId &&
                (!e.extra?.channel || e.extra.channel.id === card.channelId) &&
                (now - (e.createdTimestamp || 0)) < 20000);
            if (entry?.executor?.id) deletedBy = entry.executor.id;
        }
    } catch { /* no audit access → deleter stays unknown */ }
    markDeleted(id, deletedBy);
}

module.exports = {
    loadCards, saveCards, addCard, removeCard, getCard,
    buildCard, parseMsgRef, extractCard, locate, DEFAULT_DESCRIPTION,
    register, fix, edit, remove, republish, restore, restoreInfo,
    trackClick, clickWindows, clicksForKey, scanAll, getScanState,
    markDeleted, removeCard, sweepDeleted, startCardSweep, handleMessageDelete
};

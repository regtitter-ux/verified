// Discord side of auction "lots": open a bidding channel, monitor bids posted as
// plain numbers (logic mirrors MinionBot's !bids), and close the channel when the
// top bid stands unchallenged for the win window. Persistent state is in lots.js.
const { PermissionsBitField, ChannelType, GatewayIntentBits } = require('discord.js');
const lots = require('./lots.js');

const GUILD_ID = process.env.LOT_GUILD_ID || '1523103725609156719';
const CATEGORY_ID = process.env.LOT_CATEGORY_ID || '1525954487649439875';
const WIN_MS = Number(process.env.LOT_WIN_MS) || 15 * 60 * 1000; // no outbid for this long → wins
const SLOWMODE = Number(process.env.LOT_SLOWMODE) || 10;         // seconds

const F = PermissionsBitField.Flags;
// @everyone may talk, but not: attach files, use external emoji/stickers, create
// threads (public/private), use activities/commands, create polls, send voice.
const DENY = [
    F.AttachFiles, F.UseExternalEmojis, F.UseExternalStickers,
    F.CreatePublicThreads, F.CreatePrivateThreads,
    F.UseEmbeddedActivities, F.UseApplicationCommands, F.SendPolls, F.SendVoiceMessages
];

const timers = new Map(); // lotId -> setTimeout

// The bot that runs the auction: it must be on the guild AND able to read message
// content (needs the MessageContent intent) so bids posted as plain text can be
// parsed. In this fleet that's the admin bot — it must be on the auction server.
function pickBot(clients) {
    return (Array.isArray(clients) ? clients : []).find((c) => {
        try { return c.guilds?.cache?.has(GUILD_ID) && c.options?.intents?.has?.(GatewayIntentBits.MessageContent); } catch { return false; }
    }) || null;
}
function botFor(clients, lot) {
    return (Array.isArray(clients) ? clients : []).find((c) => c.user?.id === lot.botId)
        || (Array.isArray(clients) ? clients : []).find((c) => c.guilds?.cache?.has(lot.guildId)) || null;
}

// Launch a lot: create the channel, set permissions/slowmode, announce, persist.
async function createLot(clients, opts = {}) {
    const stays = Math.floor(Number(opts.stays) || 0);
    const start = Number(opts.start) || 0;
    const step = Number(opts.step) || 0;
    if (!(stays > 0) || !(start > 0) || !(step > 0)) return { ok: false, error: 'bad-params' };

    const bot = pickBot(clients);
    if (!bot) return { ok: false, error: 'no-bot-on-guild' };
    const guild = bot.guilds.cache.get(GUILD_ID);
    if (!guild) return { ok: false, error: 'no-guild' };

    let channel;
    try {
        channel = await guild.channels.create({
            name: `💹﹒${stays}-stays`,
            type: ChannelType.GuildText,
            parent: CATEGORY_ID || undefined,
            rateLimitPerUser: SLOWMODE,
            permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [F.SendMessages], deny: DENY }]
        });
    } catch (e) { return { ok: false, error: 'channel-failed', detail: e.message }; }

    const lot = lots.create({ stays, start, step, guildId: GUILD_ID, channelId: channel.id, botId: bot.user.id });
    const announce = lots.renderTemplate(stays, start, step).trim();
    if (announce) await channel.send(announce).catch(() => null);
    return { ok: true, lot, channelId: channel.id };
}

// A message in a lot channel — parse a bid (mirrors MinionBot's !bids parsing).
async function handleMessage(clients, message) {
    if (!message || message.author?.bot) return;
    const lot = lots.activeByChannel(message.channelId);
    if (!lot) return;
    if (lot.botId && message.client?.user?.id !== lot.botId) return; // only the owning bot processes

    const clean = String(message.content || '')
        .replace(/<@!?\d+>/g, '').replace(/<@&\d+>/g, '').replace(/<#\d+>/g, '').replace(/<a?:\w+:\d+>/g, '');
    const nums = clean.match(/\d+/g);
    if (!nums) return;
    const bid = parseInt(nums[0], 10);
    if (!Number.isFinite(bid)) return;
    const minReq = lot.highest === 0 ? lot.start : lot.highest + lot.step;

    if (bid >= minReq) {
        if (lot.lastMsgId) {
            const m = await message.channel.messages.fetch(lot.lastMsgId).catch(() => null);
            if (m) await m.delete().catch(() => null);
        }
        const closeTs = Math.floor((Date.now() + WIN_MS) / 1000);
        const newMsg = await message.channel.send(
            `# Высшая ставка: ＄${bid}\n` +
            `**Мин. шаг: ＄${lot.step}** · <@${message.author.id}>\n\n` +
            `-# Авто-закрытие: <t:${closeTs}:R>`
        ).catch(() => null);
        lots.addBid(lot.id, { userId: message.author.id, username: message.author.username || null, amount: bid, ts: Date.now(), messageId: message.id });
        lots.update(lot.id, { lastMsgId: newMsg ? newMsg.id : null });
        scheduleClose(clients, lot.id);
    } else if (message.content.trim() === String(bid)) {
        const err = await message.channel.send(`⚠️ <@${message.author.id}>, ставка слишком мала! Минимум: **＄${minReq}**`).catch(() => null);
        if (err) setTimeout(() => err.delete().catch(() => null), 5000);
    }
}

function scheduleClose(clients, lotId, ms = WIN_MS) {
    if (timers.has(lotId)) clearTimeout(timers.get(lotId));
    timers.set(lotId, setTimeout(() => closeLot(clients, lotId).catch((e) => console.error('[LOTS] close:', e.message)), ms));
}

// Winner stands: lock the channel and record the result.
async function closeLot(clients, lotId) {
    const lot = lots.byId(lotId);
    if (!lot || lot.status !== 'active') return;
    const bot = botFor(clients, lot);
    const guild = bot?.guilds?.cache?.get(lot.guildId);
    const channel = guild?.channels?.cache?.get(lot.channelId) || (bot ? await bot.channels.fetch(lot.channelId).catch(() => null) : null);
    if (channel && guild) {
        try { await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }); } catch (_) {}
        if (lot.lastMsgId && lot.highest > 0) {
            const m = await channel.messages.fetch(lot.lastMsgId).catch(() => null);
            if (m) await m.edit(`# 🏆 Победа: ＄${lot.highest}\n${lot.highestBidder ? `<@${lot.highestBidder}>` : ''}\n\n-# Ставки закрыты`).catch(() => null);
        } else {
            await channel.send('# Лот закрыт — ставок не было').catch(() => null);
        }
    }
    lots.update(lotId, { status: 'closed', closedAt: Date.now(), winnerId: lot.highestBidder, winnerBid: lot.highest });
    timers.delete(lotId);
}

// On startup, re-arm close timers for active lots (a win-window that elapsed
// during downtime closes immediately; lots with no bid yet just wait).
function rescheduleAll(clients) {
    try {
        for (const lot of lots.activeLots()) {
            if (!lot.lastBidAt) continue;
            const remaining = lot.lastBidAt + WIN_MS - Date.now();
            if (remaining <= 0) closeLot(clients, lot.id).catch(() => null);
            else scheduleClose(clients, lot.id, remaining);
        }
    } catch (e) { console.error('[LOTS] reschedule:', e.message); }
}

module.exports = { createLot, handleMessage, closeLot, rescheduleAll, GUILD_ID, CATEGORY_ID, WIN_MS, SLOWMODE };

// Discord side of auction "lots": open a bidding channel, monitor bids posted as
// plain numbers (logic mirrors MinionBot's !bids), and close the channel when the
// top bid stands unchallenged for the win window. Persistent state is in lots.js.
const { PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const lots = require('./lots.js');

// Custom-id prefixes for the button/modal bidding flow (index.js wires the
// InteractionCreate side). Bidding via a button+modal needs NO privileged intent,
// so ANY bot in the fleet can run a lot — not just the Message-Content admin bot.
const BID_BUTTON = 'lot_bid';
const BID_MODAL = 'lot_bid_modal';
function bidRow(lotId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${BID_BUTTON}:${lotId}`).setLabel('💰 Place a bid').setStyle(ButtonStyle.Success)
    );
}

const guildId = () => process.env.LOT_GUILD_ID || '1523103725609156719';
const categoryId = () => process.env.LOT_CATEGORY_ID || '1525954487649439875';
const winMs = () => Number(process.env.LOT_WIN_MS) || 15 * 60 * 1000; // no outbid for this long → wins
const slowmode = () => Number(process.env.LOT_SLOWMODE) || 10;         // seconds

const F = PermissionsBitField.Flags;
// @everyone may talk, but not: attach files, use external emoji/stickers, create
// threads (public/private), use activities/commands, create polls, send voice.
const DENY = [
    F.AttachFiles, F.UseExternalEmojis, F.UseExternalStickers,
    F.CreatePublicThreads, F.CreatePrivateThreads,
    F.UseEmbeddedActivities, F.UseApplicationCommands, F.SendPolls, F.SendVoiceMessages
];

const timers = new Map(); // lotId -> setTimeout

// The bot that runs the auction: ANY bot in the fleet that's on the auction guild.
// Bidding is done via a button+modal (no Message Content intent needed), so a lot
// no longer depends on the admin bot. Prefer a bot that CAN also read chat (has the
// MessageContent intent) so plain-number chat bids keep working when one's around,
// but fall back to any on-guild bot otherwise.
function pickBot(clients) {
    const list = (Array.isArray(clients) ? clients : []).filter((c) => { try { return c.guilds?.cache?.has(guildId()); } catch { return false; } });
    const { GatewayIntentBits } = require('discord.js');
    return list.find((c) => { try { return c.options?.intents?.has?.(GatewayIntentBits.MessageContent); } catch { return false; } }) || list[0] || null;
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
    const guild = bot.guilds.cache.get(guildId());
    if (!guild) return { ok: false, error: 'no-guild' };

    let channel;
    try {
        channel = await guild.channels.create({
            name: lots.renderChannelName(stays),
            type: ChannelType.GuildText,
            parent: categoryId() || undefined,
            rateLimitPerUser: slowmode(),
            permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [F.SendMessages], deny: DENY }]
        });
    } catch (e) { return { ok: false, error: 'channel-failed', detail: e.message }; }

    const lot = lots.create({ stays, start, step, guildId: guildId(), channelId: channel.id, botId: bot.user.id });
    const announce = lots.renderTemplate(stays, start, step).trim();
    // Always attach the bid button so bidding works no matter which bot runs the
    // lot (chat bids only work on a Message-Content bot; the button always works).
    await channel.send({ content: announce || '# 💹 Lot', components: [bidRow(lot.id)] }).catch(() => null);
    return { ok: true, lot, channelId: channel.id };
}

// The minimum acceptable next bid for a lot.
function minBidFor(lot) { return lot.highest === 0 ? lot.start : lot.highest + lot.step; }

// Apply a validated bid to a lot: post the new "highest bid" message, remove the
// previous one, persist and (re)arm the close timer. Shared by chat bids and the
// button/modal flow. Returns { ok } or { ok:false, tooLow, minReq }.
async function applyBid(clients, lot, channel, bidder, bid) {
    if (!lot || lot.status !== 'active' || !channel) return { ok: false, reason: 'inactive' };
    if (!Number.isFinite(bid)) return { ok: false, reason: 'nan' };
    const minReq = minBidFor(lot);
    if (bid < minReq) return { ok: false, tooLow: true, minReq };

    if (lot.lastMsgId) {
        const m = await channel.messages.fetch(lot.lastMsgId).catch(() => null);
        if (m) await m.delete().catch(() => null);
    }
    const closeTs = Math.floor((Date.now() + winMs()) / 1000);
    const newMsg = await channel.send(
        `# Highest bid: ＄${bid}\n` +
        `**Minimal increase: ＄${lot.step}** · <@${bidder.id}>\n\n` +
        `-# Auto-close: <t:${closeTs}:R>`
    ).catch(() => null);
    lots.addBid(lot.id, { userId: bidder.id, username: bidder.username || null, amount: bid, ts: Date.now(), messageId: newMsg ? newMsg.id : null });
    lots.update(lot.id, { lastMsgId: newMsg ? newMsg.id : null });
    scheduleClose(clients, lot.id);
    return { ok: true };
}

// A button click on a lot announcement → show a modal to enter the bid.
async function openBidModal(interaction) {
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: Row } = require('discord.js');
    const lotId = String(interaction.customId.split(':')[1] || '');
    const lot = lots.byId(lotId);
    if (!lot || lot.status !== 'active') return interaction.reply({ content: '⚠️ This lot is closed.', flags: [64] }).catch(() => null);
    const modal = new ModalBuilder().setCustomId(`${BID_MODAL}:${lotId}`).setTitle('Place a bid');
    const input = new TextInputBuilder().setCustomId('bid').setLabel(`Your bid (min ＄${minBidFor(lot)})`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setPlaceholder(String(minBidFor(lot)));
    modal.addComponents(new Row().addComponents(input));
    return interaction.showModal(modal).catch(() => null);
}

// A modal submit → validate and apply the bid.
async function handleBidModal(clients, interaction) {
    const lotId = String(interaction.customId.split(':')[1] || '');
    const lot = lots.byId(lotId);
    if (!lot || lot.status !== 'active') return interaction.reply({ content: '⚠️ This lot is closed.', flags: [64] }).catch(() => null);
    const raw = String(interaction.fields.getTextInputValue('bid') || '');
    const nums = raw.replace(/[,\s]/g, '').match(/\d+/);
    const bid = nums ? parseInt(nums[0], 10) : NaN;
    if (!Number.isFinite(bid)) return interaction.reply({ content: '⚠️ Enter your bid as a number.', flags: [64] }).catch(() => null);
    const channel = interaction.channel || await interaction.client.channels.fetch(lot.channelId).catch(() => null);
    const r = await applyBid(clients, lot, channel, { id: interaction.user.id, username: interaction.user.username }, bid);
    if (r.ok) return interaction.reply({ content: `✅ Bid placed: **＄${bid}**`, flags: [64] }).catch(() => null);
    if (r.tooLow) return interaction.reply({ content: `⚠️ Bid too low — minimum is **＄${r.minReq}**.`, flags: [64] }).catch(() => null);
    return interaction.reply({ content: '⚠️ Could not place the bid.', flags: [64] }).catch(() => null);
}

// A message in a lot channel — parse a bid (mirrors MinionBot's !bids parsing).
// Only fires on a bot with the Message Content intent (the admin bot); the button
// flow above is the universal path.
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

    const r = await applyBid(clients, lot, message.channel, { id: message.author.id, username: message.author.username }, bid);
    if (r.tooLow && message.content.trim() === String(bid)) {
        const err = await message.channel.send(`⚠️ <@${message.author.id}>, bid is too low! Min: **＄${r.minReq}**`).catch(() => null);
        if (err) setTimeout(() => err.delete().catch(() => null), 5000);
    }
}

function scheduleClose(clients, lotId, ms = winMs()) {
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
            if (m) await m.edit(`# 🏆 Winner: ＄${lot.highest}\n${lot.highestBidder ? `<@${lot.highestBidder}>` : ''}\n\n-# Bids closed`).catch(() => null);
        } else {
            await channel.send('# Lot closed — no bids').catch(() => null);
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
            const remaining = lot.lastBidAt + winMs() - Date.now();
            if (remaining <= 0) closeLot(clients, lot.id).catch(() => null);
            else scheduleClose(clients, lot.id, remaining);
        }
    } catch (e) { console.error('[LOTS] reschedule:', e.message); }
}

module.exports = { createLot, handleMessage, openBidModal, handleBidModal, closeLot, rescheduleAll, BID_BUTTON, BID_MODAL, get GUILD_ID(){return guildId();}, get CATEGORY_ID(){return categoryId();}, get WIN_MS(){return winMs();}, get SLOWMODE(){return slowmode();} };

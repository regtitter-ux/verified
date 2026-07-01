const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');

const WITHDRAW_CHANNEL = '1521877173647184054';
const THRESHOLD = 10;                       // auto-withdraw once balance reaches this
const MANUAL_USER = '833442190427684914';   // only this user may adjust balances manually

const round2 = (n) => +(Number(n) || 0).toFixed(2);

const statusLabel = (status) => (status === 'completed' ? 'Completed' : 'In processing');

const HISTORY_PAGE_SIZE = 10;

// Ephemeral withdrawal-history view: title shows total actually withdrawn (completed).
// Paginated at 10 withdrawals per page with prev/next buttons.
const buildHistoryView = (userId, page = 0) => {
    const settings = loadJSON('settings.json');
    const list = Array.isArray(settings[userId]?.withdrawals) ? settings[userId].withdrawals : [];

    const totalWithdrawn = round2(
        list.filter(w => w.status === 'completed').reduce((sum, w) => sum + (Number(w.amount) || 0), 0)
    );

    const sorted = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pageCount = Math.max(1, Math.ceil(sorted.length / HISTORY_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), pageCount - 1);

    const embed = new EmbedBuilder()
        .setTitle(`Withdrawal history — $${totalWithdrawn.toFixed(2)} withdrawn`)
        .setColor('#5865F2');

    if (sorted.length === 0) {
        embed.setDescription('*No withdrawal requests yet.*');
        return { embeds: [embed], components: [] };
    }

    const slice = sorted.slice(current * HISTORY_PAGE_SIZE, current * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE);
    for (const w of slice) {
        const ts = Math.floor((w.createdAt || 0) / 1000);
        embed.addFields({
            name: `$${round2(w.amount).toFixed(2)} — ${statusLabel(w.status)}`,
            value: ts ? `<t:${ts}:f>` : '​',
            inline: false
        });
    }
    embed.setFooter({ text: `Page ${current + 1}/${pageCount}` });

    const components = [];
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`history_page:${current - 1}`)
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current === 0),
            new ButtonBuilder()
                .setCustomId(`history_page:${current + 1}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current >= pageCount - 1)
        ));
    }

    return { embeds: [embed], components };
};

const asList = (clients) => (Array.isArray(clients) ? clients : [clients]).filter(Boolean);

// Find the (single) bot that can reach the payout channel — the service bot.
async function findPayoutChannel(clients) {
    for (const c of asList(clients)) {
        const ch = c.channels.cache.get(WITHDRAW_CHANNEL) || await c.channels.fetch(WITHDRAW_CHANNEL).catch(() => null);
        if (ch) return ch;
    }
    return null;
}

// If the user's balance reached the threshold, create a withdrawal request and post it
// from the service bot (whichever instance can see the payout channel).
async function maybeAutoWithdraw(clients, userId) {
    const settings = loadJSON('settings.json');
    const s = settings[userId];
    if (!s) return;

    const balance = round2(s.balance);
    if (balance < THRESHOLD) return;

    const amount = balance;
    const requisites = (s.requisites || '').trim();

    s.balance = 0;
    if (!Array.isArray(s.withdrawals)) s.withdrawals = [];
    const withdrawal = {
        id: `${userId}-${Date.now()}`,
        amount,
        requisites,
        status: 'processing',
        createdAt: Date.now()
    };
    s.withdrawals.push(withdrawal);
    saveJSON('settings.json', settings);

    try {
        const channel = await findPayoutChannel(clients);
        if (!channel) return;
        const user = await channel.client.users.fetch(userId).catch(() => null);

        const embed = new EmbedBuilder()
            .setTitle('New withdrawal request')
            .setColor('#FEE75C')
            .addFields(
                { name: 'User', value: `<@${userId}>${user ? ` (${user.tag})` : ''}`, inline: false },
                { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: false },
                { name: 'Payment details', value: requisites || '*Not set*', inline: false },
                { name: 'Status', value: statusLabel('processing'), inline: false }
            )
            .setFooter({ text: `req:${userId}:${withdrawal.id}` })
            .setTimestamp();

        await channel.send({ content: `<@${userId}>`, embeds: [embed] });
    } catch (e) {
        console.error('[ERROR] Failed to post withdrawal request:', e);
    }
}

// Mark a withdrawal as completed. Returns the withdrawal object or null.
function completeWithdrawal(userId, withdrawalId) {
    const settings = loadJSON('settings.json');
    const list = settings[userId]?.withdrawals;
    if (!Array.isArray(list)) return null;

    const w = list.find(x => x.id === withdrawalId);
    if (!w || w.status === 'completed') return null;

    w.status = 'completed';
    w.completedAt = Date.now();
    saveJSON('settings.json', settings);
    return w;
}

// Handle manual balance adjustment: "+10 <userId>" / "-5 <userId>" from MANUAL_USER only.
// Returns true if the message was a manual-balance command (handled), false otherwise.
async function handleManualBalance(message, clients) {
    const m = message.content.trim().match(/^([+-])\s*(\d+(?:[.,]\d+)?)\s+(\d{17,20})$/);
    if (!m) return false;
    if (message.author.id !== MANUAL_USER) return false;

    const sign = m[1] === '-' ? -1 : 1;
    const amount = round2(m[2].replace(',', '.'));
    const targetId = m[3];

    const settings = loadJSON('settings.json');
    if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
    const s = settings[targetId];

    s.balance = Math.max(0, round2((Number(s.balance) || 0) + sign * amount));
    saveJSON('settings.json', settings);

    await message.reply(
        `✅ ${sign > 0 ? 'Added' : 'Removed'} $${amount.toFixed(2)} ${sign > 0 ? 'to' : 'from'} <@${targetId}>. New balance: **$${s.balance.toFixed(2)}**`
    ).catch(() => null);

    if (sign > 0) await maybeAutoWithdraw(clients || message.client, targetId);
    return true;
}

// Send a DM to the money owner from the single bot they actually use (never all at once).
async function dmOwner(clients, ownerId, payload) {
    const settings = loadJSON('settings.json');
    const botId = settings[ownerId]?.botId;
    const list = asList(clients);
    // Prefer the user's own bot, then fall back to any other instance.
    const ordered = [
        ...list.filter(c => c.user?.id === botId),
        ...list.filter(c => c.user?.id !== botId)
    ];
    for (const c of ordered) {
        const target = await c.users.fetch(ownerId).catch(() => null);
        if (!target) continue;
        const ok = await target.send(payload).then(() => true).catch(() => false);
        if (ok) return true; // one bot delivered — stop
    }
    return false;
}

// Complete a withdrawal by replying to its request embed with a photo (no command needed).
// Marks the request completed, attaches the proof photo, and DMs the owner.
// Returns true if the message was handled as a proof, false otherwise.
async function handleDone(message, clients) {
    if (!message.reference?.messageId) return false; // must be a reply

    const photo = message.attachments.find(a => (a.contentType || '').startsWith('image/')) || message.attachments.first();
    if (!photo) return false; // no photo → not a proof

    const reqMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    const footer = reqMsg?.embeds?.[0]?.footer?.text || '';
    const fm = footer.match(/^req:(\d{17,20}):(.+)$/);
    if (!reqMsg || !fm) return false; // replied message isn't a withdrawal request → fall through

    // Only the bot that authored the request processes it (prevents duplicates across bots).
    if (reqMsg.author.id !== message.client.user.id) return true;

    const ownerId = fm[1];
    const withdrawalId = fm[2];

    const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin && message.author.id !== MANUAL_USER) return false; // not staff → ignore

    const w = completeWithdrawal(ownerId, withdrawalId);
    if (!w) {
        await message.reply('ℹ️ This withdrawal is already completed or not found.').catch(() => null);
        return true;
    }

    const fileName = (photo.name || 'proof.png').replace(/\s+/g, '_');
    const amountStr = round2(w.amount).toFixed(2);

    // Edit the request message: completed + attach the photo, and drop any components.
    try {
        const embed = EmbedBuilder.from(reqMsg.embeds[0]).setColor('#57F287').setImage(`attachment://${fileName}`);
        const fields = embed.data.fields || [];
        const statusField = fields.find(f => f.name === 'Status');
        if (statusField) statusField.value = statusLabel('completed');
        embed.setFields(fields);
        await reqMsg.edit({ embeds: [embed], components: [], files: [{ attachment: photo.url, name: fileName }] });
    } catch (e) {
        console.error('[ERROR] Failed to edit withdrawal request:', e);
    }

    // DM the owner from the single bot they use.
    await dmOwner(clients, ownerId, {
        content: `✅ Your withdrawal of **$${amountStr}** has been completed.`,
        files: [{ attachment: photo.url, name: fileName }]
    });

    await message.reply(`✅ Withdrawal of $${amountStr} completed and <@${ownerId}> notified.`).catch(() => null);
    return true;
}

module.exports = {
    WITHDRAW_CHANNEL,
    THRESHOLD,
    MANUAL_USER,
    buildHistoryView,
    maybeAutoWithdraw,
    completeWithdrawal,
    handleManualBalance,
    handleDone,
    statusLabel
};

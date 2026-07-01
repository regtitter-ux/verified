const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');

const WITHDRAW_CHANNEL = '1521877173647184054';
const THRESHOLD = 10;                       // auto-withdraw once balance reaches this
const MANUAL_USER = '833442190427684914';   // only this user may adjust balances manually

const round2 = (n) => +(Number(n) || 0).toFixed(2);

const statusLabel = (status) => (status === 'completed' ? 'Completed' : 'In processing');

// Ephemeral withdrawal-history view: title shows total actually withdrawn (completed)
const buildHistoryView = (userId) => {
    const settings = loadJSON('settings.json');
    const list = Array.isArray(settings[userId]?.withdrawals) ? settings[userId].withdrawals : [];

    const totalWithdrawn = round2(
        list.filter(w => w.status === 'completed').reduce((sum, w) => sum + (Number(w.amount) || 0), 0)
    );

    const embed = new EmbedBuilder()
        .setTitle(`Withdrawal history — $${totalWithdrawn.toFixed(2)} withdrawn`)
        .setColor('#5865F2');

    if (list.length === 0) {
        embed.setDescription('*No withdrawal requests yet.*');
    } else {
        const recent = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 15);
        for (const w of recent) {
            const ts = Math.floor((w.createdAt || 0) / 1000);
            embed.addFields({
                name: `$${round2(w.amount).toFixed(2)} — ${statusLabel(w.status)}`,
                value: ts ? `<t:${ts}:f>` : '​',
                inline: false
            });
        }
    }

    return { embeds: [embed] };
};

// If the user's balance reached the threshold, create a withdrawal request and post it.
async function maybeAutoWithdraw(client, userId) {
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
        const channel = await client.channels.fetch(WITHDRAW_CHANNEL).catch(() => null);
        if (!channel) return;
        const user = await client.users.fetch(userId).catch(() => null);

        const embed = new EmbedBuilder()
            .setTitle('New withdrawal request')
            .setColor('#FEE75C')
            .addFields(
                { name: 'User', value: `<@${userId}>${user ? ` (${user.tag})` : ''}`, inline: false },
                { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: false },
                { name: 'Payment details', value: requisites || '*Not set*', inline: false },
                { name: 'Status', value: statusLabel('processing'), inline: false }
            )
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`payout_complete:${userId}:${withdrawal.id}`)
                .setLabel('Mark as completed')
                .setStyle(ButtonStyle.Success)
        );

        await channel.send({ content: `<@${userId}>`, embeds: [embed], components: [row] });
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
async function handleManualBalance(message) {
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

    if (sign > 0) await maybeAutoWithdraw(message.client, targetId);
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
    statusLabel
};

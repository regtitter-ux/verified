// Money audit log: every verification-driven credit and every clawback debit is
// posted by the admin bot to a dedicated channel, with who was paid, for which
// user, on which server, and in which channel the verification card lives.
const { EmbedBuilder } = require('discord.js');

const LOG_CHANNEL = process.env.FUNDS_LOG_CHANNEL || '1522955113860173854';
const ADMIN_BOT_ID = process.env.ADMIN_BOT_ID || '1514533989434789998';

const fmtMoney = (n) => '$' + (+((Number(n) || 0).toFixed(4))).toString();

// Resolve names across the whole bot network (any instance may sit on the guild).
function guildName(clients, gid) {
    if (!gid) return null;
    for (const c of clients) { const g = c.guilds.cache.get(gid); if (g) return g.name; }
    return null;
}
function channelName(clients, cid) {
    if (!cid) return null;
    for (const c of clients) { const ch = c.channels.cache.get(cid); if (ch?.name) return ch.name; }
    return null;
}

// entry = { type: 'credit'|'debit', creatorId, userId, guildId, channelId, amount, reason, sponsorGuildId }
// sponsorGuildId (clawbacks): the advertised server the member left, i.e. the
// server whose join is being reversed — distinct from guildId (the card server).
async function logFunds(clients, entry) {
    try {
        const bot = clients.find((c) => c.user?.id === ADMIN_BOT_ID);
        if (!bot) return;
        const channel = bot.channels.cache.get(LOG_CHANNEL) || await bot.channels.fetch(LOG_CHANNEL).catch(() => null);
        if (!channel) return;

        const credit = entry.type === 'credit';
        const gName = guildName(clients, entry.guildId);
        const cName = channelName(clients, entry.channelId);

        const fields = [
            { name: 'Recipient', value: `<@${entry.creatorId}> \`${entry.creatorId}\``, inline: false },
            { name: 'Amount', value: `**${credit ? '+' : '−'}${fmtMoney(entry.amount)}**`, inline: true },
            { name: 'Reason', value: entry.reason || '—', inline: true }
        ];
        if (entry.userId) {
            const u = /^\d{17,20}$/.test(String(entry.userId));
            fields.push({ name: 'For user', value: u ? `<@${entry.userId}> \`${entry.userId}\`` : `\`${entry.userId}\``, inline: false });
        }
        if (entry.sponsorGuildId) {
            const spName = guildName(clients, entry.sponsorGuildId);
            fields.push({ name: 'Left server (sponsor)', value: spName ? `${spName} \`${entry.sponsorGuildId}\`` : `\`${entry.sponsorGuildId}\``, inline: true });
        }
        if (entry.guildId) {
            fields.push({ name: credit ? 'Server' : 'Card server', value: gName ? `${gName} \`${entry.guildId}\`` : `\`${entry.guildId}\``, inline: true });
        }
        if (entry.channelId) {
            fields.push({ name: 'Card channel', value: cName ? `#${cName} \`${entry.channelId}\`` : `\`${entry.channelId}\``, inline: true });
        }

        const embed = new EmbedBuilder()
            .setColor(credit ? '#57F287' : '#ED4245')
            .setTitle(credit ? 'Balance credited' : 'Balance debited')
            .addFields(fields)
            .setTimestamp();
        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('[FUNDSLOG]', err.message);
    }
}

module.exports = { logFunds, LOG_CHANNEL };

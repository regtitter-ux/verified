const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config.json');
const { loadJSON, saveJSON } = require('./database.js');
const { handleCommands } = require('./commands.js');

const startBot = (token) => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    const pendingVerification = new Set();

    client.once(Events.ClientReady, (c) => {
        console.log(`[ONLINE] ${c.user.tag}`);
    });

    client.on(Events.GuildMemberAdd, async (member) => {
        try {
            const role = member.guild.roles.cache.find(r => r.name.toLowerCase() === 'unverified');
            if (role?.editable) await member.roles.add(role).catch(() => null);
        } catch (e) {
            console.error('[ERROR] Auto-role failed:', e);
        }
    });

    client.on(Events.GuildMemberRemove, (member) => {
        const data = loadJSON('verified.json', []);
        if (!Array.isArray(data)) return;
        const filtered = data.filter(u => !(u.id === member.id && u.guildId === member.guild.id));
        if (filtered.length !== data.length) saveJSON('verified.json', filtered);
    });

    client.on(Events.MessageCreate, (message) => {
        if (message.author.bot || !message.content.startsWith(config.prefix)) return;
        handleCommands(message, config);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isButton() || interaction.customId !== 'start_verif_guild') return;

        const settings = loadJSON('settings.json');
        const verified = loadJSON('verified.json', []);
        const { user, guild, member, message } = interaction;

        const footerText = message.embeds[0]?.footer?.text || '';
        const creatorId = footerText.replace('Created by: ', '').trim();

        const verifiedRole = guild.roles.cache.find(r => r.name === 'Verified');
        const unverifiedRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'unverified');

        const isInData = verified.some(u => u.id === user.id && u.guildId === guild.id);
        const hasRole = verifiedRole ? member.roles.cache.has(verifiedRole.id) : false;
        const alreadyVerified = verifiedRole ? hasRole : isInData;

        if (alreadyVerified) {
            if (unverifiedRole?.editable && member.roles.cache.has(unverifiedRole.id)) {
                await member.roles.remove(unverifiedRole).catch(() => null);
            }
            return interaction.reply({ content: "✅ You're already verified", flags: [64] }).catch(() => null);
        }

        const pendingKey = `${user.id}_${guild.id}`;

        if (!pendingVerification.has(pendingKey)) {
            const userSettings = settings[creatorId] || { advText: '', serverAds: {} };
            const adv = userSettings.serverAds?.[guild.id] || userSettings.advText;
            const responseText = adv || 'Great, now click again to open access to the server!';

            pendingVerification.add(pendingKey);
            setTimeout(() => pendingVerification.delete(pendingKey), 300000);

            return interaction.reply({ content: responseText, flags: [64] }).catch(() => null);
        }

        await interaction.reply({ content: '✅ Success! Access granted', flags: [64] }).catch(() => null);

        try {
            if (verifiedRole?.editable) await member.roles.add(verifiedRole).catch(() => null);
            if (unverifiedRole?.editable && member.roles.cache.has(unverifiedRole.id)) {
                await member.roles.remove(unverifiedRole).catch(() => null);
            }

            const updated = verified.filter(u => !(u.id === user.id && u.guildId === guild.id));
            updated.push({ id: user.id, guildId: guild.id, creatorId, timestamp: Date.now() });
            saveJSON('verified.json', updated);
            pendingVerification.delete(pendingKey);
        } catch (e) {
            console.error(e);
        }
    });

    client.login(token).catch(err => {
        console.error(`[LOGIN ERROR] ${token.substring(0, 10)}...`, err);
    });
};

if (!Array.isArray(config.tokens) || config.tokens.length === 0) {
    console.error('[CRITICAL] config.json must have a non-empty tokens array');
    process.exit(1);
}

config.tokens.forEach(startBot);

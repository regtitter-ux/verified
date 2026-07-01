const {
    Client, GatewayIntentBits, Events,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');
const { handleCommands } = require('./commands.js');

// Читаем токены из переменных окружения Railway
const config = {
    tokens: process.env.TOKENS ? process.env.TOKENS.split(',') : [],
    ownerId: process.env.OWNER_ID || '743913502997086219',
    prefix: process.env.PREFIX || '!'
};

const startBot = (token) => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    const pendingVerification = new Map();

    // Build the ephemeral balance view (embed + "Edit details" button)
    const buildBalanceView = (userId) => {
        const settings = loadJSON('settings.json');
        const s = settings[userId] || {};
        const balance = Number(s.balance) || 0;
        const requisites = (s.requisites || '').trim();

        const embed = new EmbedBuilder()
            .setTitle('💰 Your balance')
            .setColor('#57F287')
            .addFields(
                { name: 'Balance', value: `**$${balance.toFixed(2)}**`, inline: false },
                { name: 'Payment details', value: requisites || '*Not set*', inline: false }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('edit_details')
                .setLabel('Edit details')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row] };
    };

    // Accrue $0.1 to the message owner for every 10 qualifying verification clicks
    const creditVerifiedClick = (creatorId) => {
        if (!creatorId) return;
        const settings = loadJSON('settings.json');
        if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
        const s = settings[creatorId];

        s.verifiedClicks = (Number(s.verifiedClicks) || 0) + 1;
        if (s.verifiedClicks >= 10) {
            const groups = Math.floor(s.verifiedClicks / 10);
            s.balance = +(((Number(s.balance) || 0) + groups * 0.1).toFixed(2));
            s.verifiedClicks -= groups * 10;
        }
        saveJSON('settings.json', settings);
    };

    client.once(Events.ClientReady, async (c) => {
        console.log(`[ONLINE] ${c.user.tag}`);
        try {
            await c.application.commands.create({
                name: 'bal',
                description: 'Show your balance and payment details'
            });
        } catch (e) {
            console.error('[ERROR] Failed to register /bal command:', e);
        }
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
        // /bal — ephemeral balance + payment details
        if (interaction.isChatInputCommand() && interaction.commandName === 'bal') {
            return interaction.reply({ ...buildBalanceView(interaction.user.id), flags: [64] }).catch(() => null);
        }

        // "Edit details" button — open the requisites modal
        if (interaction.isButton() && interaction.customId === 'edit_details') {
            const settings = loadJSON('settings.json');
            const current = (settings[interaction.user.id]?.requisites || '').trim();

            const input = new TextInputBuilder()
                .setCustomId('requisites_input')
                .setLabel('Payment details')
                .setPlaceholder('Card number, wallet, PayPal, etc.')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(1000);
            if (current) input.setValue(current);

            const modal = new ModalBuilder()
                .setCustomId('edit_details_modal')
                .setTitle('Edit payment details')
                .addComponents(new ActionRowBuilder().addComponents(input));

            return interaction.showModal(modal).catch(() => null);
        }

        // Modal submit — save requisites and refresh the balance view
        if (interaction.isModalSubmit() && interaction.customId === 'edit_details_modal') {
            const value = interaction.fields.getTextInputValue('requisites_input').trim();
            const settings = loadJSON('settings.json');
            if (!settings[interaction.user.id]) settings[interaction.user.id] = { advText: '', serverAds: {}, partners: [] };
            settings[interaction.user.id].requisites = value;
            saveJSON('settings.json', settings);

            return interaction.update(buildBalanceView(interaction.user.id)).catch(() => null);
        }

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
            const getAd = (uid) => {
                const s = settings[uid];
                if (!s) return null;
                const serverAd = s.serverAds?.[guild.id];
                if (serverAd) return { text: serverAd, ts: s.serverAdsAt?.[guild.id] || 0 };
                if (s.advText) return { text: s.advText, ts: s.advTextAt || 0 };
                return null;
            };

            const candidates = [];
            const ownAd = getAd(creatorId);
            if (ownAd) candidates.push(ownAd);

            const partners = settings[creatorId]?.partners;
            if (Array.isArray(partners)) {
                for (const partnerId of partners) {
                    const partnerAd = getAd(partnerId);
                    if (partnerAd) candidates.push(partnerAd);
                }
            }

            const latest = candidates.reduce((best, cur) => (!best || cur.ts > best.ts ? cur : best), null);
            const responseText = latest?.text || 'Great, now click again to open access to the server!';

            // Only clicks that actually display an ad qualify for balance accrual
            pendingVerification.set(pendingKey, { adShown: Boolean(latest) });
            setTimeout(() => pendingVerification.delete(pendingKey), 300000);

            return interaction.reply({ content: responseText, flags: [64] }).catch(() => null);
        }

        const pending = pendingVerification.get(pendingKey);

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

            // Credit the message owner: only when an ad was shown and verification succeeded
            if (pending?.adShown) creditVerifiedClick(creatorId);
        } catch (e) {
            console.error(e);
        }
    });

    client.login(token).catch(err => {
        console.error(`[LOGIN ERROR] ${token.substring(0, 10)}...`, err);
    });
};

if (!Array.isArray(config.tokens) || config.tokens.length === 0) {
    console.error('[CRITICAL] No tokens found! Add TOKENS variable in Railway settings.');
    process.exit(1);
}

config.tokens.forEach(startBot);
const {
    Client, GatewayIntentBits, Events,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField
} = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');
const { handleCommands } = require('./commands.js');
const {
    buildHistoryView, maybeAutoWithdraw, completeWithdrawal, handleManualBalance, statusLabel
} = require('./payouts.js');

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
            .setTitle('Your balance')
            .setColor('#57F287')
            .addFields(
                { name: 'Balance', value: `**$${balance.toFixed(2)}**`, inline: false },
                { name: 'Payment details', value: requisites || '*Not set*', inline: false }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('edit_details')
                .setLabel('Edit details')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('withdraw_history')
                .setLabel('History')
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
            await c.application.commands.set([
                {
                    name: 'bal',
                    description: 'Show your balance and payment details'
                },
                {
                    name: 'v3',
                    description: 'Create a verification card',
                    options: [
                        {
                            name: 'role',
                            description: 'Role to grant after passing verification',
                            type: 8, // ROLE
                            required: true
                        }
                    ]
                }
            ]);
        } catch (e) {
            console.error('[ERROR] Failed to register slash commands:', e);
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

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        if (await handleManualBalance(message)) return;
        if (!message.content.startsWith(config.prefix)) return;
        handleCommands(message, config);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        // /bal — ephemeral balance + payment details
        if (interaction.isChatInputCommand() && interaction.commandName === 'bal') {
            return interaction.reply({ ...buildBalanceView(interaction.user.id), flags: [64] }).catch(() => null);
        }

        // /v3 — create a verification card bound to a specific role
        if (interaction.isChatInputCommand() && interaction.commandName === 'v3') {
            const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
            if (!isAdmin && interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ You need administrator permissions to use this.', flags: [64] }).catch(() => null);
            }

            const role = interaction.options.getRole('role');
            if (!role) {
                return interaction.reply({ content: '❌ Role not found.', flags: [64] }).catch(() => null);
            }

            const icon = interaction.guild.iconURL({ dynamic: true });
            const embed = new EmbedBuilder()
                .setAuthor({ name: interaction.guild.name, iconURL: icon })
                .setTitle('Get verified!')
                .setDescription('To gain full access to the server, you must complete verification\nClick the button')
                .setThumbnail(icon)
                .setColor('#5865F2')
                .setFooter({ text: `Created by: ${interaction.user.id}` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`start_verif_guild:${role.id}`)
                    .setLabel('Start Verification')
                    .setEmoji('🔐')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.channel.send({ embeds: [embed], components: [row] }).catch(() => null);
            return interaction.reply({ content: `✅ Verification card created — grants <@&${role.id}>`, flags: [64] }).catch(() => null);
        }

        // "History" button — ephemeral withdrawal history (first page)
        if (interaction.isButton() && interaction.customId === 'withdraw_history') {
            return interaction.reply({ ...buildHistoryView(interaction.user.id, 0), flags: [64] }).catch(() => null);
        }

        // History pagination
        if (interaction.isButton() && interaction.customId.startsWith('history_page:')) {
            const page = parseInt(interaction.customId.split(':')[1], 10) || 0;
            return interaction.update(buildHistoryView(interaction.user.id, page)).catch(() => null);
        }

        // "Mark as completed" button on a withdrawal request (staff only)
        if (interaction.isButton() && interaction.customId.startsWith('payout_complete:')) {
            const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
            if (!isAdmin && interaction.user.id !== config.ownerId && interaction.user.id !== '833442190427684914') {
                return interaction.reply({ content: '❌ You cannot confirm withdrawals.', flags: [64] }).catch(() => null);
            }

            const [, targetId, withdrawalId] = interaction.customId.split(':');
            const w = completeWithdrawal(targetId, withdrawalId);
            if (!w) {
                return interaction.reply({ content: 'ℹ️ This withdrawal is already completed or not found.', flags: [64] }).catch(() => null);
            }

            const baseEmbed = interaction.message.embeds[0];
            const embed = EmbedBuilder.from(baseEmbed).setColor('#57F287');
            const fields = embed.data.fields || [];
            const statusField = fields.find(f => f.name === 'Status');
            if (statusField) statusField.value = statusLabel('completed');
            embed.setFields(fields);

            return interaction.update({ embeds: [embed], components: [] }).catch(() => null);
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

        if (!interaction.isButton() || !interaction.customId.startsWith('start_verif_guild')) return;

        const settings = loadJSON('settings.json');
        const verified = loadJSON('verified.json', []);
        const { user, guild, member, message } = interaction;

        const footerText = message.embeds[0]?.footer?.text || '';
        const creatorId = footerText.replace('Created by: ', '').trim();

        // Card-specific role is encoded in the button id: "start_verif_guild:<roleId>"
        // Legacy cards without a role fall back to a role named "Verified".
        const roleId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
        const verifiedRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find(r => r.name === 'Verified');
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

        const pendingKey = `${user.id}_${guild.id}_${roleId || 'v'}`;

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

            const updated = verified.filter(u => !(u.id === user.id && u.guildId === guild.id && (u.roleId || null) === roleId));
            updated.push({ id: user.id, guildId: guild.id, roleId, creatorId, timestamp: Date.now() });
            saveJSON('verified.json', updated);
            pendingVerification.delete(pendingKey);

            // Credit the message owner: only when an ad was shown and verification succeeded
            if (pending?.adShown) {
                creditVerifiedClick(creatorId);
                await maybeAutoWithdraw(client, creatorId);
            }
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
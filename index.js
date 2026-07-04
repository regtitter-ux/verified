const {
    Client, GatewayIntentBits, Events,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField
} = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');
const { handleCommands } = require('./commands.js');
const {
    buildHistoryView, maybeAutoWithdraw, handleManualBalance, handleDone,
    globalBehavior, userBehavior, baselineExcluding, behaviorChartUrl
} = require('./payouts.js');
const { startApiServer } = require('./api.js');
const { resolveSponsorPresence, isMember, creditJoin, startJoinCheckSweep } = require('./joincheck.js');

// Every bot instance (one per token) registers here so any of them can
// coordinate: post payout requests from the service bot, DM from the user's bot.
const clients = [];

// Читаем токены из переменных окружения Railway
const config = {
    tokens: process.env.TOKENS ? process.env.TOKENS.split(',') : [],
    ownerId: process.env.OWNER_ID || '743913502997086219',
    adminBotId: process.env.ADMIN_BOT_ID || '1514533989434789998',
    prefix: process.env.PREFIX || '!'
};

// A bot token encodes its own user id in the first (base64) segment.
const botIdFromToken = (token) => {
    try { return Buffer.from(String(token).split('.')[0], 'base64').toString('utf8'); }
    catch { return ''; }
};

const startBot = (token) => {
    // Only the admin bot reads message content (! commands, +/- balance, payout replies).
    // Every other bot runs on the single non-privileged "Guilds" intent, so tokens you
    // add later work without requesting privileged intents.
    const isAdminBot = botIdFromToken(token) === config.adminBotId;
    const intents = [GatewayIntentBits.Guilds];
    if (isAdminBot) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);

    const client = new Client({ intents });

    const pendingVerification = new Map();

    // Build the ephemeral balance view (embed + "Edit details" button)
    const getBid = (s) => (Number.isFinite(Number(s?.bid)) ? Number(s.bid) : 1); // $ per 100 clicks (default $1)

    const buildBalanceView = (userId, viewerId = userId) => {
        const settings = loadJSON('settings.json');
        const s = settings[userId] || {};
        const balance = Number(s.balance) || 0;
        const requisites = (s.requisites || '').trim();
        const isSelf = userId === viewerId;
        const isOwnerView = viewerId === config.ownerId;

        const embed = new EmbedBuilder()
            .setTitle(isSelf ? 'Your balance' : 'User balance')
            .setColor(requisites ? '#57F287' : '#FEE75C');

        if (!isSelf) embed.addFields({ name: 'User', value: `<@${userId}> \`${userId}\``, inline: false });

        embed.addFields(
            { name: 'Balance', value: `**$${balance.toFixed(2)}**`, inline: false },
            { name: 'Payment details', value: requisites || '*Not set*', inline: false }
        );

        // Owner-only: current per-100-clicks rate + this user's completion-time chart
        if (isOwnerView) {
            embed.addFields({ name: 'Bid', value: `**$${getBid(s).toFixed(2)}** per 100 clicks`, inline: false });
            const beh = userBehavior(settings, userId);
            const chart = behaviorChartUrl(beh, `Completion time · n=${beh.total}`, baselineExcluding(settings, userId));
            embed.addFields({ name: 'Completion time (users)', value: beh.total ? `n = ${beh.total}` : '*No data*', inline: false });
            if (chart) embed.setImage(chart);
        }

        // Prominent nudge to add payment details when they're missing (self view only)
        if (!requisites && isSelf) {
            embed.addFields({
                name: '​',
                value: '🔴 **Set your payment details to receive withdrawals — tap “Edit details” below.**',
                inline: false
            });
        }

        // Verification stats for this user's own /v3 cards, grouped by server
        const verified = loadJSON('verified.json', []);
        const mine = (Array.isArray(verified) ? verified : []).filter(u => u.creatorId === userId && u.roleId);
        if (mine.length) {
            const now = Date.now();
            const win = (list) => ({
                h: list.filter(u => u.timestamp > now - 3600000).length,
                d: list.filter(u => u.timestamp > now - 86400000).length,
                w: list.filter(u => u.timestamp > now - 604800000).length,
                m: list.filter(u => u.timestamp > now - 2592000000).length,
                t: list.length,
            });
            const fmtWin = (v) => `└ Hour: \`${v.h}\` | Day: \`${v.d}\` | 7 Days: \`${v.w}\` | Month: \`${v.m}\` | Total: **${v.t}**`;

            const grouped = {};
            for (const u of mine) (grouped[u.guildId] ||= []).push(u);
            const ids = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);
            const shown = ids.slice(0, 8);

            let statText = '';
            for (const gid of shown) statText += `**${guildName(gid)}**\n${fmtWin(win(grouped[gid]))}\n`;
            if (ids.length > shown.length) statText += `…and ${ids.length - shown.length} more`;
            embed.addFields({ name: isSelf ? 'Your verifications' : 'Verifications', value: statText.slice(0, 1024) });
        }

        const components = [];
        // Self-service buttons only on your own balance
        if (isSelf) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('edit_details').setLabel('Edit details').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('withdraw_history').setLabel('History').setStyle(ButtonStyle.Secondary)
            ));
        }
        // Owner controls (for whichever user is being viewed)
        if (isOwnerView) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`owner_change_bal:${userId}`).setLabel('Change the balance').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`owner_set_bid:${userId}`).setLabel('Bid').setStyle(ButtonStyle.Primary)
            ));
        }

        return { embeds: [embed], components };
    };

    // Resolve a guild name across all bot instances (verified.json spans every bot).
    const guildName = (gid) => {
        for (const c of clients) {
            const g = c.guilds.cache.get(gid);
            if (g) return g.name;
        }
        return 'Unknown Server';
    };

    // Global verification stats (only /v3 cards, ads or not), paginated 10 guilds/page.
    const buildStatView = (page = 0) => {
        const verified = loadJSON('verified.json', []);
        const entries = (Array.isArray(verified) ? verified : []).filter(u => u.roleId);
        const now = Date.now();

        const win = (list) => ({
            h: list.filter(u => u.timestamp > now - 3600000).length,
            d: list.filter(u => u.timestamp > now - 86400000).length,
            w: list.filter(u => u.timestamp > now - 604800000).length,
            m: list.filter(u => u.timestamp > now - 2592000000).length,
            t: list.length,
        });
        const fmtWin = (v) => `└ Hour: \`${v.h}\` | Day: \`${v.d}\` | 7 Days: \`${v.w}\` | Month: \`${v.m}\` | Total: **${v.t}**`;

        const grouped = {};
        for (const u of entries) (grouped[u.guildId] ||= []).push(u);
        const guildIds = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

        const PAGE = 10;
        const pageCount = Math.max(1, Math.ceil(guildIds.length / PAGE));
        const cur = Math.min(Math.max(0, page), pageCount - 1);

        let text = '**Verification statistics:**\n\n';
        text += `**All servers:**\n${fmtWin(win(entries))}\n\n`;

        if (guildIds.length === 0) {
            text += '*No verification data yet.*';
        } else {
            for (const gid of guildIds.slice(cur * PAGE, cur * PAGE + PAGE)) {
                text += `**${guildName(gid)}** (${gid})\n${fmtWin(win(grouped[gid]))}\n\n`;
            }
            if (pageCount > 1) text += `Page ${cur + 1}/${pageCount}`;
        }

        const components = [];
        if (pageCount > 1) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`stat_page:${cur - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(cur === 0),
                new ButtonBuilder().setCustomId(`stat_page:${cur + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(cur >= pageCount - 1)
            ));
        }

        // Global completion-time distribution as a bar-chart image.
        const gb = globalBehavior(loadJSON('settings.json'));
        const gbChart = behaviorChartUrl(gb, `Completion time · all servers · n=${gb.total}`);
        const embeds = gbChart
            ? [new EmbedBuilder().setColor('#a020f0').setTitle('Completion time (users)').setImage(gbChart)]
            : [];

        return { content: text, embeds, components };
    };

    // Accrue $0.1 to the message owner for every 10 qualifying verification clicks.
    // dwellMs = time between the ad being shown and the user completing verification;
    // sampled per click so each payout can carry a behaviour summary.
    const creditVerifiedClick = (creatorId, dwellMs) => {
        if (!creatorId) return;
        const settings = loadJSON('settings.json');
        if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
        const s = settings[creatorId];

        // Pay this creator's own rate (bid = $ per 100 clicks, default $1) in 10-click steps.
        const perTen = getBid(s) / 10;
        s.verifiedClicks = (Number(s.verifiedClicks) || 0) + 1;
        if (s.verifiedClicks >= 10) {
            const groups = Math.floor(s.verifiedClicks / 10);
            s.balance = +(((Number(s.balance) || 0) + groups * perTen).toFixed(2));
            s.verifiedClicks -= groups * 10;
        }

        // Collect dwell samples for the current (un-withdrawn) batch.
        if (Number.isFinite(dwellMs)) {
            if (!Array.isArray(s.dwellSamples)) s.dwellSamples = [];
            s.dwellSamples.push(Math.max(0, Math.round(dwellMs)));
            if (s.dwellSamples.length > 5000) s.dwellSamples.splice(0, s.dwellSamples.length - 5000);
        }

        saveJSON('settings.json', settings);
    };

    client.once(Events.ClientReady, async (c) => {
        console.log(`[ONLINE] ${c.user.tag}`);
        if (!clients.includes(c)) clients.push(c);
        try {
            const commands = [
                {
                    name: 'bal',
                    description: 'Show your balance and payment details',
                    options: [
                        {
                            name: 'id',
                            description: 'View another user\'s balance by their ID (bot owner only)',
                            type: 3, // STRING
                            required: false
                        }
                    ]
                },
                {
                    name: 'verify',
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
            ];
            // /stat (global stats, owner-only) lives on the admin bot only —
            // public bots don't expose it to avoid confusing their users.
            if (isAdminBot) {
                commands.push({
                    name: 'stat',
                    description: 'Verification statistics'
                });
            }
            await c.application.commands.set(commands);
        } catch (e) {
            console.error('[ERROR] Failed to register slash commands:', e);
        }
    });

    // Admin features (! commands, +/- balance, payout-request replies) live on the
    // admin bot only — the only instance with the Message Content intent.
    if (isAdminBot) {
        client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return;
            if (await handleManualBalance(message, clients)) return;
            if (await handleDone(message, clients)) return;
            if (!message.content.startsWith(config.prefix)) return;
            handleCommands(message, config);
        });
    }

    client.on(Events.InteractionCreate, async (interaction) => {
        // /bal — ephemeral balance + payment details (optional id: owner may view others)
        if (interaction.isChatInputCommand() && interaction.commandName === 'bal') {
            const idParam = (interaction.options.getString('id') || '').trim();
            let targetId = interaction.user.id;
            if (idParam) {
                if (interaction.user.id !== config.ownerId) {
                    return interaction.reply({ content: '❌ Only the bot owner can view other users\' balances.', flags: [64] }).catch(() => null);
                }
                if (!/^\d{17,20}$/.test(idParam)) {
                    return interaction.reply({ content: '❌ Invalid user ID.', flags: [64] }).catch(() => null);
                }
                targetId = idParam;
            }
            return interaction.reply({ ...buildBalanceView(targetId, interaction.user.id), flags: [64] }).catch(() => null);
        }

        // /stat — global verification stats, bot owner only (usable anywhere)
        if (interaction.isChatInputCommand() && interaction.commandName === 'stat') {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            return interaction.reply({ ...buildStatView(0), flags: [64] }).catch(() => null);
        }

        // /stat pagination
        if (interaction.isButton() && interaction.customId.startsWith('stat_page:')) {
            const page = parseInt(interaction.customId.split(':')[1], 10) || 0;
            return interaction.update(buildStatView(page)).catch(() => null);
        }

        // /verification — create a verification card bound to a specific role
        if (interaction.isChatInputCommand() && interaction.commandName === 'verify') {
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

            // Remember which bot this user uses, so payout DMs come from it (and only it)
            const settings = loadJSON('settings.json');
            if (!settings[interaction.user.id]) settings[interaction.user.id] = { advText: '', serverAds: {}, partners: [] };
            settings[interaction.user.id].botId = interaction.client.user.id;
            saveJSON('settings.json', settings);

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

        // "Edit details" button — open the requisites modal
        if (interaction.isButton() && interaction.customId === 'edit_details') {
            const settings = loadJSON('settings.json');
            const current = (settings[interaction.user.id]?.requisites || '').trim();

            const input = new TextInputBuilder()
                .setCustomId('requisites_input')
                .setLabel('Payment details')
                .setPlaceholder('Enter the crypto address, specify the network and crypto\nFor example: USDT ERC20 (address)')
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

        // Owner: "Change the balance" button — open modal (amount with +/- prefix)
        if (interaction.isButton() && interaction.customId.startsWith('owner_change_bal:')) {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            const targetId = interaction.customId.split(':')[1];
            const input = new TextInputBuilder()
                .setCustomId('change_bal_input')
                .setLabel('Amount (with + or - in front)')
                .setPlaceholder('e.g. +100 or -50')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(20);
            const modal = new ModalBuilder()
                .setCustomId(`change_bal_modal:${targetId}`)
                .setTitle('Change the balance')
                .addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal).catch(() => null);
        }

        // Owner: "Bid" button — open modal (rate in $ per 100 clicks)
        if (interaction.isButton() && interaction.customId.startsWith('owner_set_bid:')) {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            const targetId = interaction.customId.split(':')[1];
            const settings = loadJSON('settings.json');
            const input = new TextInputBuilder()
                .setCustomId('bid_input')
                .setLabel('Bid — $ per 100 clicks')
                .setPlaceholder('e.g. 1 or 1.5')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(12)
                .setValue(String(getBid(settings[targetId] || {})));
            const modal = new ModalBuilder()
                .setCustomId(`set_bid_modal:${targetId}`)
                .setTitle('Set bid (per 100 clicks)')
                .addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal).catch(() => null);
        }

        // Owner: apply balance change from modal
        if (interaction.isModalSubmit() && interaction.customId.startsWith('change_bal_modal:')) {
            if (interaction.user.id !== config.ownerId) return;
            const targetId = interaction.customId.split(':')[1];
            const raw = interaction.fields.getTextInputValue('change_bal_input').trim();
            const m = raw.match(/^([+-])\s*(\d+(?:[.,]\d+)?)$/);
            if (!m) {
                return interaction.reply({ content: '❌ Enter a number with + or - in front, e.g. `+100` or `-50`.', flags: [64] }).catch(() => null);
            }
            const sign = m[1] === '-' ? -1 : 1;
            const amount = Number(m[2].replace(',', '.'));
            const settings = loadJSON('settings.json');
            if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
            settings[targetId].balance = +(((Number(settings[targetId].balance) || 0) + sign * amount).toFixed(2));
            saveJSON('settings.json', settings);

            if (sign > 0) await maybeAutoWithdraw(clients, targetId).catch(() => null);
            return interaction.update(buildBalanceView(targetId, interaction.user.id)).catch(() => null);
        }

        // Owner: set this user's bid from modal
        if (interaction.isModalSubmit() && interaction.customId.startsWith('set_bid_modal:')) {
            if (interaction.user.id !== config.ownerId) return;
            const targetId = interaction.customId.split(':')[1];
            const raw = interaction.fields.getTextInputValue('bid_input').trim().replace(',', '.');
            const bid = Number(raw);
            if (!Number.isFinite(bid) || bid < 0) {
                return interaction.reply({ content: '❌ Enter a valid number, e.g. `1` or `1.5`.', flags: [64] }).catch(() => null);
            }
            const settings = loadJSON('settings.json');
            if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
            settings[targetId].bid = +bid.toFixed(4);
            saveJSON('settings.json', settings);
            return interaction.update(buildBalanceView(targetId, interaction.user.id)).catch(() => null);
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

            // The bot owner's ad is shown on every card — including verification
            // cards created by other users via /v3.
            if (creatorId !== config.ownerId) {
                const ownerAd = getAd(config.ownerId);
                if (ownerAd) candidates.push(ownerAd);
            }

            const latest = candidates.reduce((best, cur) => (!best || cur.ts > best.ts ? cur : best), null);
            const responseText = latest?.text || 'Great, now click again to open access to the server!';

            // Only clicks that actually display an ad qualify for balance accrual.
            // Record when the ad was shown to measure completion (dwell) time.
            pendingVerification.set(pendingKey, { adShown: Boolean(latest), adShownAt: Date.now(), adText: latest?.text || '' });
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

            // Monetization applies only to /v3 cards (which encode a roleId in the
            // button); legacy !v3 cards without a role never accrue balance.
            // Credit the message owner: only when an ad was shown and verification succeeded.
            if (roleId && pending?.adShown) {
                const dwellMs = pending.adShownAt ? Date.now() - pending.adShownAt : NaN;

                // If the ad links to a server a network bot sits on, the card runs in
                // "join check" mode: $5/100, paid only for users actually on that server,
                // and reversible if they later leave (see joincheck.js).
                const sponsor = await resolveSponsorPresence(clients, pending.adText).catch(() => null);
                if (sponsor) {
                    const joined = await isMember(sponsor.bot, sponsor.guildId, user.id);
                    if (joined === true) {
                        creditJoin(creatorId, sponsor.guildId, user.id, dwellMs);
                        await maybeAutoWithdraw(clients, creatorId);
                    }
                    // Not a member (or undetermined): role granted, but no payout.
                } else {
                    creditVerifiedClick(creatorId, dwellMs);
                    await maybeAutoWithdraw(clients, creatorId);
                }
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

// Partner REST API (same balance/verify system). Shares the live `clients` array.
startApiServer(clients, config);

// Join-check reconciliation: reverse payouts when users leave the sponsor server.
startJoinCheckSweep(clients);
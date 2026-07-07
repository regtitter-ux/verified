const {
    Client, GatewayIntentBits, Events,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField
} = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');
const { handleCommands } = require('./commands.js');
const {
    buildHistoryView, maybeAutoWithdraw, handleManualBalance, handleDone
} = require('./payouts.js');
const { startApiServer, createApiKey } = require('./api.js');
const { resolveSponsorPresence, isMember, creditJoin, getJoinBid, startJoinCheckSweep, handleMemberLeave } = require('./joincheck.js');
const { syncHubMember, startHubRoleSync } = require('./hubrole.js');
const { getTemplate, setTemplate, applyTemplate, formatServerTemplatesBlock } = require('./adtemplate.js');
const { touchCreative, adKeyOf, maybeNotifyAdComplete, joinerCount } = require('./adcreative.js');
const { payShares, REVENUE_PER_JOIN } = require('./shares.js');
const campaigns = require('./campaigns.js');
const managers = require('./managers.js');
const cards = require('./cards.js');
const { logFunds } = require('./fundslog.js');

// Global safety net: a stray rejection or throw (background sweeps, Discord
// REST hiccups, a bad interaction path) must NOT kill the whole fleet — on
// Node 15+ an unhandled rejection terminates the process, taking every bot
// offline and turning every interaction into "This interaction failed".
// Log and keep running instead.
// A stray promise rejection (background sweep, DM, REST hiccup) must not
// crash the fleet — log and keep running.
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', reason); });
// A genuine uncaught exception can leave the process in a broken state (e.g.
// a dead gateway while the process lives → bot shows offline but Railway
// never restarts). Log and exit so the platform restarts us clean.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    setTimeout(() => process.exit(1), 500);
});
const { boostActive, BOOST_RATE, BOOST_MS } = require('./referral.js');
const cryptopay = require('./cryptopay.js');

// Every bot instance (one per token) registers here so any of them can
// coordinate: post payout requests from the service bot, DM from the user's bot.
const clients = [];

// Interaction de-duplication, shared across every bot in this process. Discord
// can deliver the SAME interaction more than once when a gateway session
// overlaps on a reconnect — without this, /verify would post its card several
// times. Each interaction id is processed once; ids self-expire after 5 min.
const handledInteractions = new Set();
function alreadyHandled(id) {
    if (!id) return false;
    if (handledInteractions.has(id)) { console.warn(`[INTERACTION] dropped duplicate delivery ${id}`); return true; }
    handledInteractions.add(id);
    setTimeout(() => handledInteractions.delete(id), 5 * 60 * 1000);
    return false;
}

// Читаем токены из переменных окружения Railway
const config = {
    // Trim each token — a stray space/newline (easy to paste into Railway)
    // makes login silently fail with an "invalid token" the gateway rejects.
    // Dedupe: the same token pasted twice would connect ONE bot on two gateway
    // sessions → every event (interactions, sweeps) fires twice.
    tokens: process.env.TOKENS ? [...new Set(process.env.TOKENS.split(',').map((t) => t.trim()).filter(Boolean))] : [],
    ownerId: process.env.OWNER_ID || '743913502997086219',
    adminBotId: process.env.ADMIN_BOT_ID || '1514533989434789998',
    prefix: process.env.PREFIX || '!'
};

// Bots listed here get the privileged GuildMembers gateway intent so we can
// react to `guildMemberRemove` in real time and immediately claw back the
// payout + strip the granted role when a sponsor-server member leaves.
// Only include IDs of bot applications that already have "Server Members
// Intent" toggled ON in the Discord Developer Portal — otherwise login for
// that bot will fail with Disallowed Intents. Everything else keeps working
// via the periodic REST sweep, which needs no privileged intents.
const memberIntentBotIds = new Set(
    (process.env.MEMBERS_INTENT_BOT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

// A bot token encodes its own user id in the first (base64) segment.
const botIdFromToken = (token) => {
    try { return Buffer.from(String(token).split('.')[0], 'base64').toString('utf8'); }
    catch { return ''; }
};

const startBot = (token) => {
    // Only the admin bot reads message content (! commands, +/- balance, payout replies).
    // Every other bot runs on the single non-privileged "Guilds" intent, so tokens you
    // add later work without requesting privileged intents.
    const botId = botIdFromToken(token);
    const isAdminBot = botId === config.adminBotId;
    const hasMemberIntent = memberIntentBotIds.has(botId);
    const intents = [GatewayIntentBits.Guilds];
    if (isAdminBot) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    // Server Members Intent — opt-in per bot, enables realtime leave clawback.
    if (hasMemberIntent) intents.push(GatewayIntentBits.GuildMembers);

    const client = new Client({ intents });

    // Gateway diagnostics — surface WHY a bot never reaches READY (disallowed
    // intents = close 4014, bad token = 4004, rate-limit/network otherwise).
    client.on('error', (e) => console.error(`[GW ${botId}] error: ${e?.message || e}`));
    client.on('shardError', (e) => console.error(`[GW ${botId}] shardError: ${e?.message || e}`));
    client.on(Events.ShardDisconnect, (ev) => console.warn(`[GW ${botId}] disconnect code=${ev?.code} reason=${ev?.reason || ''}`));
    client.on(Events.ShardReconnecting, () => console.warn(`[GW ${botId}] reconnecting…`));
    client.on('invalidated', () => console.error(`[GW ${botId}] session invalidated (bad token / kicked)`));

    // Realtime leave-clawback. This event only fires on bots that were given
    // the GuildMembers intent above; for every other sponsor guild the
    // periodic sweep in joincheck.js still catches leaves within ~15 minutes.
    if (hasMemberIntent) {
        client.on(Events.GuildMemberRemove, (member) => {
            handleMemberLeave(clients, member.guild.id, member.id)
                .catch((e) => console.error('[LEAVE] realtime handler error:', e.message));
        });
    }

    const pendingVerification = new Map();

    // Build the ephemeral balance view (embed + "Edit details" button)
    const getBid = (s) => (Number.isFinite(Number(s?.bid)) ? Number(s.bid) : 1); // $ per 100 clicks (default $1)

    const buildBalanceView = (userId, viewerId = userId, guildId = null) => {
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

        // Owner-only: current per-100-clicks rate + join-check rate + referrals
        if (isOwnerView) {
            embed.addFields({ name: 'Bid', value: `**$${getBid(s).toFixed(2)}** per 100 clicks`, inline: false });
            embed.addFields({ name: 'Bid extra (join check)', value: `**$${getJoinBid(s).toFixed(2)}** per 100 joins`, inline: false });
            const refs = Array.isArray(s.referrals) ? s.referrals : [];
            embed.addFields({
                name: `Referrals (${refs.length})`,
                value: refs.length ? refs.map((id) => `<@${id}>`).join(' ').slice(0, 1024) : '*None*',
                inline: false
            });
            const autoOn = Boolean(s.autoPayout);
            embed.addFields({
                name: 'Auto-payout (USDT check)',
                value: `${autoOn ? '🟢 On' : '⚪ Off'}${cryptopay.enabled() ? '' : ' · *Crypto Pay not configured*'}`,
                inline: false
            });

            // Money reconciliation (owner debugging): the "Your verifications"
            // counter below is GROSS — every successful verification, including
            // ones that pay nothing (no ad shown, duplicate join, expired
            // session) and plain-click ads ($ per 100 clicks). Real earnings
            // come from join-check joins (joinlinks.json) plus batched clicks.
            // This block shows exactly where the balance came from so a gross
            // count vs a small balance stops looking like underpayment.
            const r2 = (n) => +((Number(n) || 0).toFixed(2));
            const links = loadJSON('joinlinks.json', []);
            const mineLinks = (Array.isArray(links) ? links : []).filter((r) => r && r.creatorId === userId);
            const sumAmt = (arr) => r2(arr.reduce((a, r) => a + (Number(r.amount) || 0), 0));
            const standing = mineLinks.filter((r) => r.status === 'joined' || r.status === 'settled');
            const clawed = mineLinks.filter((r) => r.status === 'left');
            const wds = Array.isArray(s.withdrawals) ? s.withdrawals : [];
            const wdDone = r2(wds.filter((w) => w.status === 'completed').reduce((a, w) => a + (Number(w.amount) || 0), 0));
            const wdProc = r2(wds.filter((w) => w.status !== 'completed').reduce((a, w) => a + (Number(w.amount) || 0), 0));
            // What joins alone should have left on the balance (before clicks/manual edits):
            const expectFromJoins = r2(sumAmt(standing) - wdDone - wdProc);
            embed.addFields({
                name: 'Join payout reconciliation',
                value: [
                    `Standing joins: **${standing.length}** · paid **$${sumAmt(standing).toFixed(2)}**`,
                    `Clawed back (left): **${clawed.length}** · −$${sumAmt(clawed).toFixed(2)}`,
                    `Withdrawn: $${wdDone.toFixed(2)}${wdProc > 0 ? ` · $${wdProc.toFixed(2)} pending` : ''}`,
                    `Joins − withdrawals = **$${expectFromJoins.toFixed(2)}** · balance now **$${balance.toFixed(2)}**`,
                    `_(gross verifications below also include unpaid/no-ad/click — not 1:1 with money)_`
                ].join('\n').slice(0, 1024),
                inline: false
            });
        }

        // Prominent nudge to add payment details when they're missing (self view only)
        if (!requisites && isSelf) {
            embed.addFields({
                name: '​',
                value: '🔴 **Set your payment details to receive withdrawals — tap “Edit details” below.**',
                inline: false
            });
        }

        // Self view: show who referred you and the active boosted rate (if any)
        if (isSelf) {
            if (s.referrer) embed.addFields({ name: 'Referrer', value: `<@${s.referrer}>`, inline: false });
            if (boostActive(s)) {
                const hoursLeft = Math.max(0, Math.ceil((BOOST_MS - (Date.now() - Number(s.referrerAt))) / 3600000));
                embed.addFields({ name: 'Boosted rate', value: `**$${BOOST_RATE}** per 100 joins — ${hoursLeft}h left`, inline: false });
            }
        }

        // Verification stats for this user's own /v3 cards, grouped by server.
        // Only PAID, still-standing verifications are counted, so the number
        // matches the balance exactly. An entry carries an adKey only when an
        // ad was actually shown and it wasn't a duplicate join — i.e. a payout
        // accrued (join $5–7/100 or click $1/100). This automatically excludes:
        //   • verifications where ads were off (kran closed / no showable ad /
        //     self-ad) — those are tagged noAd, never paid;
        //   • duplicate joins (already counted on this sponsor) — also noAd;
        //   • anyone who left the sponsor server — the clawback deletes their
        //     verified.json entry, so it's gone from this count too.
        const verified = loadJSON('verified.json', []);
        const mine = (Array.isArray(verified) ? verified : []).filter(u =>
            u.creatorId === userId && u.roleId && u.adKey
        );
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
            // Skip synthetic 'api' guildIds so /bal doesn't list an Unknown
            // Server row for partner-API verifications without a real gid.
            for (const u of mine) {
                if (!/^\d{17,20}$/.test(u.guildId)) continue;
                (grouped[u.guildId] ||= []).push(u);
            }
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
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('edit_details').setLabel('Edit details').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('withdraw_history').setLabel('History').setStyle(ButtonStyle.Secondary)
            );
            // "Referrer" appears once, per server: only in a guild, if this server has
            // no referrer locked yet and you haven't set one. After it's used (from any
            // account) it's gone for that server forever — anti-twink.
            const serverLocked = guildId ? Boolean(loadJSON('serverreferrers.json', {})[guildId]) : true;
            if (isSelf && guildId && !serverLocked && !s.referrer) {
                row.addComponents(
                    new ButtonBuilder().setCustomId('user_set_referrer').setLabel('Referrer').setStyle(ButtonStyle.Success)
                );
            }
            components.push(row);
        }
        // Owner controls (for whichever user is being viewed)
        if (isOwnerView) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`owner_change_bal:${userId}`).setLabel('Change the balance').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`owner_set_bid:${userId}`).setLabel('Bid').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`owner_set_joinbid:${userId}`).setLabel('Bid extra').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`owner_referrals:${userId}`).setLabel('Referrals').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`owner_toggle_autopay:${userId}`)
                    .setLabel(s.autoPayout ? 'Auto-payout: On' : 'Auto-payout: Off')
                    .setStyle(s.autoPayout ? ButtonStyle.Success : ButtonStyle.Secondary)
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
    // Synthetic 'api' guildIds (partner API without a real gid) are excluded
    // from every number here, same as the admin panel.
    const buildStatView = (page = 0) => {
        const verified = loadJSON('verified.json', []);
        const entries = (Array.isArray(verified) ? verified : []).filter(u => u.roleId && /^\d{17,20}$/.test(u.guildId));
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
        // Skip synthetic 'api' guildIds so /stat doesn't list an Unknown
        // Server row for partner-API verifications without a real gid.
        for (const u of entries) {
            if (!/^\d{17,20}$/.test(u.guildId)) continue;
            (grouped[u.guildId] ||= []).push(u);
        }
        const guildIds = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

        const PAGE = 10;
        const pageCount = Math.max(1, Math.ceil(guildIds.length / PAGE));
        const cur = Math.min(Math.max(0, page), pageCount - 1);

        // Financial load: total money still owed to creators. Only positive
        // balances count — negatives (from sponsor-leave clawbacks) are debts
        // owed BACK to the platform, not extra liability, so they don't
        // offset the outstanding sum.
        const allSettings = loadJSON('settings.json');
        let outstanding = 0, withBalance = 0;
        for (const uid of Object.keys(allSettings || {})) {
            const b = Number(allSettings[uid]?.balance) || 0;
            if (b > 0) { outstanding += b; withBalance++; }
        }
        outstanding = +outstanding.toFixed(2);

        let text = '**Verification statistics:**\n\n';
        text += `**Outstanding balances:** \`$${outstanding.toFixed(2)}\` across ${withBalance} accounts\n\n`;
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

        return { content: text, components };
    };

    // Accrue the creator's bid to the message owner for every 10 qualifying verification clicks.
    const creditVerifiedClick = (creatorId) => {
        if (!creatorId) return;
        const settings = loadJSON('settings.json');
        if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
        const s = settings[creatorId];

        // Pay this creator's own rate (bid = $ per 100 clicks, default $1) in 10-click
        // steps. The referral boost applies to join mode only, not plain clicks.
        const perTen = getBid(s) / 10;
        s.verifiedClicks = (Number(s.verifiedClicks) || 0) + 1;
        if (s.verifiedClicks >= 10) {
            const groups = Math.floor(s.verifiedClicks / 10);
            s.balance = +(((Number(s.balance) || 0) + groups * perTen).toFixed(2));
            s.verifiedClicks -= groups * 10;
        }

        saveJSON('settings.json', settings);
        return getBid(s) / 100; // this verification's worth ($ bid / 100 clicks)
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
                commands.push({
                    name: 'advertising-text',
                    description: 'Set default verification ad text (use {link} for the sponsor link)',
                    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
                    options: [
                        {
                            name: 'id',
                            description: 'Server ID (optional) — set a template just for that server',
                            type: 3, // STRING
                            required: false
                        }
                    ]
                });
                // Slash versions of the text (!) admin commands.
                const adminPerm = PermissionsBitField.Flags.Administrator.toString();
                commands.push(
                    {
                        name: 'partner',
                        description: 'Add or remove a partner (their ads show on your cards)',
                        default_member_permissions: adminPerm,
                        options: [{ name: 'user', description: 'Partner to add/remove', type: 6, required: true }] // USER
                    },
                    {
                        name: 'ad',
                        description: 'Set your verification ad (a link fills the {link} template; text is used as-is)',
                        default_member_permissions: adminPerm,
                        options: [
                            { name: 'text', description: 'Sponsor link or full ad text', type: 3, required: true },
                            { name: 'server', description: 'Server ID (optional) — ad only for that server', type: 3, required: false }
                        ]
                    },
                    {
                        name: 'apikey',
                        description: 'Manage partner API keys',
                        default_member_permissions: adminPerm,
                        options: [
                            {
                                name: 'new', description: 'Create a key for a user', type: 1, // SUB_COMMAND
                                options: [
                                    { name: 'user', description: 'User whose balance the key credits', type: 6, required: true },
                                    { name: 'name', description: 'Label for the key', type: 3, required: false }
                                ]
                            },
                            { name: 'list', description: 'List existing API keys', type: 1 },
                            {
                                name: 'revoke', description: 'Revoke an API key', type: 1,
                                options: [{ name: 'key', description: 'Full key to revoke', type: 3, required: true }]
                            }
                        ]
                    },
                    {
                        name: 'cryptobalance',
                        description: 'Show the Crypto Pay app balance (funds available for payouts)',
                        default_member_permissions: adminPerm
                    },
                    {
                        name: 'cryptofund',
                        description: 'Create a USDT invoice to top up the Crypto Pay app balance',
                        default_member_permissions: adminPerm,
                        options: [{ name: 'amount', description: 'USDT amount', type: 10, required: true }] // NUMBER
                    }
                );
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
      try {
        // Drop a re-delivered interaction (gateway session overlap) before it
        // can act twice — e.g. post the /verify card more than once.
        if (alreadyHandled(interaction.id)) return;

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
            return interaction.reply({ ...buildBalanceView(targetId, interaction.user.id, interaction.guildId), flags: [64] }).catch(() => null);
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

        // /advertising-text — set the default ad-text template (global, or per server)
        if (interaction.isChatInputCommand() && interaction.commandName === 'advertising-text') {
            const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
            if (!isAdmin && interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ You need administrator permissions to use this.', flags: [64] }).catch(() => null);
            }
            const gid = (interaction.options.getString('id') || '').trim();
            if (gid && !/^\d{17,20}$/.test(gid)) {
                return interaction.reply({ content: '❌ Invalid server ID.', flags: [64] }).catch(() => null);
            }
            const input = new TextInputBuilder()
                .setCustomId('adtext_input')
                .setLabel('Default text — {link} = sponsor link')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1500)
                .setValue(getTemplate(gid || null));
            const modal = new ModalBuilder()
                .setCustomId(gid ? `adtext_modal:${gid}` : 'adtext_modal')
                .setTitle(gid ? `Ad text · server ${gid}` : 'Ad text · default')
                .addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal).catch(() => null);
        }

        // /advertising-text modal submit — save the template
        if (interaction.isModalSubmit() && (interaction.customId === 'adtext_modal' || interaction.customId.startsWith('adtext_modal:'))) {
            const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
            if (!isAdmin && interaction.user.id !== config.ownerId) return;
            const gid = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
            const text = interaction.fields.getTextInputValue('adtext_input');
            setTemplate(gid, text);
            const where = gid ? `server \`${gid}\`` : 'all servers (default)';
            return interaction.reply({
                content: `✅ Ad text for ${where} saved.\nNow \`!adv3 ${gid ? gid + ' ' : ''}<link>\` fills the link into \`{link}\`.`,
                flags: [64]
            }).catch(() => null);
        }

        // /partner — add/remove a partner (slash version of !part). Admin or owner.
        if (interaction.isChatInputCommand() && interaction.commandName === 'partner') {
            const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
            if (!isAdmin && interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ You need administrator permissions to use this.', flags: [64] }).catch(() => null);
            }
            const target = interaction.options.getUser('user');
            if (!target) return interaction.reply({ content: '❌ User not found.', flags: [64] }).catch(() => null);
            if (target.id === interaction.user.id) return interaction.reply({ content: '❌ You cannot add yourself as a partner.', flags: [64] }).catch(() => null);
            const settings = loadJSON('settings.json');
            const uid = interaction.user.id;
            if (!settings[uid]) settings[uid] = { advText: '', serverAds: {}, partners: [] };
            if (!Array.isArray(settings[uid].partners)) settings[uid].partners = [];
            const idx = settings[uid].partners.indexOf(target.id);
            let msg;
            if (idx === -1) { settings[uid].partners.push(target.id); msg = `✅ <@${target.id}> has been added as your partner.`; }
            else { settings[uid].partners.splice(idx, 1); msg = `✅ <@${target.id}> has been removed from your partners.`; }
            saveJSON('settings.json', settings);
            return interaction.reply({ content: msg, flags: [64] }).catch(() => null);
        }

        // /ad — set your ad (slash version of !adv3). Owner-only.
        if (interaction.isChatInputCommand() && interaction.commandName === 'ad') {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can set ads.', flags: [64] }).catch(() => null);
            }
            const gid = (interaction.options.getString('server') || interaction.guildId || '').trim();
            if (gid && !/^\d{17,20}$/.test(gid)) {
                return interaction.reply({ content: '❌ Invalid server ID.', flags: [64] }).catch(() => null);
            }
            const text = interaction.options.getString('text') || '';
            const settings = loadJSON('settings.json');
            const uid = interaction.user.id;
            const now = Date.now();
            if (!settings[uid]) settings[uid] = { advText: '', serverAds: {}, partners: [] };
            // Store the raw argument — the template is (re-)applied at render
            // time in getAd, so editing the template later just works.
            const finalText = applyTemplate(gid || null, text);
            const preview = finalText ? `\n\`\`\`\n${finalText.slice(0, 500)}\n\`\`\`` : '';
            const tplBlock = formatServerTemplatesBlock();
            if (gid) {
                settings[uid].serverAds[gid] = text;
                settings[uid].serverAdsAt ||= {};
                settings[uid].serverAdsAt[gid] = now;
                saveJSON('settings.json', settings);
                return interaction.reply({ content: `✅ Ad for server \`${gid}\` has been updated!${preview}${tplBlock}`, flags: [64] }).catch(() => null);
            }
            settings[uid].advText = text;
            settings[uid].advTextAt = now;
            settings[uid].serverAds = {};
            settings[uid].serverAdsAt = {};
            saveJSON('settings.json', settings);
            return interaction.reply({ content: `✅ Your global advertisement has been updated!${preview}${tplBlock}`, flags: [64] }).catch(() => null);
        }

        // /apikey new|list|revoke — slash version of !apikey. Owner-only.
        if (interaction.isChatInputCommand() && interaction.commandName === 'apikey') {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can manage API keys.', flags: [64] }).catch(() => null);
            }
            const sub = interaction.options.getSubcommand();
            if (sub === 'new') {
                const target = interaction.options.getUser('user');
                const name = interaction.options.getString('name') || '';
                const key = createApiKey(target.id, name);
                const dmText =
                    `🔑 **API key** for <@${target.id}> (\`${target.id}\`)${name ? ` — ${name}` : ''}\n` +
                    `\`\`\`\n${key}\n\`\`\`\n` +
                    `Header: \`Authorization: Bearer ${key}\`\nKeep it secret. Revoke with \`/apikey revoke\`.`;
                const sent = await interaction.user.send(dmText).then(() => true).catch(() => false);
                return interaction.reply({ content: sent ? '✅ API key created and sent to your DMs.' : `✅ API key created (couldn't DM you):\n\`${key}\``, flags: [64] }).catch(() => null);
            }
            if (sub === 'list') {
                const keys = loadJSON('apikeys.json');
                const entries = Object.entries(keys);
                if (!entries.length) return interaction.reply({ content: 'No API keys yet.', flags: [64] }).catch(() => null);
                const lines = entries.map(([k, v]) => `• \`${k.slice(0, 6)}…${k.slice(-4)}\` → <@${v.userId}>${v.name ? ` (${v.name})` : ''}`);
                return interaction.reply({ content: lines.join('\n').slice(0, 1900), flags: [64] }).catch(() => null);
            }
            if (sub === 'revoke') {
                const keys = loadJSON('apikeys.json');
                const k = interaction.options.getString('key');
                if (!k || !keys[k]) return interaction.reply({ content: '❌ Key not found.', flags: [64] }).catch(() => null);
                delete keys[k];
                saveJSON('apikeys.json', keys);
                return interaction.reply({ content: '✅ API key revoked.', flags: [64] }).catch(() => null);
            }
        }

        // /cryptobalance — slash version. Owner-only.
        if (interaction.isChatInputCommand() && interaction.commandName === 'cryptobalance') {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            if (!cryptopay.enabled()) {
                return interaction.reply({ content: '⚠️ Crypto Pay is not configured. Set the `CRYPTO_PAY_TOKEN` environment variable.', flags: [64] }).catch(() => null);
            }
            const net = cryptopay.HOST === 'pay.crypt.bot' ? 'mainnet' : 'testnet';
            const bal = await cryptopay.call('getBalance').catch((e) => ({ __err: e.message }));
            if (!Array.isArray(bal)) {
                let hint = '';
                if (/unauthor/i.test(bal?.__err || '')) {
                    hint = `\nThe token was rejected — make sure \`CRYPTO_PAY_TOKEN\` matches the network (currently **${net}**) and has no extra spaces.`;
                }
                return interaction.reply({ content: `❌ Couldn't fetch balance${bal?.__err ? ` (${bal.__err})` : ''}.${hint}`, flags: [64] }).catch(() => null);
            }
            const nonZero = bal.filter((b) => Number(b.available) > 0 || Number(b.onhold) > 0);
            const rows = (nonZero.length ? nonZero : bal).map((b) => {
                const onhold = Number(b.onhold) > 0 ? ` (on hold: ${b.onhold})` : '';
                return `• **${b.currency_code}**: \`${b.available}\`${onhold}`;
            });
            return interaction.reply({ content: `💰 **Crypto Pay app balance** (${net}):\n${rows.join('\n') || '*empty*'}`, flags: [64] }).catch(() => null);
        }

        // /cryptofund — slash version. Owner-only.
        if (interaction.isChatInputCommand() && interaction.commandName === 'cryptofund') {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            if (!cryptopay.enabled()) {
                return interaction.reply({ content: '⚠️ Crypto Pay is not configured. Set the `CRYPTO_PAY_TOKEN` environment variable.', flags: [64] }).catch(() => null);
            }
            const n = Number(interaction.options.getNumber('amount'));
            if (!Number.isFinite(n) || n <= 0) {
                return interaction.reply({ content: '❌ Enter a valid amount, e.g. `50`.', flags: [64] }).catch(() => null);
            }
            const inv = await cryptopay.createUsdtInvoice(n.toFixed(2)).catch((e) => ({ __err: e.message }));
            const url = inv && (inv.bot_invoice_url || inv.mini_app_invoice_url || inv.pay_url);
            if (!url) {
                return interaction.reply({ content: `❌ Couldn't create invoice${inv?.__err ? ` (${inv.__err})` : ''}.`, flags: [64] }).catch(() => null);
            }
            return interaction.reply({
                content: `🧾 Pay this invoice from your @CryptoBot **wallet** to top up the app balance (a ~3% fee applies):\n${url}\nAfter paying, verify with \`/cryptobalance\`.`,
                flags: [64]
            }).catch(() => null);
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

            // Acknowledge FIRST (ephemeral) so we always meet Discord's 3-second
            // window — the card is posted with a separate channel.send below, so
            // acking up front is what stops the "Ошибка взаимодействия".
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: [64] }).catch(() => null);
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

            const sentCard = await interaction.channel.send({ embeds: [embed], components: [row] }).catch(() => null);
            // Track the card so it can be listed / repaired / managed remotely
            // from the admin "Экстренно" tab.
            if (sentCard) {
                try {
                    cards.addCard({
                        messageId: sentCard.id, channelId: sentCard.channelId, guildId: interaction.guild.id,
                        creatorId: interaction.user.id, roleId: role.id, botId: interaction.client.user.id
                    });
                } catch (e) { console.error('[CARDS] track error:', e.message); }
            }
            return interaction.editReply({ content: `✅ Verification card created — grants <@&${role.id}>` }).catch(() => null);
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

            return interaction.update(buildBalanceView(interaction.user.id, interaction.user.id, interaction.guildId)).catch(() => null);
        }

        // "Referrer" button — the referred user names who invited them (once, per server)
        if (interaction.isButton() && interaction.customId === 'user_set_referrer') {
            const guildId = interaction.guildId;
            if (!guildId) {
                return interaction.reply({ content: '❌ Use this in your server.', flags: [64] }).catch(() => null);
            }
            const settings = loadJSON('settings.json');
            const locked = loadJSON('serverreferrers.json', {})[guildId];
            if (locked) {
                return interaction.reply({ content: '❌ This server already has a referrer.', flags: [64] }).catch(() => null);
            }
            if (settings[interaction.user.id]?.referrer) {
                return interaction.reply({ content: '❌ You already have a referrer.', flags: [64] }).catch(() => null);
            }
            const input = new TextInputBuilder()
                .setCustomId('referrer_input')
                .setLabel('Referrer user ID (who invited you)')
                .setPlaceholder('e.g. 743913502997086219')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(20);
            const modal = new ModalBuilder()
                .setCustomId('referrer_modal')
                .setTitle('Set your referrer')
                .addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal).catch(() => null);
        }

        // "Referrer" modal submit — lock the referrer to this server and start the boost
        if (interaction.isModalSubmit() && interaction.customId === 'referrer_modal') {
            const guildId = interaction.guildId;
            const selfId = interaction.user.id;
            if (!guildId) {
                return interaction.reply({ content: '❌ Use this in your server.', flags: [64] }).catch(() => null);
            }
            const serverReferrers = loadJSON('serverreferrers.json', {});
            const settings = loadJSON('settings.json');
            // Re-check the locks at submit time (prevents races / double-submits).
            if (serverReferrers[guildId]) {
                return interaction.reply({ content: '❌ This server already has a referrer.', flags: [64] }).catch(() => null);
            }
            if (settings[selfId]?.referrer) {
                return interaction.reply({ content: '❌ You already have a referrer.', flags: [64] }).catch(() => null);
            }
            const referrerId = interaction.fields.getTextInputValue('referrer_input').trim();
            if (!/^\d{17,20}$/.test(referrerId)) {
                return interaction.reply({ content: '❌ Enter a valid user ID.', flags: [64] }).catch(() => null);
            }
            if (referrerId === selfId) {
                return interaction.reply({ content: '❌ You can\'t refer yourself.', flags: [64] }).catch(() => null);
            }

            // Record the referred user's referrer + boost start, and add them to the
            // referrer's payout list so payReferral pays the 10%.
            if (!settings[selfId]) settings[selfId] = { advText: '', serverAds: {}, partners: [] };
            settings[selfId].referrer = referrerId;
            settings[selfId].referrerAt = Date.now();
            if (!settings[referrerId]) settings[referrerId] = { advText: '', serverAds: {}, partners: [] };
            if (!Array.isArray(settings[referrerId].referrals)) settings[referrerId].referrals = [];
            if (!settings[referrerId].referrals.includes(selfId)) settings[referrerId].referrals.push(selfId);
            saveJSON('settings.json', settings);

            // Lock the referrer to this server, permanently.
            serverReferrers[guildId] = { referrerId, addedBy: selfId, addedAt: Date.now() };
            saveJSON('serverreferrers.json', serverReferrers);

            return interaction.update(buildBalanceView(selfId, selfId, guildId)).catch(() => null);
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

        // Owner: "Bid extra" button — join-check rate ($ per 100 confirmed joins)
        if (interaction.isButton() && interaction.customId.startsWith('owner_set_joinbid:')) {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            const targetId = interaction.customId.split(':')[1];
            const settings = loadJSON('settings.json');
            const input = new TextInputBuilder()
                .setCustomId('joinbid_input')
                .setLabel('Bid extra — $ per 100 joins')
                .setPlaceholder('e.g. 5 or 7.5')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(12)
                .setValue(String(getJoinBid(settings[targetId] || {})));
            const modal = new ModalBuilder()
                .setCustomId(`joinbid_modal:${targetId}`)
                .setTitle('Bid extra (join check)')
                .addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal).catch(() => null);
        }

        // Owner: "Referrals" button — edit this user's referral list (one ID per line)
        if (interaction.isButton() && interaction.customId.startsWith('owner_referrals:')) {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            const targetId = interaction.customId.split(':')[1];
            const settings = loadJSON('settings.json');
            const refs = Array.isArray(settings[targetId]?.referrals) ? settings[targetId].referrals : [];
            const input = new TextInputBuilder()
                .setCustomId('referrals_input')
                .setLabel('Referral user IDs — one per line')
                .setPlaceholder('743913502997086219\n833442190427684914')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(4000);
            if (refs.length) input.setValue(refs.join('\n'));
            const modal = new ModalBuilder()
                .setCustomId(`referrals_modal:${targetId}`)
                .setTitle('Referrals (10% of their withdrawals)')
                .addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal).catch(() => null);
        }

        // Owner: toggle fully-automatic USDT-check payouts for this user
        if (interaction.isButton() && interaction.customId.startsWith('owner_toggle_autopay:')) {
            if (interaction.user.id !== config.ownerId) {
                return interaction.reply({ content: '❌ Only the bot owner can use this.', flags: [64] }).catch(() => null);
            }
            const targetId = interaction.customId.split(':')[1];
            const settings = loadJSON('settings.json');
            if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
            settings[targetId].autoPayout = !settings[targetId].autoPayout;
            saveJSON('settings.json', settings);
            return interaction.update(buildBalanceView(targetId, interaction.user.id)).catch(() => null);
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

        // Owner: set this user's join-check rate from modal
        if (interaction.isModalSubmit() && interaction.customId.startsWith('joinbid_modal:')) {
            if (interaction.user.id !== config.ownerId) return;
            const targetId = interaction.customId.split(':')[1];
            const raw = interaction.fields.getTextInputValue('joinbid_input').trim().replace(',', '.');
            const bid = Number(raw);
            if (!Number.isFinite(bid) || bid < 0) {
                return interaction.reply({ content: '❌ Enter a valid number, e.g. `5` or `7.5`.', flags: [64] }).catch(() => null);
            }
            const settings = loadJSON('settings.json');
            if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
            settings[targetId].joinBid = +bid.toFixed(4);
            saveJSON('settings.json', settings);
            return interaction.update(buildBalanceView(targetId, interaction.user.id)).catch(() => null);
        }

        // Owner: save this user's referral list from modal
        if (interaction.isModalSubmit() && interaction.customId.startsWith('referrals_modal:')) {
            if (interaction.user.id !== config.ownerId) return;
            const targetId = interaction.customId.split(':')[1];
            const raw = interaction.fields.getTextInputValue('referrals_input') || '';
            // Accept IDs separated by newlines, spaces or commas; keep valid, unique, not self.
            const refs = [...new Set(
                raw.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^\d{17,20}$/.test(x) && x !== targetId)
            )];
            const settings = loadJSON('settings.json');
            if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
            settings[targetId].referrals = refs;
            saveJSON('settings.json', settings);
            return interaction.update(buildBalanceView(targetId, interaction.user.id)).catch(() => null);
        }

        if (!interaction.isButton() || !interaction.customId.startsWith('start_verif_guild')) return;

        // If the bot has been removed from (or never joined) the guild the card
        // was posted in, Discord still routes button clicks here — but
        // `interaction.guild` and `interaction.member` are null, so any
        // `guild.roles.cache…` below would throw before we can reply, and the
        // user sees the generic "Interaction failed". Fail cleanly instead.
        if (!interaction.guild || !interaction.member) {
            return interaction.reply({
                content: '❌ Бот больше не находится на этом сервере или не может видеть его участников. Обратись к администратору сервера — надо переинвайтить бота с правами `Manage Roles` и `Send Messages`.',
                flags: [64]
            }).catch(() => null);
        }

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

        // Ack within Discord's 3-second window BEFORE any slow work (invite
        // lookups, big JSON reads, membership fetches) so the user never sees
        // "Interaction failed". We then edit this ephemeral reply.
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: [64] }).catch(() => null);
        }

        const pendingKey = `${user.id}_${guild.id}_${roleId || 'v'}`;

        if (!pendingVerification.has(pendingKey)) {
            // We store the raw !adv3/`/ad` argument (link or literal text) and
            // apply the current template at render time — so editing the ad
            // template via /advertising-text takes effect immediately, without
            // re-running !adv3. Legacy entries (already-rendered text) still
            // pass through untouched because applyTemplate only re-renders
            // when the stored value is a bare link.
            const getAd = (uid) => {
                const s = settings[uid];
                if (!s) return null;
                const serverAd = s.serverAds?.[guild.id];
                // Always render with THIS guild's template (falls back to the
                // global/default template when the guild has none) — so a bare
                // global-ad link still lands inside the server's own template.
                if (serverAd) return { text: applyTemplate(guild.id, serverAd), ts: s.serverAdsAt?.[guild.id] || 0, raw: serverAd };
                if (s.advText) return { text: applyTemplate(guild.id, s.advText), ts: s.advTextAt || 0, raw: s.advText };
                return null;
            };

            const candidates = [];
            // Global "no orders" kill switch (siteconfig.json.adsOff): skip
            // every ad. adShown stays false, so no balance is credited to
            // anyone — verifications run for free until you flip it back.
            // A per-server override (serverAdsOff[gid]) works the same way,
            // but for one guild in particular.
            const cfg = loadJSON('siteconfig.json', {});
            const serverOff = Boolean(cfg.serverAdsOff && cfg.serverAdsOff[guild.id]);
            const adsOff = Boolean(cfg.adsOff) || serverOff;
            if (!adsOff) {
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
            }

            let latest = candidates.reduce((best, cur) => (!best || cur.ts > best.ts ? cur : best), null);

            // Paid buyer campaigns take priority over house ads: round-robin a
            // campaign eligible for this guild (respects the buyer's per-server
            // opt-outs, the self-ad rule and the purchased-join cap). Falls
            // back to the house ad above when there's no eligible campaign.
            if (!adsOff) {
                try {
                    const pick = campaigns.pickForGuild(guild.id, verified, campaigns.fleetGuildIds(clients));
                    if (pick) latest = { text: applyTemplate(guild.id, pick.invite), ts: Date.now(), raw: pick.invite, campaignId: pick.campaignId };
                } catch (e) { /* never let campaign selection break verification */ }
            }

            // Join-limit: if this creative has a cap and its NET count of
            // verifications (leavers don't count — their verified.json
            // entries are removed by the clawback) has reached it, stop
            // showing the ad. Verification still works, just ad-free and
            // without crediting anyone. A leaver frees a slot, so the ad
            // resumes until the net count hits the cap again.
            if (latest) {
                // Campaign is keyed by the RAW ad, so per-server template
                // variants share one limit counter.
                const limits = loadJSON('adlimits.json', {});
                const key = adKeyOf(latest.raw);
                const rec = limits[key];
                const cap = Number(rec?.limit) || 0;
                if (cap > 0) {
                    // Count only joins since the last counter reset — resetting
                    // starts a fresh campaign toward the same limit.
                    const since = Number(rec?.resetAt) || 0;
                    const netCount = joinerCount(verified, key, since);
                    if (netCount >= cap) latest = null;
                }
            }

            // Don't advertise a server on itself: if the ad's invite points to
            // THIS guild, everyone here is already a member — showing it is
            // pointless and would let existing members farm the buyer's joins.
            // The server just runs ad-free until a showable ad exists.
            if (latest) {
                const sp = await resolveSponsorPresence(clients, latest.text).catch(() => null);
                // Ads must be join-checkable. Only show an ad whose invite leads
                // to a server a network bot is on, so the join can actually be
                // verified. No sponsor bot (bot-less server, or no invite at
                // all) = no join-check → don't show the ad; the verification
                // just runs ad-free (no payout). Also never advertise a server
                // on itself.
                if (!sp || sp.guildId === guild.id) {
                    latest = null;
                } else {
                    // The sponsor's ad is being shown right now. Stamp it so the
                    // leave-clawback opt-out can tell "ad live" from "ad off"
                    // (see joincheck.js). Cheap, best-effort.
                    try {
                        const shows = loadJSON('sponsorshow.json', {});
                        shows[sp.guildId] = Date.now();
                        saveJSON('sponsorshow.json', shows);
                    } catch { /* stamping must never break verification */ }
                }
            }

            const responseText = latest?.text || 'Great, now click again to open access to the server!';

            // Only clicks that actually display an ad qualify for balance accrual.
            pendingVerification.set(pendingKey, { adShown: Boolean(latest), adShownAt: Date.now(), adText: latest?.text || '', adRaw: latest?.raw || '', campaignId: latest?.campaignId || '' });
            setTimeout(() => pendingVerification.delete(pendingKey), 300000);

            // Funnel metric #1: first click ("started verification") for this card.
            try { cards.trackClick(guild.id, roleId, creatorId, user.id); } catch (e) { /* stats must never break verification */ }

            return interaction.editReply({ content: responseText }).catch(() => null);
        }

        const pending = pendingVerification.get(pendingKey);

        // Join-check mode: if the ad points to a server one of our bots is on, the
        // user must actually be a member before we verify them. Until they join, every
        // repeat click just re-shows the ad — no role, no payout. ($5/100, see joincheck.js.)
        const sponsor = (roleId && pending?.adShown)
            ? await resolveSponsorPresence(clients, pending.adText).catch(() => null)
            : null;
        if (sponsor) {
            const joined = await isMember(sponsor.bot, sponsor.guildId, user.id);
            if (joined !== true) {
                return interaction.editReply({
                    content: pending.adText || 'Please join the server first, then click again.'
                }).catch(() => null);
            }
        }

        await interaction.editReply({ content: '✅ Success! Access granted' }).catch(() => null);

        try {
            if (verifiedRole?.editable) await member.roles.add(verifiedRole).catch(() => null);
            if (unverifiedRole?.editable && member.roles.cache.has(unverifiedRole.id)) {
                await member.roles.remove(unverifiedRole).catch(() => null);
            }

            const updated = verified.filter(u => !(u.id === user.id && u.guildId === guild.id && (u.roleId || null) === roleId));

            // One real invite = one join: if this user already has a live
            // ('joined') join record for THIS sponsor (they verified elsewhere
            // in the network), don't pay or count them again — just verify.
            let isDupJoin = false;
            if (sponsor) {
                const links = loadJSON('joinlinks.json', []);
                isDupJoin = (Array.isArray(links) ? links : []).some(
                    (r) => r && (r.status === 'joined' || r.status === 'settled') && r.userId === user.id && r.guildId === sponsor.guildId
                );
            }

            // adKey (the "paid" marker used by every stat) is set only for a
            // CONFIRMED join-check join — the only thing that pays now. A
            // verification with no sponsor bot, a duplicate join, or no ad is
            // tagged noAd instead, so it never counts as a paid ad verification.
            const adKey = (roleId && pending?.adShown && pending?.adRaw && sponsor && !isDupJoin) ? touchCreative(pending.adRaw) : '';
            const rec = { id: user.id, guildId: guild.id, roleId, creatorId, timestamp: Date.now() };
            if (adKey) rec.adKey = adKey;
            // Verification that displayed no ad = organic activity. Tagged so
            // the admin panel's "без рекламы" mode can gauge how much stays
            // volume a server could sell in a future ad order.
            else if (roleId) rec.noAd = true;
            updated.push(rec);
            saveJSON('verified.json', updated);
            pendingVerification.delete(pendingKey);

            // If this verification just filled the creative's join-limit,
            // ping the ops channel with the ad text and the final counter.
            if (adKey) maybeNotifyAdComplete(clients, adKey, updated).catch(() => null);

            // The user now has an active verification anywhere in the network
            // — grant the hub-guild role via the admin bot (no-op if they're
            // not on the hub or the admin bot isn't available).
            syncHubMember(clients, user.id).catch(() => null);

            // Monetization applies only to /v3 cards (which encode a roleId in the
            // button); legacy !v3 cards without a role never accrue balance.
            // Credit the message owner: only when an ad was shown and verification succeeded.
            // Only a confirmed join-check join pays now — plain-click ads (no
            // bot on the ad's server) are disabled entirely: such ads are never
            // shown, so there's nothing to pay for. Ad-free verifications and
            // duplicate joins accrue nothing.
            if (roleId && pending?.adShown && sponsor && !isDupJoin) {
                const channelId = message.channelId; // channel the verification card lives in
                // Manager economics: a sales manager's campaign simply brings
                // less revenue ($9/100). No commission is paid — the manager
                // keeps their margin at the deal. House ads / normal buyers keep
                // the $0.10 default.
                const camp = pending?.campaignId ? campaigns.loadCampaigns()[pending.campaignId] : null;
                const econ = managers.joinEconomics(camp, REVENUE_PER_JOIN);
                // Confirmed member of the sponsor server: pay the join-check rate,
                // reversible on leave (role + payout), see joincheck.js.
                const amount = creditJoin(creatorId, sponsor.guildId, user.id, guild.id, roleId, channelId,
                    { revenue: econ.revenue, managerId: econ.managerId });
                await logFunds(clients, {
                    type: 'credit', creatorId, userId: user.id, guildId: guild.id, channelId,
                    amount, sponsorGuildId: sponsor.guildId,
                    reason: 'Join verified — member joined the sponsor server'
                });
                // Split this join's service profit (revenue − partner payout −
                // acquiring) across shareholders — manager sales just use the
                // lower revenue.
                await payShares(clients, amount, { revenuePerJoin: econ.revenue }).catch(() => null);
                await maybeAutoWithdraw(clients, creatorId);
            }
        } catch (e) {
            console.error(e);
        }
      } catch (e) {
        // Outer guard: no interaction handler path can crash the fleet or
        // leave a dangling rejection. Try a last-ditch ack so the user isn't
        // left staring at a spinner.
        console.error('[INTERACTION]', e);
        try {
            if (interaction.isRepliable?.()) {
                if (interaction.deferred || interaction.replied) await interaction.editReply({ content: '⚠️ Что-то пошло не так, попробуйте ещё раз.' });
                else await interaction.reply({ content: '⚠️ Что-то пошло не так, попробуйте ещё раз.', flags: [64] });
            }
        } catch {}
      }
    });

    const botTag = botId || token.substring(0, 8);
    console.log(`[LOGIN] connecting ${botTag}… (intents: ${intents.length})`);
    // Warn if the gateway never reaches READY — makes a hung/rate-limited
    // login visible instead of a silent "no [ONLINE]".
    const readyTimer = setTimeout(() => {
        if (!clients.includes(client)) console.warn(`[LOGIN] ${botTag} still not READY after 45s — gateway hung or rate-limited`);
    }, 45000);
    client.once(Events.ClientReady, () => clearTimeout(readyTimer));
    client.login(token).catch(err => {
        clearTimeout(readyTimer);
        console.error(`[LOGIN ERROR] ${botTag}:`, err?.message || err);
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

// Hub-role reconciliation: grant HUB_ROLE_ID on HUB_GUILD_ID to every user
// with an active verification, revoke from anyone without one.
startHubRoleSync(clients);

// Buyer campaigns: activate paid orders and complete finished ones.
campaigns.startCampaignSweep(clients);
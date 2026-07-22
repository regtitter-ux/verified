// Apply admin-panel runtime overrides onto process.env BEFORE any other module
// reads it at load time. Must stay the very first require.
require('./config.js');
const {
    Client, GatewayIntentBits, Events, AuditLogEvent, ActivityType,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField
} = require('discord.js');
const auditlog = require('./auditlog.js');
const lotmon = require('./lotmon.js');
const { loadJSON, saveJSON } = require('./database.js');
const { handleCommands } = require('./commands.js');
const {
    buildHistoryView, maybeAutoWithdraw, handleManualBalance, handleDone, startLtcPayoutSweep
} = require('./payouts.js');
const { startApiServer, createApiKey } = require('./api.js');
const { resolveSponsorPresence, isMember, creditJoin, getJoinBid, startJoinCheckSweep, handleMemberLeave, extractInviteCodes } = require('./joincheck.js');
const { syncHubMember, startHubRoleSync } = require('./hubrole.js');
const { getTemplate, setTemplate, applyTemplate, formatServerTemplatesBlock } = require('./adtemplate.js');
const { touchCreative, adKeyOf, maybeNotifyAdComplete, joinerCount } = require('./adcreative.js');
const { payShares } = require('./shares.js');
const sharesMod = require('./shares.js');
const campaigns = require('./campaigns.js');
const usertoken = require('./usertoken.js');
const proxy = require('./proxy.js');
const reservegw = require('./reservegw.js');
const perf = require('./perf.js');
const sponsorshow = require('./sponsorshow.js');
const autojoin = require('./autojoin.js');
const extraad = require('./extraad.js');
const managers = require('./managers.js');
const cards = require('./cards.js');
const backup = require('./backup.js');
const investors = require('./investors.js');
const refundMigration = require('./refundmigration.js');
const refundCampaign = require('./refundcampaign.js');
const { logFunds } = require('./fundslog.js');
const partnerlog = require('./partnerlog.js');
const logincodes = require('./logincodes.js');

// The "Join" link button under the ad is disabled by request — the ad text
// already carries the invite link. Returns null so the verification replies show
// no button. (Kept as a no-op so both call sites stay unchanged.)
function joinButtonRow() {
    return null;
}

// Short-lived membership cache for AD SELECTION only (deciding which ad to show
// and skipping a server the user is already in). This is the hot path's main cost
// — `isMember` force-fetches Discord every call, and the main loop + the extra-ad
// pick + repeat clicks would otherwise re-check the same (user, guild) many times.
// The CREDITING path keeps the accurate force `isMember`, so nothing is mis-paid;
// a slightly stale selection read at worst shows one extra/fewer ad for <60s.
const _memberCache = new Map();   // "guildId:userId" -> { at, val }
const MEMBER_CACHE_MS = Number(process.env.MEMBER_CACHE_MS) || 60000;
async function isMemberCached(bot, guildId, userId) {
    const key = `${guildId}:${userId}`;
    const c = _memberCache.get(key);
    if (c && Date.now() - c.at < MEMBER_CACHE_MS) return c.val;
    const val = await isMember(bot, guildId, userId).catch(() => null);
    if (val === true || val === false) {                     // never cache a transient null
        if (_memberCache.size > 5000) _memberCache.clear();  // simple unbounded-growth guard
        _memberCache.set(key, { at: Date.now(), val });
    }
    return val;
}

// Given an already-resolved extra pick { campaignId, raw, sponsorGuildId, url },
// stamp its sponsor, record the join intent (so the autojoin sweep credits it if
// they go through) and return the bonus-ad button row. No network calls.
function attachExtraRow(guild, creatorId, userId, extra, placement, channelId) {
    if (!extra || !extra.url) return null;
    try { sponsorshow.stamp(extra.sponsorGuildId); } catch { /* stamping must never break verification */ }
    try {
        autojoin.record({
            userId, cardGuildId: guild.id, roleId: extraad.roleFor(extra.campaignId),
            creatorId, sponsorGuildId: extra.sponsorGuildId, campaignId: extra.campaignId,
            adRaw: extra.raw, channelId: channelId || null, viaExtra: true, placement
        });
    } catch { /* recording must never break verification */ }
    return extraad.row(extra.url);
}

// Find + attach the "EXTRA GWS" bonus-ad button when we DON'T already have a pick
// (the success / retry branches — the first click reuses its main selection pass).
// Uses the cached membership check so it's cheap.
async function buildExtraRow(clients, guild, creatorId, userId, excludeSponsorGuildId, placement, channelId) {
    try {
        const fleet = campaigns.fleetGuildIds(clients);
        if (usertoken.enabled()) { try { for (const g of await usertoken.coveredGuildIds()) fleet.add(g); } catch { /* ignore */ } }
        const extra = await extraad.pick(guild, userId, excludeSponsorGuildId, {
            fleet, isMember: isMemberCached,
            resolveSponsor: (invite) => resolveSponsorPresence(clients, invite),
            creatorId
        });
        return attachExtraRow(guild, creatorId, userId, extra, placement, channelId);
    } catch { return null; }
}

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

// Env-driven presence for EVERY network bot. Edit the variable on Railway → the
// redeploy applies the new status to all bots. Variables:
//   BOT_STATUS       — the status text shown under the bot (empty → no activity)
//   BOT_STATUS_TYPE  — playing | watching | listening | competing | streaming | custom  (default: custom)
//   BOT_PRESENCE     — online | idle | dnd | invisible  (default: online)
//   BOT_STATUS_URL   — stream URL, only used when BOT_STATUS_TYPE=streaming
const presence = require('./presence.js');
const applyBotPresence = presence.applyOne;

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
    ownerId: (process.env.OWNER_ID || (console.warn('[SECURITY] OWNER_ID is not set — falling back to a hardcoded owner id. Set OWNER_ID.'), '743913502997086219')),
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

    const client = new Client({ intents, ...(proxy.restOptions() ? { rest: proxy.restOptions() } : {}) });

    // Gateway diagnostics — surface WHY a bot never reaches READY (disallowed
    // intents = close 4014, bad token = 4004, rate-limit/network otherwise).
    client.on('error', (e) => console.error(`[GW ${botId}] error: ${e?.message || e}`));
    client.on('shardError', (e) => console.error(`[GW ${botId}] shardError: ${e?.message || e}`));
    client.on(Events.ShardDisconnect, (ev) => console.warn(`[GW ${botId}] disconnect code=${ev?.code} reason=${ev?.reason || ''}`));
    client.on(Events.ShardReconnecting, () => console.warn(`[GW ${botId}] reconnecting…`));
    client.on('invalidated', () => console.error(`[GW ${botId}] session invalidated (bad token / kicked)`));

    // Realtime card-deletion detection (only fires on bots with GuildMessages
    // intent — the admin bot). Marks a tracked card deleted the moment its
    // message is removed, and tries to learn who via the audit log. The
    // periodic sweep catches deletions everywhere else.
    client.on(Events.MessageDelete, (msg) => {
        cards.handleMessageDelete(clients, msg).catch((e) => console.error('[CARDS] delete handler:', e.message));
    });

    // Audit: a network bot was added to a server. Filter out gateway
    // availability/startup events by requiring the bot's own join to be fresh,
    // and try to learn WHO invited it from the guild's audit log.
    client.on(Events.GuildCreate, async (guild) => {
        try {
            const joinedAt = guild.members?.me?.joinedTimestamp || 0;
            if (joinedAt && Date.now() - joinedAt > 120000) return; // not a real new join (availability/startup)
            let by = 'discord';
            try {
                const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 6 });
                const entry = logs?.entries?.find((e) => e.target?.id === client.user.id);
                if (entry?.executor?.id) by = entry.executor.id;
            } catch (_) { /* no ViewAuditLog permission */ }
            const cnt = guild.memberCount != null ? ` · ${guild.memberCount.toLocaleString('en-US')} участников` : '';
            auditlog.logAction(by, 'bot.join', `${client.user?.username || botId} → ${guild.name} (${guild.id})${cnt} · https://discord.com/channels/${guild.id}`, `bot.join|${client.user?.id}|${guild.id}`);
        } catch (e) { console.error('[AUDIT] guildCreate:', e.message); }
    });
    // Audit: a network bot was removed from a server (skip transient outages).
    client.on(Events.GuildDelete, (guild) => {
        try {
            if (guild.available === false) return; // outage, not a removal
            const cnt = guild.memberCount != null ? ` · ${guild.memberCount.toLocaleString('en-US')} участников` : '';
            auditlog.logAction('discord', 'bot.leave', `${client.user?.username || botId} ✕ ${guild.name || 'server'} (${guild.id})${cnt} · https://discord.com/channels/${guild.id}`);
        } catch (e) { console.error('[AUDIT] guildDelete:', e.message); }
    });

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
        // Partner portal — a link button, always FIRST under the embed, opening
        // the partner cabinet (Discord-OAuth logs the user in automatically).
        // ADMIN_API_ORIGIN may be a comma-separated list (apex + www) — take the
        // first origin only, otherwise the Link button URL is invalid and Discord
        // rejects the whole /bal reply ("Application did not respond").
        const PORTAL_ORIGIN = (process.env.PARTNER_PORTAL_URL || process.env.ADMIN_API_ORIGIN || 'https://vemoni.info').split(',')[0].trim().replace(/\/+$/, '');
        const PORTAL_URL = PORTAL_ORIGIN + '/partner/';
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Partner portal').setStyle(ButtonStyle.Link).setURL(PORTAL_URL).setEmoji('🔗')
        ));
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
        applyBotPresence(c); // env-driven status for every bot
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
            lotmon.handleMessage(clients, message).catch((e) => console.error('[LOTS]', e.message)); // auction-bid monitoring
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

        // Auction-lot bidding: button opens a modal, modal submit places the bid.
        // Needs no privileged intent, so it runs on whichever bot posted the lot.
        if (interaction.isButton() && interaction.customId.startsWith(lotmon.BID_BUTTON + ':')) {
            return lotmon.openBidModal(interaction).catch((e) => console.error('[LOTS] bid modal:', e.message));
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith(lotmon.BID_MODAL + ':')) {
            return lotmon.handleBidModal(clients, interaction).catch((e) => console.error('[LOTS] bid submit:', e.message));
        }

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

            // Remember which bot this user uses, so payout DMs come from it (and only it)
            const settings = loadJSON('settings.json');
            if (!settings[interaction.user.id]) settings[interaction.user.id] = { advText: '', serverAds: {}, partners: [] };
            settings[interaction.user.id].botId = interaction.client.user.id;
            saveJSON('settings.json', settings);

            // buildCard renders the bespoke Components V2 layout for the one
            // personalized bot and the classic embed for everyone else; the verify
            // button customId (and the whole flow) is identical either way.
            // Apply the guild's template card (if one is marked) so new cards
            // inherit its title/description/button/emoji/colour.
            const tpl = cards.templateForGuild(interaction.guild.id);
            const cardPayload = cards.buildCard(interaction.guild, interaction.user.id, role.id, tpl ? tpl.description : null, interaction.client.user.id, tpl ? tpl.opts : {});
            const sentCard = await interaction.channel.send(cardPayload).catch(() => null);
            // Track the card so it can be listed / repaired / managed remotely
            // from the admin "Экстренно" tab.
            if (sentCard) {
                try {
                    cards.addCard({
                        messageId: sentCard.id, channelId: sentCard.channelId, guildId: interaction.guild.id,
                        creatorId: interaction.user.id, roleId: role.id, botId: interaction.client.user.id,
                        ...(tpl ? tpl.fields : {})
                    });
                    const gc = interaction.guild.memberCount != null ? ` · ${interaction.guild.memberCount.toLocaleString('en-US')} участников` : '';
                    auditlog.logAction(interaction.user.id, 'card.create', `${interaction.guild.name} (${interaction.guild.id})${gc} · #${interaction.channel?.name || sentCard.channelId} · https://discord.com/channels/${interaction.guild.id}/${sentCard.channelId}/${sentCard.id}`, `card.create|${sentCard.id}`);
                } catch (e) { console.error('[CARDS] track error:', e.message); }
            }
            return interaction.editReply({ content: `✅ Verification card created — grants <@&${role.id}>` }).catch(() => null);
        }

        // "Прочитать FaQ" button on the personalized verification card — show the
        // FAQ privately as a Components V2 card (embed v2), like the screenshot.
        if (interaction.isButton() && interaction.customId.startsWith('verif_faq')) {
            return interaction.reply(cards.buildFaqView()).catch(() => null);
        }

        // "Translation" button on a login-code DM — re-render the message in the
        // clicking user's Discord client locale and drop the button.
        if (interaction.isButton() && interaction.customId.startsWith('login_code_tr:')) {
            const code = interaction.customId.split(':')[1] || '';
            return interaction.update({ content: logincodes.renderMessage(code, interaction.locale), components: [] }).catch(() => null);
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

        // Card-specific role is encoded in the button id: "start_verif_guild:<roleId>"
        // Legacy cards without a role fall back to a role named "Verified".
        const idParts = interaction.customId.split(':');
        const roleId = interaction.customId.includes(':') ? (idParts[1] || null) : null;

        // Owner (payout recipient). Classic cards store it in the embed footer;
        // the Components V2 card has no footer, so it's carried as a 3rd button
        // segment, with the tracked card record as a final fallback.
        const footerText = message.embeds[0]?.footer?.text || '';
        const creatorId = footerText.replace('Created by: ', '').trim()
            || idParts[2]
            || cards.getCard(message.id)?.creatorId
            || '';
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
            if (creatorId) try { partnerlog.logEvent(creatorId, { type: 'grant', reason: 'already_verified', userId: user.id, guildId: guild.id, roleId, srcId: `av:${user.id}:${guild.id}:${roleId || ''}` }); } catch { /* logging must never block */ }
            return interaction.reply({ content: "✅ You're already verified", flags: [64] }).catch(() => null);
        }

        // Ack within Discord's 3-second window BEFORE any slow work (invite
        // lookups, big JSON reads, membership fetches) so the user never sees
        // "Interaction failed". We then edit this ephemeral reply.
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: [64] }).catch(() => null);
        }

        const pendingKey = `${user.id}_${guild.id}_${roleId || 'v'}`;
        const _vT0 = Date.now();

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
            const globalOff = Boolean(cfg.adsOff);       // master kill switch — nothing shows, not even the bonus ad
            const adsOff = globalOff || serverOff;        // main ad off (per-server OR global)
            // Track WHY an ad ends up not shown, for the activity log. Seeded from
            // the hard kill switches and refined by the selection below; only used
            // when no ad is ultimately displayed.
            let noAdReason = adsOff ? (serverOff ? 'server_off' : 'ads_off') : '';
            let sawMember = false, sawCapped = false, hadEligible = false, allHiddenHere = false;
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

            // Per-creative join-limit cap: NET verifications (leavers removed by
            // clawback don't count) against the raw ad's limit. Shared helper so
            // both campaigns and house ads apply it identically.
            const limits = loadJSON('adlimits.json', {});
            const capReached = (raw) => {
                const rec = limits[adKeyOf(raw)];
                const cap = Number(rec?.limit) || 0;
                return cap > 0 && joinerCount(verified, adKeyOf(raw), Number(rec?.resetAt) || 0) >= cap;
            };

            // Paid buyer campaigns take priority over house ads. Try the eligible
            // campaigns (already filtered by "Серверы показа"/disabledGuilds,
            // remaining>0, bot on sponsor) in weighted-random order and pick the
            // first that is FULLY showable — not capped, invite resolves to a
            // join-checkable server that isn't THIS guild — AND whose sponsor the
            // user isn't already a member of. Every check that fails SKIPS to the
            // next eligible campaign, so one campaign being capped / unresolvable /
            // already-joined never suppresses another available one. Ad-free is
            // only reached when NO eligible campaign is showable.
            let campaignPicked = false;
            let firstExtra = null;   // the "EXTRA GWS" bonus ad, reused from the main selection pass (no extra network calls)
            // Runs whenever the master switch is off — even when THIS server turned
            // ads off (serverOff). The main ad stays suppressed under serverOff
            // (guarded below), but the bonus EXTRA ad ignores the per-server switch
            // and still shows, so we still do the selection pass to find it.
            if (!globalOff) {
                try {
                    // Resolve a candidate's sponsor (network) → { text, raw, sp }
                    // or null (self-target / unresolvable). The cheap cap check is
                    // done in the loop BEFORE this, so capped campaigns are skipped
                    // without a network call.
                    const resolveCand = async (cand) => {
                        const raw = cand.invite;
                        const text = applyTemplate(guild.id, raw);
                        const sp = await resolveSponsorPresence(clients, text).catch(() => null);
                        if (!sp || sp.guildId === guild.id) return null;
                        return { text, raw, sp };
                    };
                    const fleet = campaigns.fleetGuildIds(clients);
                    // Reserve (invisible): also treat the personal account's servers
                    // as join-checkable so a campaign with no bot but where the owner
                    // joined by request still shows and verifies.
                    if (usertoken.enabled()) { try { for (const g of await usertoken.coveredGuildIds()) fleet.add(g); } catch { /* ignore */ } }
                    const eligibleHere = campaigns.eligibleForGuild(guild.id, verified, fleet);
                    if (eligibleHere.length) hadEligible = true;
                    let ordered = campaigns.weightedOrder(eligibleHere);
                    // Partner per-server controls (set in the partner cabinet by
                    // the server owner = creatorId), keyed by THIS display guild:
                    //  • hiddenByGuild — campaigns the partner hid on this server.
                    //    They are a MAIN-ad control only: the main pick skips them,
                    //    but they STAY in the pool so the bonus EXTRA ad — which
                    //    ignores the per-server hide — can still surface them.
                    //  • priorityByGuild — one campaign pinned to show FIRST here;
                    //    moved to the front of the weighted order. It's only a
                    //    preference — the loop below still skips it if it's capped,
                    //    self-target, unresolvable, or the user already joined its
                    //    sponsor, so a stale/finished priority never suppresses
                    //    other ads. With neither set, the normal weighted
                    //    smart-distribution order stands unchanged.
                    const pctl = settings[creatorId] || {};
                    const hiddenHere = pctl.hiddenByGuild?.[guild.id];
                    const isHidden = (id) => Array.isArray(hiddenHere) && hiddenHere.includes(id);
                    if (Array.isArray(hiddenHere) && hiddenHere.length && ordered.length && ordered.every((c) => isHidden(c.id))) allHiddenHere = true; // partner hid every available ad here → no MAIN ad (extra may still show one)
                    // Priority pin: the partner's own per-server pin wins; where the
                    // partner set none, a service admin/manager's GLOBAL pin (set from
                    // the orders page) applies. Either way it only moves the campaign to
                    // the front — the loop below still skips it if unshowable.
                    const globalPrioId = (() => { const sc = loadJSON('siteconfig.json', {}); const v = sc && sc.adminPriorityCampaignId; return (typeof v === 'string' && v) ? v : null; })();
                    const prioId = pctl.priorityByGuild?.[guild.id] || globalPrioId;
                    if (prioId) {
                        const pi = ordered.findIndex((c) => c.id === prioId);
                        if (pi > 0) { const [pc] = ordered.splice(pi, 1); ordered.unshift(pc); }
                    }
                    // One pass collects the showable candidates (resolved, not a
                    // known member) in queue order, so we pick BOTH the main ad and
                    // the "EXTRA GWS" bonus ad from it — no second network scan.
                    // Cached membership keeps the whole loop cheap.
                    let checks = 0;
                    const _selDeadline = Date.now() + 4000;                 // cap TOTAL invite-resolution time
                    const cands = [];   // { cand, ad, definite, hidden }
                    for (const cand of ordered) {
                        if (capReached(cand.invite)) { sawCapped = true; continue; } // cheap, no network → unbounded
                        if (checks >= 10) break;                           // bound the network calls
                        if (Date.now() > _selDeadline) break;              // slow/rate-limited resolves must never freeze verification
                        checks++;
                        const ad = await resolveCand(cand);
                        if (!ad) continue;                                 // unresolvable / self → try next
                        const m = await isMemberCached(ad.sp.bot, ad.sp.guildId, user.id);
                        if (m === true) { sawMember = true; continue; }    // already a member → try next
                        cands.push({ cand, ad, definite: m === false, hidden: isHidden(cand.id) }); // not a member (or uncertain) → showable
                        if (cands.filter((c) => c.definite && !c.hidden).length >= 2) break; // enough NON-HIDDEN for main + extra
                    }
                    // main = first definite non-member, else first uncertain — from
                    // NON-HIDDEN candidates only (the main ad respects the hide).
                    const mainCands = cands.filter((c) => !c.hidden);
                    const pick = mainCands.find((c) => c.definite) || mainCands[0] || null;
                    // extra = a showable campaign OTHER than the main ad's sponsor,
                    // drawn from the FULL pool (hidden included — the bonus ad ignores
                    // the per-server hide). Under serverOff no main ad is shown, so any
                    // showable campaign qualifies.
                    const shownMain = serverOff ? null : pick;
                    const differsFromMain = (c) => !shownMain || (c.cand.id !== shownMain.cand.id && c.ad.sp.guildId !== shownMain.ad.sp.guildId);
                    const extraPickC = cands.find((c) => c.definite && differsFromMain(c)) || cands.find((c) => differsFromMain(c)) || null;
                    // The main ad is suppressed on a server whose owner turned ads
                    // off — apply the pick only when ads are on for this server.
                    if (pick && !serverOff) {
                        // Carry the resolved sponsor guild so click 2 can re-find
                        // the bot WITHOUT re-resolving the invite (which could fail
                        // transiently and wrongly log the join as ad-free).
                        latest = { text: pick.ad.text, ts: Date.now(), raw: pick.ad.raw, campaignId: pick.cand.id, sponsorGuildId: pick.ad.sp.guildId };
                        campaignPicked = true;
                        // Stamp "ad live" for the leave-clawback opt-out (joincheck.js).
                        try { sponsorshow.stamp(pick.ad.sp.guildId); } catch { /* stamping must never break verification */ }
                    }
                    // Carry the bonus ad picked in the SAME pass — no second scan.
                    if (extraPickC) firstExtra = { campaignId: extraPickC.cand.id, raw: extraPickC.ad.raw, sponsorGuildId: extraPickC.ad.sp.guildId, url: extraad.inviteUrl(extraPickC.ad.raw) };
                } catch (e) { console.error('[VERIFY] selection error u=' + user.id, e && e.message); }
            }

            // House ads (owner/partner advText) weren't validated above — apply
            // the same cap + resolvable-sponsor / not-self / not-already-member
            // checks to them. A picked campaign is already fully validated here.
            if (latest && !campaignPicked && capReached(latest.raw)) { latest = null; sawCapped = true; }
            if (latest && !campaignPicked && (Date.now() - _vT0) < 4000) {
                const sp = await resolveSponsorPresence(clients, latest.text).catch(() => null);
                if (!sp || sp.guildId === guild.id) {
                    latest = null;
                } else if (await isMemberCached(sp.bot, sp.guildId, user.id) === true) {
                    // User is already a member of the house ad's sponsor — showing
                    // it can't drive a real join and would pay the partner for a
                    // pre-existing member. Same rule campaigns already follow.
                    latest = null;
                    sawMember = true;
                } else {
                    latest.sponsorGuildId = sp.guildId;
                    try { sponsorshow.stamp(sp.guildId); } catch { /* stamping must never break verification */ }
                }
            }

            // Finalize WHY no ad is shown (only when nothing was displayed and a
            // hard kill switch didn't already set it). Most-actionable reason wins:
            // the partner hid everything here > the user is already in the sponsors
            // > an ad hit its cap > there simply was no inventory > generic.
            if (!latest && !noAdReason) {
                noAdReason = allHiddenHere ? 'all_hidden'
                    : sawMember ? 'already_member'
                    : sawCapped ? 'capped'
                    : (hadEligible || candidates.length) ? 'no_ad'
                    : 'no_inventory';
            }

            // No ad to show → send the owner-configured "заглушка" (fallback),
            // or a built-in default. Verification still proceeds ad-free.
            const responseText = latest?.text
                || ((cfg.fallbackText && String(cfg.fallbackText).trim()) || 'Great, now click again to open access to the server!');

            // Only clicks that actually display an ad qualify for balance accrual.
            // Keep the resolved sponsor guild so the second click doesn't re-resolve.
            // noAdReason rides along so the completion click can log the specific
            // cause in the partner activity log.
            pendingVerification.set(pendingKey, { adShown: Boolean(latest), adShownAt: Date.now(), adText: latest?.text || '', adRaw: latest?.raw || '', campaignId: latest?.campaignId || '', sponsorGuildId: latest?.sponsorGuildId || '', noAdReason: latest ? '' : noAdReason });
            // 30-min window: a user who reads the ad and takes a while to join the
            // sponsor still completes on the SAME pending entry (with adShown), so
            // the join isn't re-selected into an ad-free verification.
            setTimeout(() => pendingVerification.delete(pendingKey), 30 * 60 * 1000);

            // Bonus "EXTRA GWS" ad — reuse the pick from the main selection pass
            // above (no second network scan). record + stamp happen inside.
            const firstJoinRow = joinButtonRow(latest?.raw, responseText);
            const extraRow = attachExtraRow(guild, creatorId, user.id, firstExtra, 'pre', interaction.channelId);
            const firstComponents = [firstJoinRow, extraRow].filter(Boolean);

            // Send the reply FIRST, then do the local bookkeeping (funnel click +
            // autojoin record) off the response path so they don't add to the
            // "thinking" time.
            const firstReply = interaction.editReply({ content: responseText, components: firstComponents }).catch(() => null);
            try { cards.trackClick(guild.id, roleId, creatorId, user.id); } catch (e) { /* stats must never break verification */ }
            if (latest && latest.sponsorGuildId && roleId) {
                try {
                    autojoin.record({
                        userId: user.id, cardGuildId: guild.id, roleId, creatorId,
                        sponsorGuildId: latest.sponsorGuildId, campaignId: latest.campaignId || '',
                        adRaw: latest.raw || '', channelId: interaction.channelId || null
                    });
                } catch (e) { /* recording must never break verification */ }
            }
            return firstReply;
        }

        const pending = pendingVerification.get(pendingKey);

        // Join-check mode: if the ad points to a server one of our bots is on, the
        // user must actually be a member before we verify them. Until they join, every
        // repeat click just re-shows the ad — no role, no payout. ($5/100, see joincheck.js.)
        // Use the sponsor resolved on click 1 (find the bot by the stored guild
        // id) instead of re-resolving the invite — a transient re-resolution
        // failure here would drop the payout and mislabel the join as ad-free.
        // Fall back to a fresh resolve only if the stored guild is unavailable.
        let sponsor = null;
        if (roleId && pending?.adShown) {
            if (pending.sponsorGuildId) {
                const bot = clients.find((c) => c.guilds.cache.has(pending.sponsorGuildId));
                sponsor = bot ? { guildId: pending.sponsorGuildId, bot } : null;
            }
            if (!sponsor) sponsor = await resolveSponsorPresence(clients, pending.adText).catch(() => null);
        }
        if (sponsor) {
            const joined = await isMember(sponsor.bot, sponsor.guildId, user.id);
            if (joined !== true) {
                const retryJoinRow = joinButtonRow(pending.adRaw, pending.adText);
                // Distinguish "not a member yet" (false) from "couldn't check right
                // now" (null): the transient case must NOT read as "join first" (it
                // misleads a user who already joined). We still don't grant access
                // without a confirmed join, but the message tells them to retry.
                const content = joined === null
                    ? '⏳ Не удалось проверить, что ты на сервере — попробуй ещё раз через минуту.'
                    : (pending.adText || 'Please join the server first, then click again.');
                // Keep the bonus "EXTRA GWS" ad on repeat "please join" prompts too,
                // excluding the sponsor they're being asked to join. Still 'pre'.
                const retryExtraRow = await buildExtraRow(clients, guild, creatorId, user.id, sponsor.guildId, 'pre', interaction.channelId).catch(() => null);
                const retryComponents = [retryJoinRow, retryExtraRow].filter(Boolean);
                return interaction.editReply({ content, components: retryComponents }).catch(() => null);
            }
        }

        // Same bonus "EXTRA GWS" ad under the success message (excluding the sponsor
        // they just joined). 'post' = shown after verification.
        const successExtraRow = await buildExtraRow(clients, guild, creatorId, user.id, sponsor?.guildId || pending?.sponsorGuildId, 'post', interaction.channelId).catch(() => null);
        await interaction.editReply({ content: '✅ Success! Access granted', components: successExtraRow ? [successExtraRow] : [] }).catch(() => null);

        try {
            if (verifiedRole?.editable) await member.roles.add(verifiedRole).catch(() => null);
            if (unverifiedRole?.editable && member.roles.cache.has(unverifiedRole.id)) {
                await member.roles.remove(unverifiedRole).catch(() => null);
            }

            // Reload verified.json FRESH here: it was first read many awaits ago
            // (role fetches, membership checks), during which a concurrent
            // verification may have saved new entries. From this line to the
            // saveJSON below there are NO awaits, so filter→push→save is atomic
            // and can't clobber a concurrent verification's entry (which the
            // stale snapshot would have silently dropped).
            const verifiedFresh = loadJSON('verified.json', []);
            const updated = (Array.isArray(verifiedFresh) ? verifiedFresh : []).filter(u => !(u.id === user.id && u.guildId === guild.id && (u.roleId || null) === roleId));

            // If this server still has outstanding investor invites, this paid
            // join fills one — its share split already happened at the investor
            // buy-in, so we skip payShares below (checked before the new join is
            // added, so "outstanding" is the count BEFORE this join).
            let investorOwnedJoin = false;
            try { investorOwnedJoin = investors.serverOutstanding(guild.id, updated) > 0; } catch { /* never block verification */ }

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
            else if (roleId) { rec.noAd = true; if (!isDupJoin && pending?.noAdReason) rec.noAdReason = pending.noAdReason; }
            updated.push(rec);
            saveJSON('verified.json', updated);
            pendingVerification.delete(pendingKey);

            // Partner activity log: record the verification grant. Paid grants are
            // logged in the credit branch below (with the amount); ad-free and
            // duplicate-join grants are logged here with their reason.
            if (roleId && !adKey) {
                // no_ad has a stable source (the verified.json entry, keyed by
                // user+guild+role) so backfill and live logging dedup to one;
                // dup_join is live-only and carries no srcId.
                const reason = isDupJoin ? 'dup_join' : (pending?.noAdReason || 'no_ad');
                const srcId = isDupJoin
                    ? (sponsor ? `dup:${user.id}:${sponsor.guildId}` : undefined)
                    : `v:${user.id}:${guild.id}:${roleId || ''}`;
                // Sponsor (where the user joined/was already a member) — only known
                // when an ad resolved to a sponsor server.
                const sponsorGuildId = sponsor ? sponsor.guildId : undefined;
                try { partnerlog.logEvent(creatorId, { type: 'grant', reason, userId: user.id, guildId: guild.id, roleId, sponsorGuildId, srcId }); } catch { /* logging must never block verification */ }
            }

            // If this verification just filled the creative's join-limit,
            // ping the ops channel with the ad text and the final counter.
            if (adKey) maybeNotifyAdComplete(clients, adKey, updated).catch(() => null);

            // A verification just landed on this partner's card → re-check the
            // PARTNER's (card owner's) hub-role eligibility (active card + ≥1/day).
            syncHubMember(clients, creatorId).catch(() => null);

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
                const econ = managers.joinEconomics(camp, sharesMod.REVENUE_PER_JOIN);
                // Confirmed member of the sponsor server: pay the join-check rate,
                // reversible on leave (role + payout), see joincheck.js.
                const credit = creditJoin(creatorId, sponsor.guildId, user.id, guild.id, roleId, channelId,
                    { revenue: econ.revenue, managerId: econ.managerId });
                if (credit.duplicate) {
                    // Lost a race to another concurrent verify of the same (user,
                    // sponsor): it already credited. Nothing more to pay — log it
                    // as a duplicate grant, not a paid one.
                    try { partnerlog.logEvent(creatorId, { type: 'grant', reason: 'dup_join', userId: user.id, guildId: guild.id, roleId, sponsorGuildId: sponsor.guildId, srcId: sponsor ? `dup:${user.id}:${sponsor.guildId}` : undefined }); } catch { /* never block */ }
                } else {
                    const amount = credit.amount;
                    try { partnerlog.logEvent(creatorId, { type: 'grant', reason: 'paid', amount, userId: user.id, guildId: guild.id, roleId, sponsorGuildId: sponsor.guildId, srcId: credit.linkId }); } catch { /* never block */ }
                    await logFunds(clients, {
                        type: 'credit', creatorId, userId: user.id, guildId: guild.id, channelId,
                        amount, sponsorGuildId: sponsor.guildId,
                        reason: 'Join verified — member joined the sponsor server'
                    });
                    // Split this join's service profit (revenue − partner payout −
                    // acquiring) across shareholders — manager sales just use the
                    // lower revenue. Skip for investor-owned joins: their revenue
                    // funds the investor's return and the share split was already
                    // done at buy-in (no double-counting).
                    if (!investorOwnedJoin) await payShares(clients, amount, { revenuePerJoin: econ.revenue }).catch(() => null);
                    await maybeAutoWithdraw(clients, creatorId);
                    if (credit.referrerId) await maybeAutoWithdraw(clients, credit.referrerId).catch(() => null); // referral bonus credited at join
                }
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

// Verification cards: detect ones deleted from their channel and move them to
// the "deleted" list (keeping their stats).
cards.startCardSweep(clients);
cards.startAutoReset(clients);
cards.startAlwaysBottom(clients);

// Investors: refund undelivered invites when a server loses its bot / last card.
investors.startInvestSweep(clients);

// One-time: seed the partner activity log from existing joinlinks/verified so
// it isn't empty for history that predates the log (idempotent, marker-guarded).
partnerlog.backfillIfNeeded();

// One-time: seed the admin audit log with historical card create/delete (from
// cards.json) and every server a bot is currently on. Delayed so the bots are
// logged in and their guild caches (names + member counts) are populated.
setTimeout(() => { try { auditlog.backfillOnce(clients, cards); } catch (e) { console.error('[AUDIT] backfill:', e.message); } }, 40 * 1000);

// Re-arm close timers for any auction lots that were still active before a restart.
setTimeout(() => lotmon.rescheduleAll(clients), 30 * 1000);

// Reserve (selfbot): start the gateway connection(s) when enabled, and route
// real-time member leaves into the same clawback path the sweep uses.
// Wired unconditionally: the token list / gateway toggle can be changed from the
// admin panel at runtime, and start() is a no-op while the reserve is off.
reservegw.onLeave((guildId, userId) => { handleMemberLeave(clients, guildId, userId).catch(() => null); });
reservegw.start();

// Settle (or refund) LTC auto-payouts NOWPayments has finished/rejected.
startLtcPayoutSweep(clients);

// Auto-pause campaigns whose sponsor we can no longer verify joins on (bot kicked/
// banned, selfbot removed/banned, etc.), and auto-resume when access returns.
function startCoverageSweep() {
    const every = Number(process.env.COVERAGE_SWEEP_MS) || 3 * 60 * 1000;
    const tick = async () => {
        try {
            const covered = campaigns.fleetGuildIds(clients);
            if (usertoken.enabled()) { try { for (const g of await usertoken.coveredGuildIds()) covered.add(g); } catch { /* keep bots-only */ } }
            const r = await campaigns.autoPauseUncovered(clients, covered);
            if (r.paused || r.resumed) console.log(`[COVERAGE] sweep — auto-paused ${r.paused}, resumed ${r.resumed}`);
        } catch (e) { console.error('[COVERAGE] sweep error:', e.message); }
    };
    setInterval(tick, every);
    setTimeout(tick, 90 * 1000);   // after the fleet's guild caches have filled
    console.log(`[COVERAGE] verifier-coverage sweep every ${Math.round(every / 60000)}m`);
}
startCoverageSweep();

// Auto-credit joins from users who first-clicked, joined the sponsor, but never
// clicked "verify" a second time.
autojoin.startAutoJoinSweep(clients);

// Journal ads-on/off stretches so the throughput estimate can skip the downtime.
perf.startPerfSampler();

// Reserve status — log once shortly after startup so it's clear whether the
// reserve is active, in which mode (gateway/REST), and how many guilds it covers.
setTimeout(async () => {
    try {
        if (!usertoken.enabled()) { console.log('[USERTOKEN] reserve disabled (no USER_TOKEN set)'); return; }
        const mode = (reservegw.enabled() && reservegw.ready()) ? 'gateway' : 'REST';
        const g = await usertoken.coveredGuildIds();
        console.log(`[USERTOKEN] reserve active (${mode}) — ${g.size} guild(s) covered`);
    } catch (e) { console.error('[USERTOKEN] status check failed:', e.message); }
}, 25 * 1000);

// Data backups: rolling local snapshots + off-site copies to a Discord channel.
backup.startBackupSweep(clients);

// One-time: refund clawbacks that fired while the sponsor's ad was off (the
// old opt-out was keyed by the wrong guild). Guarded by a marker; delayed so
// the bots are logged in when it posts the summary.
setTimeout(() => refundMigration.runOnce(clients).catch((e) => console.error('[REFUND]', e.message)), 45 * 1000);
// Return clawbacks charged for joins whose campaign had already finished (the ad
// ERA fix in sponsorshow.js prevents new ones).
setTimeout(() => refundCampaign.runOnce(clients).catch((e) => console.error('[REFUND]', e.message)), 50 * 1000);

// Uptime monitoring: alert to alertChannel() when a bot goes offline / recovers.
const alertChannel = () => (process.env.ALERT_CHANNEL || '').trim();
async function sendAlert(text) {
    if (!alertChannel()) return;
    const bot = clients.find((c) => c.user?.id === config.adminBotId && c.isReady?.()) || clients.find((c) => c.isReady?.());
    if (!bot) return;
    const ch = bot.channels.cache.get(alertChannel()) || await bot.channels.fetch(alertChannel()).catch(() => null);
    if (ch) ch.send({ content: text }).catch(() => null);
}
const botOnlineState = new Map();
function startHealthMonitor() {
    setInterval(() => {
        for (const c of clients) {
            const id = c.user?.id;
            if (!id) continue;
            const on = Boolean(c.isReady?.());
            const prev = botOnlineState.get(id);
            if (prev === undefined) { botOnlineState.set(id, on); continue; }
            if (prev && !on) { botOnlineState.set(id, false); console.warn(`[HEALTH] ${c.user?.tag || id} OFFLINE`); sendAlert(`🔴 Бот \`${c.user?.tag || id}\` ушёл в офлайн`); }
            else if (!prev && on) { botOnlineState.set(id, true); console.log(`[HEALTH] ${c.user?.tag || id} recovered`); sendAlert(`🟢 Бот \`${c.user?.tag || id}\` снова онлайн`); }
        }
    }, 60 * 1000);
    console.log(`[HEALTH] monitor every 60s${alertChannel() ? '' : ' (alerts OFF — set alertChannel())'}`);
}
startHealthMonitor();
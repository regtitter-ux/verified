const { PermissionsBitField } = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');
const { createApiKey } = require('./api.js');
const { applyTemplate } = require('./adtemplate.js');

async function handleCommands(message, config) {
    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && message.author.id !== config.ownerId) {
        return;
    }

    if (command === 'stat') {
        const stats = loadJSON('verified.json', []);
        const entries = Array.isArray(stats) ? stats : [];
        const userEntries = entries.filter(u => u.creatorId === message.author.id || message.author.id === config.ownerId);

        const grouped = {};
        for (const u of userEntries) {
            (grouped[u.guildId] ||= []).push(u);
        }

        if (Object.keys(grouped).length === 0) {
            return message.reply("❌ You don't have any verification statistics yet.");
        }

        const now = Date.now();
        let resp = '📊 **Your verification statistics:**\n\n';

        for (const [gid, list] of Object.entries(grouped)) {
            const name = message.client.guilds.cache.get(gid)?.name || 'Unknown Server';
            const countH = list.filter(u => u.timestamp > now - 3600000).length;
            const countD = list.filter(u => u.timestamp > now - 86400000).length;
            const countW = list.filter(u => u.timestamp > now - 604800000).length;
            const countM = list.filter(u => u.timestamp > now - 2592000000).length;

            resp += `🏰 **${name}** (${gid})\n`;
            resp += `└ Hour: \`${countH}\` | Day: \`${countD}\` | 7 Days: \`${countW}\` | Month: \`${countM}\` | Total: **${list.length}**\n\n`;
        }

        message.reply(resp);
    } else if (command === 'part') {
        const settings = loadJSON('settings.json');
        const userId = message.author.id;
        const target = message.mentions.users.first();

        if (!target) {
            return message.reply('❌ Please mention a user: `!part @user`');
        }

        if (target.id === userId) {
            return message.reply('❌ You cannot add yourself as a partner.');
        }

        if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };
        if (!Array.isArray(settings[userId].partners)) settings[userId].partners = [];

        const idx = settings[userId].partners.indexOf(target.id);
        if (idx === -1) {
            settings[userId].partners.push(target.id);
            saveJSON('settings.json', settings);
            message.reply(`✅ <@${target.id}> has been added as your partner.`);
        } else {
            settings[userId].partners.splice(idx, 1);
            saveJSON('settings.json', settings);
            message.reply(`✅ <@${target.id}> has been removed from your partners.`);
        }
    } else if (command === 'adv3') {
        // Only the bot owner may manage ads.
        if (message.author.id !== config.ownerId) {
            return message.reply('❌ Only the bot owner can set ads.');
        }

        const settings = loadJSON('settings.json');
        const userId = message.author.id;
        const now = Date.now();

        if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };

        // Optional leading server id; the rest is either a bare sponsor link (filled
        // into the {link} slot of the ad-text template) or literal ad text.
        const gid = /^\d{17,20}$/.test(args[0]) ? args.shift() : null;
        const finalText = applyTemplate(gid, args.join(' '));
        const preview = finalText ? `\n\`\`\`\n${finalText.slice(0, 500)}\n\`\`\`` : '';

        if (gid) {
            // Owner-only command — the owner may set an ad for any server,
            // including ones where they don't have administrator permissions.
            settings[userId].serverAds[gid] = finalText;
            settings[userId].serverAdsAt ||= {};
            settings[userId].serverAdsAt[gid] = now;
            saveJSON('settings.json', settings);
            message.reply(`✅ Ad for server \`${gid}\` has been updated in your network!${preview}`);
        } else {
            settings[userId].advText = finalText;
            settings[userId].advTextAt = now;
            settings[userId].serverAds = {};
            settings[userId].serverAdsAt = {};
            saveJSON('settings.json', settings);
            message.reply(`✅ Your global advertisement has been updated!${preview}`);
        }
    } else if (command === 'apikey') {
        // Owner-only: manage partner API keys (each key maps to a user's balance).
        if (message.author.id !== config.ownerId) {
            return message.reply('❌ Only the bot owner can manage API keys.');
        }
        const keys = loadJSON('apikeys.json');
        const sub = (args.shift() || '').toLowerCase();

        if (sub === 'new') {
            const uid = args.shift();
            if (!/^\d{17,20}$/.test(uid || '')) {
                return message.reply('❌ Usage: `!apikey new <userId> [name]`');
            }
            const name = args.join(' ');
            const key = createApiKey(uid, name);
            const dmText =
                `🔑 **API key** for <@${uid}> (\`${uid}\`)${name ? ` — ${name}` : ''}\n` +
                `\`\`\`\n${key}\n\`\`\`\n` +
                `Header: \`Authorization: Bearer ${key}\`\nKeep it secret. Revoke with \`!apikey revoke <key>\`.`;
            const sent = await message.author.send(dmText).then(() => true).catch(() => false);
            return message.reply(sent
                ? '✅ API key created and sent to your DMs.'
                : `✅ API key created (couldn't DM you):\n\`${key}\``);
        }
        if (sub === 'list') {
            const entries = Object.entries(keys);
            if (!entries.length) return message.reply('No API keys yet.');
            const lines = entries.map(([k, v]) =>
                `• \`${k.slice(0, 6)}…${k.slice(-4)}\` → <@${v.userId}>${v.name ? ` (${v.name})` : ''}`);
            return message.reply(lines.join('\n').slice(0, 1900));
        }
        if (sub === 'revoke') {
            const k = args.shift();
            if (!k || !keys[k]) return message.reply('❌ Key not found. Usage: `!apikey revoke <full-key>`');
            delete keys[k];
            saveJSON('apikeys.json', keys);
            return message.reply('✅ API key revoked.');
        }
        return message.reply('Usage: `!apikey new <userId> [name]` · `!apikey list` · `!apikey revoke <key>`');
    }
}

module.exports = { handleCommands };

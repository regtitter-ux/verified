const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');

async function handleCommands(message, config) {
    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && message.author.id !== config.ownerId) {
        return;
    }

    if (command === 'v3') {
        const icon = message.guild.iconURL({ dynamic: true });

        const embed = new EmbedBuilder()
            .setAuthor({ name: message.guild.name, iconURL: icon })
            .setTitle('Get verified!')
            .setDescription('To gain full access to the server, you must complete verification\nClick the button')
            .setThumbnail(icon)
            .setColor('#5865F2')
            .setFooter({ text: `Created by: ${message.author.id}` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('start_verif_guild')
                .setLabel('Start Verification')
                .setEmoji('🔐')
                .setStyle(ButtonStyle.Primary)
        );

        await message.channel.send({ embeds: [embed], components: [row] });
        message.delete().catch(() => null);
    } else if (command === 'stat') {
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
        const settings = loadJSON('settings.json');
        const userId = message.author.id;

        if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };

        if (/^\d{17,20}$/.test(args[0])) {
            const gid = args.shift();
            const targetGuild = message.client.guilds.cache.get(gid);

            if (targetGuild) {
                const memberInTarget = await targetGuild.members.fetch(userId).catch(() => null);
                if (!memberInTarget || !memberInTarget.permissions.has(PermissionsBitField.Flags.Administrator)) {
                    return message.reply('❌ You do not have administrator permissions on the specified server.');
                }
            }

            settings[userId].serverAds[gid] = args.join(' ');
            saveJSON('settings.json', settings);
            message.reply(`✅ Ad for server \`${gid}\` has been updated in your network!`);
        } else {
            settings[userId].advText = args.join(' ');
            settings[userId].serverAds = {};
            saveJSON('settings.json', settings);
            message.reply('✅ Your global advertisement has been updated!');
        }
    }
}

module.exports = { handleCommands };

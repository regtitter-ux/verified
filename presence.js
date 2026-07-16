// Bot presence, driven by BOT_STATUS / BOT_STATUS_TYPE / BOT_PRESENCE /
// BOT_STATUS_URL. Read from the env each time so a change in the admin panel can
// be re-applied on Save (see the config-save hook in api.js) without a restart.
const { ActivityType } = require('discord.js');

function applyOne(c) {
    try {
        if (!c || !c.user) return;
        const text = (process.env.BOT_STATUS || '').trim();
        const status = ['online', 'idle', 'dnd', 'invisible'].includes((process.env.BOT_PRESENCE || '').toLowerCase())
            ? process.env.BOT_PRESENCE.toLowerCase() : 'online';
        const typeMap = {
            playing: ActivityType.Playing, watching: ActivityType.Watching, listening: ActivityType.Listening,
            competing: ActivityType.Competing, streaming: ActivityType.Streaming, custom: ActivityType.Custom
        };
        const type = typeMap[(process.env.BOT_STATUS_TYPE || 'custom').toLowerCase()] ?? ActivityType.Custom;
        const opts = { status, activities: [] };
        if (text) {
            const act = { name: text, type };
            if (type === ActivityType.Custom) act.state = text;          // custom status renders the `state`
            if (type === ActivityType.Streaming) act.url = process.env.BOT_STATUS_URL || 'https://twitch.tv/vemoni';
            opts.activities = [act];
        }
        c.user.setPresence(opts);
    } catch (e) { console.error('[PRESENCE]', e.message); }
}

function applyAll(clients) {
    for (const c of (Array.isArray(clients) ? clients : [])) applyOne(c);
}

module.exports = { applyOne, applyAll };

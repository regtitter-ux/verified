// Who handles the bot's service jobs — posting logs, backups, ad-complete /
// refund / new-order notifications, and hub-role ops. These used to be pinned to
// the admin bot, but ANY bot that's on the target server can do them. So we pick a
// RANDOM ready bot there: the job isn't tied to one bot that might go down, and it
// spreads across the fleet. If the admin bot dies, the rest just keep posting.

const isReady = (c) => c && (typeof c.isReady === 'function' ? c.isReady() : Boolean(c.user));
const readyBots = (clients) => (Array.isArray(clients) ? clients : []).filter(isReady);
const pickRandom = (arr) => (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : null;

// A random ready bot that's a member of `guildId` (or null). For guild-scoped
// work like hub-role management.
function guildBot(clients, guildId) {
    const g = String(guildId || '');
    return pickRandom(readyBots(clients).filter((c) => g && c.guilds?.cache?.has(g))) || null;
}

// Resolve the channel object to post into, via a RANDOM ready bot that can see
// it (is in that guild). Falls back to fetching the channel with any random ready
// bot. Returns null when nothing can reach it.
async function posterChannel(clients, channelId) {
    const cid = String(channelId || '');
    if (!cid) return null;
    const bots = readyBots(clients);
    const bot = pickRandom(bots.filter((c) => c.channels?.cache?.has(cid)));
    if (bot) return bot.channels.cache.get(cid) || null;
    const any = pickRandom(bots);
    return any ? await any.channels.fetch(cid).catch(() => null) : null;
}

module.exports = { readyBots, guildBot, posterChannel };

// Custom emoji + sticker catalog from the servers our fleet bots are on.
//
// Ported from vibecheckbot's emoji catalog, but optimized for THIS stack: the
// vibecheckbot version had to hit Discord's REST (/guilds/{id}/emojis + /stickers)
// per guild, paced + persisted so it survived restarts. Here the fleet is
// discord.js gateway clients, so every guild's emojis and stickers are ALREADY in
// memory (guild.emojis.cache / guild.stickers.cache) — zero REST, instant build.
// We still memoize with a short TTL and cap to the largest guilds so a huge fleet
// can't blow up the payload, grouped by guild exactly like the original picker wants.
const CDN = 'https://cdn.discordapp.com';
const TTL = 5 * 60_000;
const MAX_GUILDS = Number(process.env.EMOJI_CATALOG_GUILDS) || 150;

const emojiUrl = (id, animated) => `${CDN}/emojis/${id}.${animated ? 'gif' : 'png'}?size=48&quality=lossless`;
const stickerUrl = (id, format) => `${CDN}/stickers/${id}.${Number(format) === 4 ? 'gif' : 'png'}`; // 1=PNG,2=APNG,4=GIF

let cache = null;
let builtAt = 0;

function build(clients) {
    const byGuild = new Map(); // guildId → { head, emojis[], stickers[] } (first bot that sees the guild wins)
    for (const c of Array.isArray(clients) ? clients : []) {
        const guilds = c && c.guilds && c.guilds.cache;
        if (!guilds) continue;
        for (const g of guilds.values()) {
            if (byGuild.has(g.id)) continue;
            const emojis = [...(g.emojis && g.emojis.cache ? g.emojis.cache.values() : [])]
                .filter((e) => e.id && e.available !== false)
                .map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, url: emojiUrl(e.id, e.animated) }));
            const stickers = [...(g.stickers && g.stickers.cache ? g.stickers.cache.values() : [])]
                .filter((s) => s.id && [1, 2, 4].includes(Number(s.format)))
                .map((s) => ({ id: s.id, name: s.name, format: Number(s.format), url: stickerUrl(s.id, s.format) }));
            if (!emojis.length && !stickers.length) continue;
            // Build the icon URL straight from the cached hash (always a static png — animated
            // a_ icons have a flaky .gif asset). More reliable than iconURL(), which returned null.
            let guildIcon = null;
            try {
                if (g.icon) guildIcon = `${CDN}/icons/${g.id}/${g.icon}.png?size=48`;
                else if (typeof g.iconURL === 'function') guildIcon = g.iconURL({ size: 48, extension: 'png', forceStatic: true }) || null;
            } catch (_) {}
            byGuild.set(g.id, {
                head: { guildId: g.id, guildName: g.name || 'Server', guildIcon },
                memberCount: g.memberCount || 0,
                emojis, stickers,
            });
        }
    }
    // Largest guilds first, capped — the picker groups by server, so we keep the group shape.
    const top = [...byGuild.values()].sort((a, b) => b.memberCount - a.memberCount).slice(0, MAX_GUILDS);
    const emojis = top.filter((g) => g.emojis.length).map((g) => ({ ...g.head, items: g.emojis }));
    const stickers = top.filter((g) => g.stickers.length).map((g) => ({ ...g.head, items: g.stickers }));
    cache = { emojis, stickers };
    builtAt = Date.now();
    return cache;
}

// Current catalog (memoized). Rebuild when stale — building is a cheap in-memory scan.
function catalog(clients) {
    if (!cache || Date.now() - builtAt > TTL) { try { build(clients); } catch (_) {} }
    return cache || { emojis: [], stickers: [] };
}

module.exports = { catalog, build, _reset: () => { cache = null; builtAt = 0; } };

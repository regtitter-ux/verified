// Ad creative tracking.
//
// A "creative" = the exact rendered text a user saw during verification
// (template + link filled in, or literal ad text). We identify it by a
// 12-char sha1 prefix so we can:
//   * tag every verified.json entry with the adKey that generated it, so
//     admin stats can attribute counts back to individual creatives;
//   * look the full text back up from adcreatives.json — the entries
//     themselves only carry the short key, not the whole ad body.
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');

// 12 hex chars = 48 bits — plenty for our scale (millions of creatives
// would still have negligible collision probability).
function adKeyOf(text) {
    if (!text) return '';
    return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
}

// Record (or refresh) the creative in adcreatives.json. Called once per
// verification-with-ad — cheap: the file only grows when a genuinely new
// rendered text appears, otherwise we just bump lastSeenAt.
function touchCreative(text) {
    if (!text) return '';
    const key = adKeyOf(text);
    const map = loadJSON('adcreatives.json', {});
    const now = Date.now();
    if (map[key]) map[key].lastSeenAt = now;
    else map[key] = { text: String(text), firstSeenAt: now, lastSeenAt: now };
    saveJSON('adcreatives.json', map);
    return key;
}

const AD_COMPLETE_CHANNEL = process.env.AD_COMPLETE_CHANNEL || '1523423040216633414';
const ADMIN_BOT_ID = process.env.ADMIN_BOT_ID || '1514533989434789998';
const AD_COMPLETE_PING = process.env.AD_COMPLETE_PING || '833442190427684914';

// When a creative with a join-limit reaches its cap, post a completion
// notice (ad text + final X/X counter) to the ops channel from the admin
// bot. Fires once per configured limit — setting a new limit via
// /admin/creative-limit replaces the record and so re-arms the notice.
// Called right after a verification is appended to verified.json.
async function maybeNotifyAdComplete(clients, adKey, verifiedList) {
    if (!adKey) return;
    const limits = loadJSON('adlimits.json', {});
    const rec = limits[adKey];
    if (!rec || !(Number(rec.limit) > 0) || rec.notifiedAt) return;
    const net = (Array.isArray(verifiedList) ? verifiedList : []).filter((u) => u.adKey === adKey).length;
    if (net < Number(rec.limit)) return;

    // Mark BEFORE sending so a concurrent verification can't double-post.
    rec.notifiedAt = Date.now();
    saveJSON('adlimits.json', limits);

    const bot = (Array.isArray(clients) ? clients : []).find((c) => c.user?.id === ADMIN_BOT_ID);
    if (!bot) return;
    const channel = bot.channels.cache.get(AD_COMPLETE_CHANNEL)
        || await bot.channels.fetch(AD_COMPLETE_CHANNEL).catch(() => null);
    if (!channel) return;

    const text = loadJSON('adcreatives.json', {})[adKey]?.text || '(текст не найден)';
    await channel.send({
        content:
            `<@${AD_COMPLETE_PING}> ✅ **Реклама выполнена** — заходы: **${net}/${rec.limit}**\n` +
            `Креатив \`#${adKey}\`\n` +
            `\`\`\`\n${String(text).slice(0, 1500)}\n\`\`\``,
        allowedMentions: { users: [AD_COMPLETE_PING] }
    }).catch(() => null);
}

module.exports = { adKeyOf, touchCreative, maybeNotifyAdComplete };

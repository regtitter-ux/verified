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

module.exports = { adKeyOf, touchCreative };

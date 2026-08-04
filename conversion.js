// Per-card CONVERSION calibration for the CPC (pay-per-click) model.
//
// For a verification card we measure conversion = (join-check joins) ÷ (unique
// clickers) over the last SAMPLE join-check joins. That ratio is the fraction of
// people who, after clicking Verify and being shown the ad, actually joined the
// sponsor. It lets us pay per CLICK on a no-join-check ad exactly what the partner
// would have earned per JOIN: rate_per_click = rate_per_join × conversion.
//
// The number is derived ENTIRELY from the stats the service already keeps
// (verified.json join-check joins + cardclicks.json clicks), so it's live from day
// one — nothing to collect from scratch — and it keeps re-computing off the latest
// SAMPLE joins as new join-check ads run. Enabled per SERVER by the owner (the
// cpcCalibrated toggle in the server-settings modal); off servers keep the normal
// pay-per-join flow untouched.
const { loadJSON } = require('./database.js');

const SAMPLE = 100;                      // conversion looks at the last N join-check joins
const CLICK_TTL = 7 * 86400000;          // clicks are retained ~7d (cards.js CLICK_TTL)

// Owner toggle: is the CPC-calibrated mode on for this partner server (guild)?
function enabledFor(guildId) {
    const cfg = loadJSON('siteconfig.json', {});
    const m = (cfg && typeof cfg.cpcCalibrated === 'object' && !Array.isArray(cfg.cpcCalibrated)) ? cfg.cpcCalibrated : null;
    return Boolean(m && m[String(guildId)]);
}

// Conversion from the last SAMPLE join-check joins and the UNIQUE clickers over the
// SAME window. The window starts at the oldest of the last SAMPLE joins but never
// earlier than the click-retention horizon, so joins and clicks always cover one
// aligned period (otherwise, with joins older than the click data, clicks would be
// undercounted and conversion overstated). Unique clickers (not raw click events) is
// the right denominator: a no-check ad verifies each user on the first click, so a
// paid click == one distinct user.
//   joinTs      — timestamps of this card's join-check joins (adKey, NOT the bonus extra-ad)
//   clickEvents — [{ u, t }] click records for this card
// Returns { conv, joins, clickers } — conv is null until there's at least one join
// and one clicker (caller falls back to the normal per-join flow / network average).
function fromSamples(joinTs, clickEvents, nowMs) {
    const now = Number(nowMs) || Date.now();
    const joins = (Array.isArray(joinTs) ? joinTs : []).map((t) => Number(t) || 0).filter((t) => t > 0).sort((a, b) => b - a);
    if (!joins.length) return { conv: null, joins: 0, clickers: 0 };
    const lastN = joins.slice(0, SAMPLE);
    const windowStart = Math.max(lastN[lastN.length - 1], now - CLICK_TTL);
    const joinsInWin = lastN.filter((t) => t >= windowStart).length;
    const clickers = new Set();
    for (const c of (Array.isArray(clickEvents) ? clickEvents : [])) {
        if (c && (Number(c.t) || 0) >= windowStart && c.u) clickers.add(String(c.u));
    }
    const cWin = clickers.size;
    if (!joinsInWin || !cWin) return { conv: null, joins: joinsInWin, clickers: cWin };
    // A clicker can convert at most once, so conversion is bounded by 1.
    const conv = Math.min(1, joinsInWin / cWin);
    return { conv: +conv.toFixed(4), joins: joinsInWin, clickers: cWin };
}

// The pay-per-click rate that matches per-join earnings, in the same $/100 unit the
// rest of the service uses: ratePer100Clicks = joinRatePer100 × conversion. Per-click
// is that ÷ 100. Returns 0 when conversion isn't established yet.
function ratePer100Clicks(conv, joinRatePer100) {
    const c = Number(conv);
    const j = Number(joinRatePer100) || 0;
    if (!Number.isFinite(c) || c <= 0 || j <= 0) return 0;
    return +(j * c).toFixed(4);
}
const ratePerClick = (conv, joinRatePer100) => +((ratePer100Clicks(conv, joinRatePer100)) / 100).toFixed(6);

module.exports = { SAMPLE, enabledFor, fromSamples, ratePer100Clicks, ratePerClick };

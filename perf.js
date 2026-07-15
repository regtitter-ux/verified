// Network throughput for the buyer-facing "orders may take a while" estimate.
//
// Measured as joins that STAYED (funnel stage 3) per hour of ACTIVE advertising —
// not per wall-clock hour. A minute with no ad running can't produce a join, so
// counting it would read a resting network as a slow one and raise a false
// "high load" warning. A sampler records ads-off stretches; they're subtracted
// from the 24h window, and when there's too little active time left to measure,
// the last good rate is frozen instead.
const { loadJSON, saveJSON } = require('./database.js');

const FILE = 'perfstate.json';
const WINDOW_MS = 24 * 3600 * 1000;                                              // lookback
const KEEP_MS = 48 * 3600 * 1000;                                                // journal retention
const ADS_STALE_MS = Number(process.env.PERF_ADS_STALE_MS) || 60 * 60 * 1000;    // no ad shown this long ⇒ "not running"
const MIN_ACTIVE_MS = Number(process.env.PERF_MIN_ACTIVE_MS) || 30 * 60 * 1000;  // need this much ad time to trust a fresh measure

function load() {
    const r = loadJSON(FILE, {});
    return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {};
}

// Is the network actually showing ads right now? Closed kran, or nothing shown
// for a while (sponsorshow.json is stamped on every real display), both count as no.
function adsRunning(now = Date.now()) {
    const cfg = loadJSON('siteconfig.json', {});
    if (cfg.adsOff) return false;
    const shows = loadJSON('sponsorshow.json', {});
    let last = 0;
    for (const v of Object.values(shows)) { const t = Number(v) || 0; if (t > last) last = t; }
    return (now - last) <= ADS_STALE_MS;
}

// Journal the on/off transitions. An open period ({ to: null }) survives a
// restart, so downtime while ads were off stays excluded.
function sample(now = Date.now()) {
    const st = load();
    const periods = Array.isArray(st.offPeriods) ? st.offPeriods : [];
    const last = periods[periods.length - 1];
    const running = adsRunning(now);
    let dirty = false;
    if (!running) {
        if (!last || last.to != null) { periods.push({ from: now, to: null }); dirty = true; }
    } else if (last && last.to == null) {
        last.to = now; dirty = true;
    }
    const cut = now - KEEP_MS;
    const kept = periods.filter((p) => p && (p.to == null || (Number(p.to) || 0) > cut));
    if (kept.length !== periods.length) dirty = true;
    if (dirty) { st.offPeriods = kept; saveJSON(FILE, st); }
    return st;
}

// Milliseconds of ACTIVE advertising inside [from, now] — the window minus every
// journaled off stretch that overlaps it.
function activeMs(from, now = Date.now()) {
    const periods = (() => { const p = load().offPeriods; return Array.isArray(p) ? p : []; })();
    let off = 0;
    for (const p of periods) {
        if (!p) continue;
        const a = Math.max(Number(p.from) || 0, from);
        const b = Math.min(p.to == null ? now : (Number(p.to) || 0), now);
        if (b > a) off += b - a;
    }
    return Math.max(0, (now - from) - off);
}

// Joins-per-hour of active advertising. `frozen` = not enough ad time in the
// window to measure, so the last good rate is being reused.
// A fresh state (no journal yet) assumes the window was fully active.
function rate(verifiedArr, now = Date.now()) {
    const st = load();
    const from = now - WINDOW_MS;
    const act = activeMs(from, now);
    const frozenRate = Math.max(0, Number(st.ratePerHour) || 0);
    const activeHours = +(act / 3600000).toFixed(2);

    if (act < MIN_ACTIVE_MS) {
        return { perHour: frozenRate, perDay: Math.round(frozenRate * 24), frozen: true, activeHours };
    }
    const arr = Array.isArray(verifiedArr) ? verifiedArr : loadJSON('verified.json', []);
    const stayed = (Array.isArray(arr) ? arr : []).filter((u) => (Number(u.timestamp) || 0) > from).length;
    const perHour = stayed / (act / 3600000);
    // Persist as the freeze fallback (throttled — rate() runs on every cabinet load).
    if (now - (Number(st.at) || 0) > 60000) {
        st.ratePerHour = perHour; st.at = now;
        saveJSON(FILE, st);
    }
    return { perHour, perDay: Math.round(perHour * 24), frozen: false, activeHours };
}

function startPerfSampler() {
    const every = Number(process.env.PERF_SAMPLE_MS) || 60 * 1000;
    const tick = () => { try { sample(); } catch (e) { console.error('[PERF] sample failed:', e.message); } };
    setInterval(tick, every);
    setTimeout(tick, 10 * 1000);
    console.log(`[PERF] ad-activity sampler every ${Math.round(every / 1000)}s`);
}

module.exports = { adsRunning, sample, activeMs, rate, startPerfSampler, WINDOW_MS, MIN_ACTIVE_MS };

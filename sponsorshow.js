// "Is this sponsor being advertised right now, and since when?"
//
// Every time a join-check ad for a sponsor is actually displayed we stamp it.
// Two facts are derived from those stamps:
//
//   showing(gid)  — an ad ran within the stale window. Gates the leave-clawback:
//                   once a sponsor stops advertising, later leaves no longer
//                   reverse a partner's earnings (the deal is closed).
//
//   eraStart(gid) — when the CURRENT run of advertising began. A gap longer than
//                   the stale window ends an era; the next stamp starts a new one.
//                   This is what keeps a NEW campaign from re-opening clawback
//                   liability on joins delivered by an OLD, long-finished one for
//                   the same server — the bug this file exists to fix. Without it
//                   "showing" is keyed by sponsor alone, so any fresh ad for that
//                   server made every historical join clawback-able again.
const { loadJSON, saveJSON } = require('./database.js');

const showStaleMs = () => Number(process.env.SPONSOR_SHOW_STALE_MS) || 30 * 60 * 1000;
// How long a gap ENDS an advertising era / marks a sponsor "no longer advertising"
// for the CLAWBACK gate. This must be much larger than the 30-min display window:
// normal ad rotation (and any temporary outage, e.g. an egress-IP ban) leaves gaps
// well over 30 min for a given sponsor WITHOUT the deal having ended — a 30-min
// threshold wrongly grandfathered joins and stopped clawing leavers. A day-scale
// gap is what actually signals "this campaign run is over".
const eraGapMs = () => Number(process.env.SPONSOR_ERA_GAP_MS) || 24 * 60 * 60 * 1000;
const WRITE_THROTTLE_MS = 60 * 1000;

const obj = (file) => { const r = loadJSON(file, {}); return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {}; };
const loadShows = () => obj('sponsorshow.json');
const loadEras = () => obj('sponsorera.json');

// Record that this sponsor's ad was just shown.
function stamp(gid) {
    const id = String(gid || '');
    if (!/^\d{17,20}$/.test(id)) return;
    const now = Date.now();
    const shows = loadShows();
    const prev = Number(shows[id]) || 0;

    // A gap (or a sponsor we've never stamped) starts a new era. Bootstrapping an
    // era here is deliberate: joins delivered before we started tracking belong to
    // runs we can't reconstruct, so they're grandfathered as closed rather than
    // punished. New joins from this moment on are covered normally.
    const eras = loadEras();
    if (!eras[id] || !prev || now - prev > eraGapMs()) {
        eras[id] = now;
        saveJSON('sponsorera.json', eras);
    }
    if (now - prev < WRITE_THROTTLE_MS) return;   // already fresh — skip the write
    shows[id] = now;
    saveJSON('sponsorshow.json', shows);
}

// Is the sponsor's ad running now? (30-min display window.) `shows` lets a caller
// pass a snapshot. Used for the live "showing now" UI/stats.
function showing(gid, shows) {
    const map = shows || loadShows();
    return (Date.now() - (Number(map?.[gid]) || 0)) <= showStaleMs();
}

// Was the sponsor advertised recently enough that its CAMPAIGN is still active —
// i.e. a leaver should still be clawed back? Uses the day-scale era gap, not the
// 30-min display window, so normal rotation gaps / temporary outages don't wrongly
// settle leaves for a campaign that is still running.
function recentlyAdvertised(gid, shows) {
    const map = shows || loadShows();
    return (Date.now() - (Number(map?.[gid]) || 0)) <= eraGapMs();
}

// Start of the current advertising run, or 0 when unknown.
function eraStart(gid, eras) {
    const map = eras || loadEras();
    return Number(map?.[gid]) || 0;
}

// Was this join delivered by an ad run that has since ended? Such a join belongs
// to a closed deal and must never be clawed back by a later, unrelated campaign.
function joinPredatesEra(gid, joinTs, eras) {
    const era = eraStart(gid, eras);
    return Boolean(era && (Number(joinTs) || 0) < era);
}

module.exports = { get SHOW_STALE_MS() { return showStaleMs(); }, get ERA_GAP_MS() { return eraGapMs(); }, stamp, showing, recentlyAdvertised, eraStart, joinPredatesEra, loadShows, loadEras };

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

const SHOW_STALE_MS = Number(process.env.SPONSOR_SHOW_STALE_MS) || 30 * 60 * 1000;
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
    if (!eras[id] || !prev || now - prev > SHOW_STALE_MS) {
        eras[id] = now;
        saveJSON('sponsorera.json', eras);
    }
    if (now - prev < WRITE_THROTTLE_MS) return;   // already fresh — skip the write
    shows[id] = now;
    saveJSON('sponsorshow.json', shows);
}

// Is the sponsor's ad running now? `shows` lets a caller pass a snapshot.
function showing(gid, shows) {
    const map = shows || loadShows();
    return (Date.now() - (Number(map?.[gid]) || 0)) <= SHOW_STALE_MS;
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

module.exports = { SHOW_STALE_MS, stamp, showing, eraStart, joinPredatesEra, loadShows, loadEras };

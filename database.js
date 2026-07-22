const fs = require('fs');
const path = require('path');

// On Railway the container filesystem is ephemeral: anything written next to the
// code is wiped on every redeploy/restart. Point DATA_DIR at a mounted Volume so
// balances, withdrawals, requisites and verifications survive redeploys.
// Railway auto-sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

try {
    if (DATA_DIR !== __dirname) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
    console.error('[ERROR] Failed to create data dir:', e);
}

const persistPath = (file) => path.join(DATA_DIR, file);
const seedPath = (file) => path.resolve(__dirname, file);

const readFile = (filePath) => {
    if (!fs.existsSync(filePath)) return undefined;
    const data = fs.readFileSync(filePath, 'utf8');
    return data ? JSON.parse(data) : undefined;
};

// In-memory parse cache, invalidated by file mtime. The hot files (verified.json,
// joinlinks.json, cardclicks.json) are read many times per request — once PER
// CARD in enrichCards — and JSON.parse of a large file blocks the single event
// loop, stalling every concurrent request. Caching the parsed value and only
// re-parsing when the on-disk mtime changes turns those repeat reads into a cheap
// stat. All writes go through saveJSON (same process), which refreshes the cache,
// so the only thing that changes mtime out-of-band is a manual file edit — still
// picked up. Callers get a shared reference; the existing mutate-then-saveJSON
// paths are synchronous (no await between), so this is safe under Node's model.
const _cache = new Map(); // file -> { mtimeMs, data }

const loadJSON = (file, fallback = {}) => {
    try {
        const p = persistPath(file);
        let st = null;
        try { st = fs.statSync(p); } catch { st = null; }
        if (st) {
            const cached = _cache.get(file);
            if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
            const data = readFile(p);
            if (data !== undefined) { _cache.set(file, { mtimeMs: st.mtimeMs, data }); return data; }
        } else if (persistPath(file) !== seedPath(file)) {
            // No persisted copy yet: fall back to the bundled seed (e.g. ad texts
            // committed in the repo) on first run. Not cached — it's read at most
            // until the first save creates the persisted file.
            const seed = readFile(seedPath(file));
            if (seed !== undefined) return seed;
        }
    } catch (e) {
        console.error(`[ERROR] Failed to load ${file}:`, e);
    }
    return fallback;
};

// Atomic write: serialize to a temp file, fsync it, then rename over the target.
// rename() is atomic on the same filesystem, so a crash mid-write can never
// leave a half-written (corrupt) JSON file — readers always see either the old
// or the new complete file. (This does NOT serialize concurrent writers to the
// same file — last rename wins, same as before; that needs a DB/queue.)
const saveJSON = (file, data) => {
    const target = persistPath(file);
    const tmp = `${target}.tmp`;
    try {
        // Compact (no indentation): the hot files (verified.json, joinlinks.json)
        // are rewritten in full on every join and grow large — indentation roughly
        // doubles both the serialize time and the bytes written on the event loop.
        // These are machine data, still valid JSON, greppable via jq.
        const json = JSON.stringify(data);
        const fd = fs.openSync(tmp, 'w');
        try { fs.writeSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, target);
        // Keep the read cache in sync with what we just wrote, so the next
        // loadJSON is a hit rather than a re-read+parse.
        try { _cache.set(file, { mtimeMs: fs.statSync(target).mtimeMs, data }); } catch { _cache.delete(file); }
    } catch (e) {
        console.error(`[ERROR] Failed to save ${file}:`, e);
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
};

// Atomic read-modify-write — the SANCTIONED way to change a data file. This is
// the safe alternative to the `loadJSON → mutate → saveJSON` idiom, which is
// error-prone because loadJSON hands back a SHARED, mtime-cached reference:
// mutating it and then re-loading the same file elsewhere sees the polluted
// object (this caused the double-clawback bug). `mutate` hands `fn` a DEEP COPY,
// so nothing it does can ever leak into the cache, and it saves in one
// synchronous pass (no `await` inside → atomic under Node's single thread).
//
//   mutate('settings.json', (s) => { s[uid].balance += 5; }, {})
//   const bal = mutate('wallets.json', (w) => { if (w[id].balance < amt) return false;  // abort: no save
//                                               w[id].balance -= amt; return w[id].balance; }, {})
//
// `fn` MUST be synchronous (do any awaits BEFORE calling mutate). Return `false`
// to abort the write (nothing is saved); any other return value is passed back.
// Best for the small money files (settings/wallets/shares); the deep copy makes
// it a poor fit for the multi-MB hot files (verified/joinlinks).
function mutate(file, fn, fallback = {}) {
    const cur = loadJSON(file, fallback);
    const base = (cur && typeof cur === 'object') ? cur : fallback;
    const draft = JSON.parse(JSON.stringify(base));
    const ret = fn(draft);
    if (ret !== false) saveJSON(file, draft);
    return ret;
}

// Test-only: drop the parse cache so a fixture reseed between tests is seen even
// if mtime resolution is coarse. No-op cost in production (never called there).
const _resetCache = () => _cache.clear();

module.exports = { loadJSON, saveJSON, mutate, DATA_DIR, _resetCache };

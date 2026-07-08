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

const loadJSON = (file, fallback = {}) => {
    try {
        // Prefer the persisted copy on the volume; fall back to the bundled seed
        // (e.g. the ad texts committed in the repo) on first run.
        const persisted = readFile(persistPath(file));
        if (persisted !== undefined) return persisted;

        if (persistPath(file) !== seedPath(file)) {
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
        const json = JSON.stringify(data, null, 2);
        const fd = fs.openSync(tmp, 'w');
        try { fs.writeSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, target);
    } catch (e) {
        console.error(`[ERROR] Failed to save ${file}:`, e);
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
};

module.exports = { loadJSON, saveJSON, DATA_DIR };

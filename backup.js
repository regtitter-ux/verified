// Data backups.
//
// All state lives in JSON files on the Railway volume. If that volume is lost
// or a file is corrupted, everything (balances, payouts, shares, campaigns) is
// gone. This keeps two safety nets:
//   • local rolling snapshots on the volume (fast restore after a bad write);
//   • off-site copies posted (gzipped) to a private Discord channel, so a
//     total volume loss is still recoverable.
// Configure backupChannel() (a channel the admin bot can post to). Interval and
// retention are env-tunable.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DATA_DIR } = require('./database.js');

const ADMIN_BOT_ID = (process.env.ADMIN_BOT_ID || '1514533989434789998').trim();
const backupChannel = () => (process.env.BACKUP_CHANNEL || '').trim();
const INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS) || 6 * 3600 * 1000; // every 6h
const KEEP_LOCAL = Number(process.env.BACKUP_KEEP_LOCAL) || 24;                 // ~6 days at 6h
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// Every state file, but never our own temp/backup artifacts.
function dataFiles() {
    try {
        return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    } catch { return []; }
}

// Bundle all state into one object (for the off-site copy).
function bundle() {
    const out = {};
    for (const f of dataFiles()) {
        try { out[f] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
        catch { /* skip unreadable/partial file */ }
    }
    return out;
}

// Copy every state file into backups/<timestamp>/, then prune old snapshots.
function snapshotLocal() {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const dest = path.join(BACKUP_DIR, stamp());
        fs.mkdirSync(dest, { recursive: true });
        for (const f of dataFiles()) {
            try { fs.copyFileSync(path.join(DATA_DIR, f), path.join(dest, f)); } catch { /* ignore */ }
        }
        const snaps = fs.readdirSync(BACKUP_DIR)
            .filter((d) => { try { return fs.statSync(path.join(BACKUP_DIR, d)).isDirectory(); } catch { return false; } })
            .sort();
        while (snaps.length > KEEP_LOCAL) {
            const old = snaps.shift();
            try { fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true }); } catch { /* ignore */ }
        }
        return dest;
    } catch (e) { console.error('[BACKUP] local snapshot failed:', e.message); return null; }
}

// Post a gzipped bundle to the backup channel (off-site copy).
async function toDiscord(clients) {
    if (!backupChannel()) return { ok: false, reason: 'no-channel' };
    const bot = (Array.isArray(clients) ? clients : []).find((c) => c.user?.id === ADMIN_BOT_ID)
        || (Array.isArray(clients) ? clients : [])[0];
    if (!bot) return { ok: false, reason: 'no-bot' };
    const channel = bot.channels.cache.get(backupChannel()) || await bot.channels.fetch(backupChannel()).catch(() => null);
    if (!channel) return { ok: false, reason: 'no-channel' };
    try {
        const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle())));
        const name = `vemoni-backup-${stamp()}.json.gz`;
        await channel.send({ content: `🗄 Backup ${new Date().toISOString()} · ${dataFiles().length} files · ${Math.round(gz.length / 1024)} KB`, files: [{ attachment: gz, name }] });
        return { ok: true, bytes: gz.length };
    } catch (e) { console.error('[BACKUP] discord upload failed:', e.message); return { ok: false, reason: e.message }; }
}

let lastRun = null;
async function runOnce(clients) {
    const dest = snapshotLocal();
    const off = await toDiscord(clients);
    lastRun = { at: Date.now(), local: Boolean(dest), offsite: off?.ok || false, files: dataFiles().length };
    return lastRun;
}
function getLastRun() { return lastRun; }

function startBackupSweep(clients) {
    const tick = () => runOnce(clients).catch((e) => console.error('[BACKUP] sweep error:', e.message));
    setInterval(tick, INTERVAL_MS);
    setTimeout(tick, 2 * 60 * 1000); // first backup a couple minutes after boot
    console.log(`[BACKUP] every ${Math.round(INTERVAL_MS / 3600000)}h · local keep ${KEEP_LOCAL}${backupChannel() ? ' · off-site ON' : ' · off-site OFF (set backupChannel())'}`);
}

module.exports = { snapshotLocal, toDiscord, runOnce, getLastRun, startBackupSweep, dataFiles, BACKUP_DIR, get BACKUP_CHANNEL() { return backupChannel(); } };

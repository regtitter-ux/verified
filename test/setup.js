// Test harness bootstrap. REQUIRE THIS FIRST in every test file — before any app
// module — so DATA_DIR points at an isolated temp dir before database.js reads it.
// Uses only Node built-ins (node:test / node:assert); no dev dependencies.
const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vemoni-test-'));
process.env.DATA_DIR = DIR;
process.env.OWNER_ID = process.env.OWNER_ID || 'OWNER';
// Keep tests deterministic / offline: disable payout providers & external calls.
delete process.env.CRYPTO_PAY_TOKEN;
delete process.env.NOWPAYMENTS_API_KEY;

const db = require('../database.js');

// Write fixture files and drop the parse cache so the next load reads them.
function seed(files) {
    for (const [name, val] of Object.entries(files || {})) {
        fs.writeFileSync(path.join(DIR, name), typeof val === 'string' ? val : JSON.stringify(val));
    }
    db._resetCache();
}

// Read a data file back (post-mutation assertions).
function read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); }
    catch { return fallback; }
}

// Wipe all fixtures + cache between tests.
function reset() {
    for (const f of fs.readdirSync(DIR)) { try { fs.rmSync(path.join(DIR, f), { recursive: true, force: true }); } catch { /* ignore */ } }
    db._resetCache();
}

module.exports = { DIR, seed, read, reset };

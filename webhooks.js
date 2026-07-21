// Signed developer webhooks. A developer registers a URL + secret in their
// cabinet; we POST a signed JSON event to it whenever one of their API joins is
// credited or reversed (clawed back on leave). This lets the developer keep
// their own economy in sync with Vemoni without polling.
//
// Delivery is best-effort with a few retries and never blocks the money path.
// Config lives in webhooks.json keyed by the developer's user id (the API-key
// owner / campaign creatorId): { url, secret, createdAt, updatedAt }.
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');

const FILE = 'webhooks.json';

function getConfig(userId) {
    const all = loadJSON(FILE, {});
    const c = all[String(userId)];
    return (c && c.url) ? c : null;
}

// Save (or clear, when url is empty) a developer's webhook. Returns the stored
// record (without leaking anything the caller shouldn't echo).
function setConfig(userId, url, secret) {
    const all = loadJSON(FILE, {});
    const key = String(userId);
    if (!url) { delete all[key]; saveJSON(FILE, all); return null; }
    const prev = all[key] || {};
    const rec = {
        url: String(url),
        secret: (secret != null && String(secret) !== '') ? String(secret) : (prev.secret || ''),
        createdAt: prev.createdAt || Date.now(),
        updatedAt: Date.now()
    };
    all[key] = rec;
    saveJSON(FILE, all);
    return rec;
}

function post(url, body, headers) {
    return new Promise((resolve) => {
        let u; try { u = new URL(url); } catch { return resolve(false); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(false);
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: (u.pathname || '/') + (u.search || ''), method: 'POST', headers
        }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
        req.on('error', () => resolve(false));
        req.setTimeout(8000, () => req.destroy());
        req.write(body);
        req.end();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fire `event` (e.g. 'credited' | 'reverted') to the developer `userId`, signed
// with their secret. `data` is merged into the payload. Best-effort, never throws.
async function fire(userId, event, data) {
    try {
        const cfg = getConfig(userId);
        if (!cfg || !cfg.url) return;
        const payload = {
            event,
            eventId: crypto.randomBytes(12).toString('hex'),
            timestamp: Date.now(),
            apiVersion: 1,
            ...data
        };
        const body = JSON.stringify(payload);
        const sig = cfg.secret ? crypto.createHmac('sha256', cfg.secret).update(body).digest('hex') : '';
        const headers = {
            'Content-Type': 'application/json',
            'X-Vemoni-Event': event,
            'X-Vemoni-Signature': `sha256=${sig}`,
            'X-Vemoni-Delivery': payload.eventId,
            'User-Agent': 'Vemoni-Webhook/1'
        };
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (await post(cfg.url, body, headers)) {
                console.log('[WEBHOOK] sent', JSON.stringify({ dev: String(userId), event, id: payload.eventId }));
                return;
            }
            if (attempt < 3) await sleep(500 * attempt);
        }
        console.warn('[WEBHOOK] failed after retries', JSON.stringify({ dev: String(userId), event, url: cfg.url }));
    } catch (e) { console.error('[WEBHOOK] error', e && e.message); }
}

module.exports = { getConfig, setConfig, fire };

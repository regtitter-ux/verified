const { seed, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const api = require('../api.js');

const G = '999000111', OTHER = '888000222';
const now = Date.now(), HOUR = 3600 * 1000, DAY = 24 * HOUR;
beforeEach(() => reset());

test('committed24 = live runs full count + settled delivered within 24h; headroom caps at 30k', () => {
    assert.equal(api.DMALL_CAP_24H, 30000);
    seed({ 'dmallruns.json': {
        // live/queued run → reserves its FULL requested count
        R1: { id: 'R1', serverId: G, count: 5000, settled: false, createdAt: now - HOUR },
        // settled within 24h → counts delivered (not the full count)
        R2: { id: 'R2', serverId: G, count: 10000, delivered: 8000, settled: true, settledAt: now - 2 * HOUR },
        // settled but OUTSIDE the 24h window → does not count
        R3: { id: 'R3', serverId: G, count: 10000, delivered: 9000, settled: true, settledAt: now - 26 * HOUR },
        // a different server → irrelevant
        X1: { id: 'X1', serverId: OTHER, count: 12000, settled: false, createdAt: now - HOUR },
    } });
    assert.equal(api.dmallServerCommitted24(G), 13000, '5000 live + 8000 recent settled');
    assert.equal(api.dmallCapHeadroom(G), 17000, '30000 - 13000');
    assert.equal(api.dmallServerCommitted24(OTHER), 12000);
    assert.equal(api.dmallServerCommitted24('nobody'), 0);
});

test('headroom is zero once a server is at/over the cap', () => {
    seed({ 'dmallruns.json': {
        A: { id: 'A', serverId: G, count: 20000, settled: false, createdAt: now },
        B: { id: 'B', serverId: G, count: 15000, delivered: 15000, settled: true, settledAt: now - HOUR },
    } });
    assert.equal(api.dmallServerCommitted24(G), 35000);
    assert.equal(api.dmallCapHeadroom(G), 0, 'clamped at 0, never negative');
});

test('settled run with no settledAt falls back to createdAt for the window', () => {
    seed({ 'dmallruns.json': {
        A: { id: 'A', serverId: G, count: 9000, delivered: 9000, settled: true, createdAt: now - 3 * HOUR },
        B: { id: 'B', serverId: G, count: 9000, delivered: 9000, settled: true, createdAt: now - 30 * HOUR },
    } });
    assert.equal(api.dmallServerCommitted24(G), 9000, 'only the recent one counts');
});

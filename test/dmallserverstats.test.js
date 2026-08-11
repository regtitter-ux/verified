const { seed, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const dmallruns = require('../dmallruns.js');

const G1 = '111111111111111111', G2 = '222222222222222222';
beforeEach(() => reset());

// Per-server lifetime stats are keyed by serverId and aggregate delivered>0 runs — so they
// stick to the server across lot delete/recreate (dmallruns rows are keyed by runId, not lot).
test('statsByServer counts successful broadcasts + total delivered per server', () => {
    seed({ 'dmallruns.json': {
        R1: { id: 'R1', serverId: G1, delivered: 300, settled: true },
        R2: { id: 'R2', serverId: G1, delivered: 200, settled: true },
        R3: { id: 'R3', serverId: G1, delivered: 0, settled: true },   // failed delivery → not counted
        R4: { id: 'R4', serverId: G1, lotId: 'DIFFERENT-LOT', delivered: 100, settled: true }, // recreated lot, same server
        R5: { id: 'R5', serverId: G2, delivered: 50, settled: true },
        R6: { id: 'R6', serverId: G1 },   // unsettled (no delivered) → not counted
    } });
    const s = dmallruns.statsByServer();
    assert.deepEqual(s[G1], { runs: 3, delivered: 600 }, 'G1: R1+R2+R4 (R3=0, R6=unsettled excluded); survives lot recreation');
    assert.deepEqual(s[G2], { runs: 1, delivered: 50 });
    assert.deepEqual(dmallruns.forServer(G1), { runs: 3, delivered: 600 });
    assert.deepEqual(dmallruns.forServer('999'), { runs: 0, delivered: 0 }, 'unknown server → zeros');
});

test('serverOutcomes splits settled runs into ok (delivered≥1) vs failed (0) — the dead-server signal', () => {
    seed({ 'dmallruns.json': {
        A1: { id: 'A1', serverId: G1, delivered: 0, settled: true },
        A2: { id: 'A2', serverId: G1, delivered: 0, settled: true },
        A3: { id: 'A3', serverId: G1, delivered: 5, settled: true },
        A4: { id: 'A4', serverId: G1 },   // unsettled → ignored
        B1: { id: 'B1', serverId: G2, delivered: 0, settled: true },
        B2: { id: 'B2', serverId: G2, delivered: 0, settled: true },
    } });
    assert.deepEqual(dmallruns.serverOutcomes(G1), { ok: 1, failed: 2 }, 'has a success → not dead');
    assert.deepEqual(dmallruns.serverOutcomes(G2), { ok: 0, failed: 2 }, '≥2 failed, 0 ok → dead');
    assert.deepEqual(dmallruns.serverOutcomes('999'), { ok: 0, failed: 0 }, 'new server → zeros → allowed');
});

test('soldFor sums delivered on runs against a user\'s lots (creatorId), i.e. bought by others', () => {
    const SELLER = 'seller-1', BUYER = 'buyer-1';
    seed({ 'dmallruns.json': {
        // Someone else bought on SELLER's lot → counts as SELLER's "sold".
        S1: { id: 'S1', buyerId: BUYER, creatorId: SELLER, delivered: 200, settled: true },
        S2: { id: 'S2', buyerId: BUYER, creatorId: SELLER, delivered: 112, settled: true },
        S3: { id: 'S3', buyerId: BUYER, creatorId: SELLER, delivered: 0, settled: true },   // nothing delivered → not a run, still $0
        // SELLER broadcasting on their OWN server has no creatorId → not a sale (it's their "bought").
        O1: { id: 'O1', buyerId: SELLER, creatorId: '', delivered: 500, settled: true },
        // A different seller's sale → not SELLER's.
        X1: { id: 'X1', buyerId: BUYER, creatorId: 'seller-2', delivered: 90, settled: true },
    } });
    assert.deepEqual(dmallruns.soldFor(SELLER), { delivered: 312, runs: 2 }, 'S1+S2 (S3 delivered 0 → not a run); own-server O1 and other seller X1 excluded');
    assert.deepEqual(dmallruns.soldFor('nobody'), { delivered: 0, runs: 0 }, 'no lots sold → zeros');
});

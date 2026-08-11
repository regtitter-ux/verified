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

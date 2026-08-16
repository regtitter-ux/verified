const { reset } = require('./setup');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const lots = require('../dmalllots.js');

const saved = process.env.DMALL_SERVICE_FEE_PER_1K;
beforeEach(() => reset());
afterEach(() => { if (saved === undefined) delete process.env.DMALL_SERVICE_FEE_PER_1K; else process.env.DMALL_SERVICE_FEE_PER_1K = saved; });

// The admin panel edits DMALL_SERVICE_FEE_PER_1K live (runtime-config → process.env). The fee
// must be read at use-time, not captured at module load, so it applies without a restart.
test('service fee is read live from the env', () => {
    process.env.DMALL_SERVICE_FEE_PER_1K = '2.5';
    assert.equal(lots.SERVICE_FEE_PER_1K, 2.5);
    assert.equal(lots.userPricePer1k(5), 7.5, 'creator $5 + $2.5 fee');

    process.env.DMALL_SERVICE_FEE_PER_1K = '0';   // free service is allowed
    assert.equal(lots.SERVICE_FEE_PER_1K, 0);
    assert.equal(lots.userPricePer1k(5), 5);

    delete process.env.DMALL_SERVICE_FEE_PER_1K;  // unset → default $1
    assert.equal(lots.SERVICE_FEE_PER_1K, 1);
});

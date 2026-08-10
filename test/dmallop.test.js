require('./setup');
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const dmallop = require('../dmallop.js');
const dmalljobs = require('../dmalljobs.js');

afterEach(() => { delete process.env.DMALL_OP_KEY; });

test('dmall operator is dormant without a key (never calls out)', async () => {
    delete process.env.DMALL_OP_KEY;
    assert.equal(dmallop.enabled(), false);
    // call() short-circuits with 503 rather than attempting a network request
    const r = await dmallop.ping();
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'not_configured');
});

test('dmall operator wakes up once the key is set', () => {
    process.env.DMALL_OP_KEY = 'bop_test';
    assert.equal(dmallop.enabled(), true);
});

test('broadcast price is $1 per 1000 messages (the wallet charge)', () => {
    assert.equal(dmalljobs.priceFor(1000), 1);
    assert.equal(dmalljobs.priceFor(500), 0.5);
    assert.equal(dmalljobs.priceFor(0), 0);
    assert.equal(dmalljobs.priceFor(2500), 2.5);
});

require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { reset, seed, read } = require('./setup');
const pa = require('../personalad.js');

beforeEach(() => reset());

test('CPC off → does not show and never credits', () => {
    seed({ 'siteconfig.json': {} });
    assert.equal(pa.canShow('G'), false);
    assert.equal(pa.claimClick('G', 'u1', 1, 0.05), 0);
});

test('per-click credit is deduped per user and capped by the limit', () => {
    seed({ 'siteconfig.json': { personalAdCpc: { G: true }, personalAdLimit: { G: 2 } } });
    assert.equal(pa.canShow('G'), true);
    // conv = 1 → always a hit → pays one full join bid; deduped per user.
    assert.equal(pa.claimClick('G', 'u1', 1, 0.05), 0.05, 'u1 credited');
    assert.equal(pa.claimClick('G', 'u1', 1, 0.05), 0, 'same user again → no double pay');
    assert.equal(pa.claimClick('G', 'u2', 1, 0.05), 0.05, 'u2 credited (2/2)');
    assert.equal(pa.canShow('G'), false, 'limit reached → stop showing');
    assert.equal(pa.claimClick('G', 'u3', 1, 0.05), 0, 'over the limit → no credit');
    assert.equal(read('personalads.json').G.clicks, 2, 'exactly the limit counted');
});

test('unlimited ignores the limit; conv 0 pays nothing but still counts + dedups', () => {
    seed({ 'siteconfig.json': { personalAdCpc: { G: true }, personalAdUnlimited: { G: true } } });
    assert.equal(pa.canShow('G'), true);
    assert.equal(pa.claimClick('G', 'u1', 0, 0.05), 0, 'conv 0 → no pay');
    assert.equal(read('personalads.json').G.clicks, 1, 'the click is still counted');
    assert.equal(pa.claimClick('G', 'u1', 1, 0.05), 0, 'u1 already counted → deduped');
});

test('limit 0 with unlimited off → does not show (avoids paying with no cap set)', () => {
    seed({ 'siteconfig.json': { personalAdCpc: { G: true } } });   // no limit, not unlimited
    assert.equal(pa.canShow('G'), false);
});

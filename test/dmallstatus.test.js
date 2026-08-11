const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const status = require('../dmallserverstatus.js');

const G = '111111111111111111';
beforeEach(() => reset());

test('set reports real changes; isAvailable/availabilityMap reflect the stored status', () => {
    assert.equal(status.isAvailable(G), null, 'never checked → null');
    assert.equal(status.set(G, false), true, 'first write is a change');
    assert.equal(status.set(G, false), false, 'same value → not a change');
    assert.equal(status.isAvailable(G), false);
    assert.equal(status.set(G, true), true, 'flip back is a change');
    assert.equal(status.isAvailable(G), true);
    assert.deepEqual(status.availabilityMap(), { [G]: true });
});

test('recent returns the cached value within the TTL, undefined after', () => {
    status.set(G, false);
    assert.equal(status.recent(G, 60000), false, 'within TTL → cached value');
    assert.equal(status.recent(G, 0), undefined, 'past TTL → re-check');
    assert.equal(status.recent('999', 60000), undefined, 'unknown server → undefined');
});

test('markFailure blocks the server + recentFailure holds the cooldown', () => {
    assert.equal(status.markFailure(G), true, 'goes unavailable');
    assert.equal(status.isAvailable(G), false);
    assert.equal(status.recentFailure(G, 60000), true, 'within cooldown → still failed');
    assert.equal(status.recentFailure(G, 0), false, 'past cooldown → re-checkable');
    assert.equal(status.recentFailure('999', 60000), false, 'never failed → false');
    // A real delivery clears it.
    assert.equal(status.set(G, true), true);
    assert.equal(status.isAvailable(G), true);
});

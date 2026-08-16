const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const lots = require('../dmalllots.js');

beforeEach(() => reset());

// One lot per server: the create route rejects a second card when serverListed() is true.
test('serverListed reflects whether a server already has a lot', () => {
    const SID = '222222222222222222';
    assert.equal(lots.serverListed(SID), false, 'no lot yet');
    lots.create('900000000000000001', { serverId: SID, serverName: 'S', memberCount: 10, pricePer1k: 5 });
    assert.equal(lots.serverListed(SID), true, 'now listed');
    assert.equal(lots.serverListed('333333333333333333'), false, 'unrelated server still free');
    // A different owner adding the SAME server is still "listed" → the route rejects it.
    lots.create('900000000000000002', { serverId: SID, serverName: 'S', memberCount: 10, pricePer1k: 7 });
    assert.equal(lots.serverListed(SID), true);
});

test('minOrder is stored on create, editable, and floored to a non-negative integer', () => {
    const SID = '444444444444444444', OWNER = '900000000000000009';
    const lot = lots.create(OWNER, { serverId: SID, serverName: 'S', pricePer1k: 5, minOrder: 100 });
    assert.equal(lot.minOrder, 100);
    // Edit the minimum.
    const upd = lots.update(lot.id, OWNER, false, { minOrder: 250 });
    assert.equal(upd.minOrder, 250);
    // Clear it (0 = no minimum), and negatives/fractions are normalized.
    assert.equal(lots.update(lot.id, OWNER, false, { minOrder: 0 }).minOrder, 0);
    assert.equal(lots.update(lot.id, OWNER, false, { minOrder: -5 }).minOrder, 0);
    assert.equal(lots.update(lot.id, OWNER, false, { minOrder: 50.9 }).minOrder, 50);
    // Default when unspecified is 0.
    const lot2 = lots.create(OWNER, { serverId: '555555555555555555', pricePer1k: 3 });
    assert.equal(lot2.minOrder, 0);
});

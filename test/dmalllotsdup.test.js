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

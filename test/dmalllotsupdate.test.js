const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const dmalllots = require('../dmalllots.js');

const OWNER = '111111111111111111', OTHER = '222222222222222222', STAFF = '333333333333333333';
const NEWOWNER = '444444444444444444';
beforeEach(() => reset());

function seedLot() {
    seed({ 'dmalllots.json': { L1: { id: 'L1', creatorId: OWNER, serverId: '999000111', serverName: 'S', pricePer1k: 5, createdAt: 1 } } });
}

test('change owner: creator can give their lot away; a stranger cannot; staff can reassign any lot', () => {
    seedLot();
    // A non-owner (not staff) cannot touch it.
    assert.equal(dmalllots.update('L1', OTHER, false, { creatorId: NEWOWNER }), null, 'stranger blocked');
    assert.equal(read('dmalllots.json').L1.creatorId, OWNER, 'unchanged');
    // The creator gives it away → new owner set; the old owner loses control.
    const upd = dmalllots.update('L1', OWNER, false, { creatorId: NEWOWNER });
    assert.equal(upd.creatorId, NEWOWNER);
    assert.equal(read('dmalllots.json').L1.creatorId, NEWOWNER);
    assert.equal(dmalllots.update('L1', OWNER, false, { pricePer1k: 9 }), null, 'former owner can no longer edit');
    // Staff can reassign any lot regardless of ownership.
    const upd2 = dmalllots.update('L1', STAFF, true, { creatorId: OWNER });
    assert.equal(upd2.creatorId, OWNER, 'staff reassigned');
});

test('change owner rejects an invalid Discord id', () => {
    seedLot();
    const upd = dmalllots.update('L1', OWNER, false, { creatorId: 'not-an-id' });
    assert.equal(upd.creatorId, OWNER, 'invalid id ignored, owner unchanged');
});

require('./setup');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { reset, read } = require('./setup');
const mb = require('../mapbind.js');

const DEST = { guildId: '200000000000000002', name: 'Dest', icon: 'ic' };
const SRC_A = '100000000000000001';
const SRC_B = '100000000000000009';

const realRandom = Math.random;
beforeEach(() => reset());
afterEach(() => { Math.random = realRandom; });

test('create seeds sane defaults and lists it', () => {
    const b = mb.create('OWNER', 'https://discord.gg/abc', DEST, 1000);
    assert.equal(b.ownerId, 'OWNER');
    assert.equal(b.destGuildId, DEST.guildId);
    assert.equal(b.running, false);
    assert.equal(b.delivered, 0);
    assert.deepEqual(b.sources, []);
    assert.equal(mb.list().length, 1);
});

test('update sets sources/limit/price/running; changing the invite records link history', () => {
    const b = mb.create('OWNER', 'https://discord.gg/old', DEST, 1000);
    mb.update(b.id, { sources: [SRC_A, SRC_B, 'nope'], limit: 50, pricePer100: 10, running: true }, 2000);
    let v = mb.get(b.id);
    assert.deepEqual(v.sources, [SRC_A, SRC_B], 'invalid gid dropped');
    assert.equal(v.limit, 50);
    assert.equal(v.pricePer100, 10);
    assert.equal(v.running, true);
    assert.equal(v.stoppedReason, null);

    mb.update(b.id, { invite: 'https://discord.gg/new', dest: { guildId: '200000000000000003', name: 'D2', icon: '' } }, 3000);
    v = mb.get(b.id);
    assert.equal(v.invite, 'https://discord.gg/new');
    assert.equal(v.destGuildId, '200000000000000003');
    assert.equal(v.history.length, 1);
    assert.equal(v.history[0].invite, 'https://discord.gg/old');
    assert.equal(v.history[0].to, 3000);

    mb.update(b.id, { running: false }, 4000);
    assert.equal(mb.get(b.id).stoppedReason, 'manual');
});

test('pickForSource returns only a running, covering, under-limit binding (oldest wins)', () => {
    const b1 = mb.create('OWNER', 'https://discord.gg/one', DEST, 1000);
    const b2 = mb.create('OWNER', 'https://discord.gg/two', { guildId: '200000000000000004', name: 'D', icon: '' }, 2000);
    mb.update(b1.id, { sources: [SRC_A], running: true }, 1500);
    mb.update(b2.id, { sources: [SRC_A], running: true }, 2500);
    assert.equal(mb.pickForSource(SRC_A).id, b1.id, 'oldest running wins');
    assert.equal(mb.pickForSource(SRC_B), null, 'source not covered');

    mb.update(b1.id, { running: false }, 3000);
    assert.equal(mb.pickForSource(SRC_A).id, b2.id, 'stopped binding skipped');

    // never advertise the destination on itself
    mb.update(b2.id, { sources: [SRC_A, b2.destGuildId] }, 3200);
    assert.equal(mb.pickForSource(b2.destGuildId), null);
});

test('claimJoin: dedup per user, statistical hit debits perJoin, miss records but pays 0', () => {
    const b = mb.create('OWNER', 'https://discord.gg/x', DEST, 1000);
    mb.update(b.id, { sources: [SRC_A], pricePer100: 10, running: true }, 1500);   // $0.10 / join

    Math.random = () => 0;   // force a hit whenever conv > 0
    assert.equal(mb.claimJoin(b.id, 'u1', 0.5, 100, 2000), 0.10, 'hit debits $0.10');
    assert.equal(mb.claimJoin(b.id, 'u1', 0.5, 100, 2100), 0, 'same user deduped');
    assert.equal(read('bindings.json')[b.id].delivered, 1);
    assert.equal(read('bindings.json')[b.id].spentUsd, 0.10);

    Math.random = () => 0.999;   // force a miss
    assert.equal(mb.claimJoin(b.id, 'u2', 0.5, 100, 2200), 0, 'miss pays nothing');
    assert.equal(read('bindings.json')[b.id].delivered, 1, 'miss not counted as a join');
    assert.ok(read('bindings.json')[b.id].users.u2, 'but the clicker is deduped');
});

test('claimJoin auto-stops at the join limit', () => {
    const b = mb.create('OWNER', 'https://discord.gg/x', DEST, 1000);
    mb.update(b.id, { sources: [SRC_A], pricePer100: 10, limit: 2, running: true }, 1500);
    Math.random = () => 0;
    assert.equal(mb.claimJoin(b.id, 'u1', 1, 100, 2000), 0.10);
    assert.equal(mb.claimJoin(b.id, 'u2', 1, 100, 2100), 0.10);
    const v = mb.get(b.id);
    assert.equal(v.delivered, 2);
    assert.equal(v.running, false);
    assert.equal(v.stoppedReason, 'limit');
    assert.equal(mb.claimJoin(b.id, 'u3', 1, 100, 2200), 0, 'stopped → no more charges');
});

test('claimJoin auto-stops when the owner cannot afford the next join', () => {
    const b = mb.create('OWNER', 'https://discord.gg/x', DEST, 1000);
    mb.update(b.id, { sources: [SRC_A], pricePer100: 100, running: true }, 1500);   // $1.00 / join
    Math.random = () => 0;
    assert.equal(mb.claimJoin(b.id, 'u1', 1, 0.5, 2000), 0, 'balance 0.5 < 1.0 → not charged');
    const v = mb.get(b.id);
    assert.equal(v.delivered, 0);
    assert.equal(v.running, false);
    assert.equal(v.stoppedReason, 'funds');
});

test('price 0 (house) still counts joins but debits nothing', () => {
    const b = mb.create('OWNER', 'https://discord.gg/x', DEST, 1000);
    mb.update(b.id, { sources: [SRC_A], pricePer100: 0, running: true }, 1500);
    Math.random = () => 0;
    assert.equal(mb.claimJoin(b.id, 'u1', 1, 0, 2000), 0, 'house join is free even at balance 0');
    assert.equal(mb.get(b.id).delivered, 1, 'still counted');
});

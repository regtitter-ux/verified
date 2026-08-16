const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const reviews = require('../dmallreviews.js');
const runs = require('../dmallruns.js');

beforeEach(() => reset());

const SID = '111111111111111111';
const U1 = '900000000000000001';
const U2 = '900000000000000002';

test('one review per user: a second post edits the first (stars + text)', () => {
    reviews.upsert(SID, { userId: U1, name: 'A', stars: 5, text: 'great' });
    reviews.upsert(SID, { userId: U1, name: 'A', stars: 2, text: 'changed my mind' });
    const list = reviews.listFor(SID);
    assert.equal(list.length, 1, 'still one review');
    assert.equal(list[0].stars, 2);
    assert.equal(list[0].text, 'changed my mind');
    assert.ok(list[0].editedAt > 0, 'marked edited');
});

test('stars are clamped to 1..5', () => {
    reviews.upsert(SID, { userId: U1, stars: 9, text: 'x' });
    assert.equal(reviews.mineFor(SID, U1).stars, 5);
    reviews.upsert(SID, { userId: U2, stars: 0, text: 'y' });
    assert.equal(reviews.mineFor(SID, U2).stars, 1);
});

test('summary averages and counts', () => {
    reviews.upsert(SID, { userId: U1, stars: 4, text: '' });
    reviews.upsert(SID, { userId: U2, stars: 2, text: '' });
    const s = reviews.summary(SID);
    assert.equal(s.count, 2);
    assert.equal(s.average, 3);
    assert.deepEqual(s.breakdown, [0, 1, 0, 1, 0]);
});

test('delete: author yes, stranger no, admin yes', () => {
    const r = reviews.upsert(SID, { userId: U1, stars: 5, text: 'hi' });
    assert.equal(reviews.remove(SID, r.id, { byUserId: U2 }), false, 'stranger cannot delete');
    assert.equal(reviews.remove(SID, r.id, { byUserId: U1 }), true, 'author can delete');
    const r2 = reviews.upsert(SID, { userId: U1, stars: 5, text: 'hi again' });
    assert.equal(reviews.remove(SID, r2.id, { byUserId: U2, isAdmin: true }), true, 'admin can delete any');
    assert.equal(reviews.listFor(SID).length, 0);
});

test('owner reply set / edit / clear', () => {
    const r = reviews.upsert(SID, { userId: U1, stars: 5, text: 'nice' });
    let v = reviews.setReply(SID, r.id, 'thanks!');
    assert.equal(v.reply.text, 'thanks!');
    v = reviews.setReply(SID, r.id, 'thanks a lot!');
    assert.equal(v.reply.text, 'thanks a lot!');
    assert.ok(v.reply.editedAt > 0);
    v = reviews.setReply(SID, r.id, '   ');   // empty → removes
    assert.equal(v.reply, null);
});

test('reviews are keyed by server, not lot — a new lot for the same server keeps them', () => {
    reviews.upsert(SID, { userId: U1, stars: 5, text: 'kept' });
    // (No lot object involved here; store is serverId-keyed, so recreation can't touch it.)
    assert.equal(reviews.summary(SID).count, 1);
});

test('boughtOn: only someone who ordered to the server is eligible', () => {
    runs.save('R1', { id: 'R1', buyerId: U1, serverId: SID, count: 100, charge: 0 });
    assert.equal(runs.boughtOn(SID, U1), true);
    assert.equal(runs.boughtOn(SID, U2), false);
    assert.equal(runs.boughtOn('222222222222222222', U1), false);
});

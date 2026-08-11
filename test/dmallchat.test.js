const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const dmallchat = require('../dmallchat.js');

const A = '111111111111111111', B = '222222222222222222';
beforeEach(() => reset());

test('post/list/get: messages persist newest-last and round-trip', () => {
    const m1 = dmallchat.post({ userId: A, name: 'Alice', avatar: null, body: 'hello' });
    const m2 = dmallchat.post({ userId: B, name: 'Bob', body: 'hi there', reply: { userId: A, name: 'Alice', text: 'hello' } });
    const list = dmallchat.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, m1.id, 'oldest first');
    assert.equal(list[1].id, m2.id, 'newest last');
    assert.deepEqual(list[1].reply, { userId: A, name: 'Alice', text: 'hello' });
    assert.equal(dmallchat.get(m1.id).body, 'hello');
    assert.equal(dmallchat.get('nope'), null);
});

test('post collapses an identical burst from the same user within 3s', () => {
    dmallchat.post({ userId: A, name: 'Alice', body: 'spam' });
    dmallchat.post({ userId: A, name: 'Alice', body: 'spam' });   // instant duplicate → dropped
    assert.equal(dmallchat.list().length, 1, 'duplicate collapsed');
    dmallchat.post({ userId: A, name: 'Alice', body: 'different' });   // different text → kept
    assert.equal(dmallchat.list().length, 2);
});

test('list keeps only the last MAX messages', () => {
    for (let i = 0; i < dmallchat.MAX_CHAT + 15; i++) dmallchat.post({ userId: A, name: 'Alice', body: 'm' + i });
    const list = dmallchat.list();
    assert.equal(list.length, dmallchat.MAX_CHAT);
    assert.equal(list[list.length - 1].body, 'm' + (dmallchat.MAX_CHAT + 14), 'newest survives');
});

test('del removes one; delByUser purges a user', () => {
    const m1 = dmallchat.post({ userId: A, name: 'Alice', body: 'a1' });
    dmallchat.post({ userId: B, name: 'Bob', body: 'b1' });
    dmallchat.post({ userId: A, name: 'Alice', body: 'a2' });
    assert.equal(dmallchat.del(m1.id), true);
    assert.equal(dmallchat.del(m1.id), false, 'already gone');
    assert.equal(dmallchat.list().length, 2);
    assert.equal(dmallchat.delByUser(A), 1, 'one A message left after del');
    assert.deepEqual(dmallchat.list().map((m) => m.userId), [B]);
});

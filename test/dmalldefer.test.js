const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const defer = require('../dmalldefer.js');

const A = '111111111111111111', G = '999000111';
beforeEach(() => reset());

test('add / list / forServer / hasServer / consume', () => {
    assert.equal(defer.hasServer(G), false);
    const it = defer.add({ buyerId: A, serverId: G, remaining: 20000, prepaid: 20, body: { x: 1 }, createdAt: 1 });
    assert.equal(defer.hasServer(G), true);
    assert.equal(defer.forServer(G).length, 1);
    assert.equal(defer.list()[0].remaining, 20000);

    // Consume a leg → remaining + prepaid drop proportionally, item stays.
    const rem = defer.consume(it.id, 12000, 12);
    assert.equal(rem, 8000);
    const cur = defer.forServer(G)[0];
    assert.equal(cur.remaining, 8000);
    assert.equal(cur.prepaid, 8);

    // Drain the rest → item removed.
    defer.consume(it.id, 8000, 8);
    assert.equal(defer.hasServer(G), false);
    assert.equal(defer.list().length, 0);
});

test('add ignores a zero/empty remainder', () => {
    defer.add({ buyerId: A, serverId: G, remaining: 0, prepaid: 0 });
    assert.equal(defer.list().length, 0);
});

test('forServer returns oldest first', () => {
    defer.add({ buyerId: A, serverId: G, remaining: 5000, prepaid: 5, createdAt: 200 });
    defer.add({ buyerId: A, serverId: G, remaining: 3000, prepaid: 3, createdAt: 100 });
    assert.equal(defer.forServer(G)[0].remaining, 3000, 'createdAt 100 comes first');
});

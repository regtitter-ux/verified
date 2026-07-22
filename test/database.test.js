const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../database.js');

beforeEach(() => reset());

test('mutate applies a change and persists it', () => {
    seed({ 'x.json': { v: 10 } });
    const ret = db.mutate('x.json', (d) => { d.v += 5; return d.v; });
    assert.equal(ret, 15, 'returns fn\'s value');
    assert.equal(read('x.json').v, 15, 'change persisted');
});

test('mutate hands fn a DEEP COPY — no shared-cache-reference leak', () => {
    seed({ 'x.json': { v: 10 } });
    const before = db.loadJSON('x.json');          // a cached reference
    db.mutate('x.json', (d) => { d.v = 5; });
    assert.equal(db.loadJSON('x.json').v, 5, 'saved the new value');
    assert.equal(before.v, 10, 'the previously-loaded ref was NOT mutated in place (the double-clawback root cause is impossible via mutate)');
});

test('mutate with `return false` aborts the write (conditional debit pattern)', () => {
    seed({ 'w.json': { u: { balance: 3 } } });
    const ok = db.mutate('w.json', (w) => { if (w.u.balance < 5) return false; w.u.balance -= 5; return true; });
    assert.equal(ok, false);
    assert.equal(read('w.json').u.balance, 3, 'insufficient → nothing saved');

    const ok2 = db.mutate('w.json', (w) => { if (w.u.balance < 2) return false; w.u.balance -= 2; return true; });
    assert.equal(ok2, true);
    assert.equal(read('w.json').u.balance, 1);
});

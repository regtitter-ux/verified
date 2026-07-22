const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const shares = require('../shares.js');

const T = 1_700_000_000_000;
const near = (a, b, eps = 0.0001) => Math.abs(a - b) <= eps;

beforeEach(() => reset());

test('distributeProfit splits profit by percentage, conserving the total', async () => {
    seed({ 'shares.json': { H1: { pct: 50 }, H2: { pct: 50 } }, 'settings.json': {}, 'shareearnings.json': {} });
    const credited = await shares.distributeProfit([], 1.00, T);
    assert.ok(near(credited.H1, 0.50) && near(credited.H2, 0.50), 'each 50% holder gets half');
    const total = Object.values(credited).reduce((a, x) => a + x, 0);
    assert.ok(near(total, 1.00), 'distributed total equals the profit — no money created/lost');
    const s = read('settings.json');
    assert.ok(near(s.H1.balance, 0.50) && near(s.H2.balance, 0.50), 'balances credited to the cent');
});

test('distributeProfit scales down when shareholder pct sums OVER 100 (no over-distribution)', async () => {
    seed({ 'shares.json': { H1: { pct: 60 }, H2: { pct: 60 } }, 'settings.json': {}, 'shareearnings.json': {} });
    const credited = await shares.distributeProfit([], 1.00, T);
    const total = Object.values(credited).reduce((a, x) => a + x, 0);
    assert.ok(near(total, 1.00), `misconfigured 120% total still distributes only the profit, got ${total}`);
    assert.ok(near(credited.H1, 0.50) && near(credited.H2, 0.50), 'scaled proportionally to 50/50 of the profit');
});

test('under-100% leaves the remainder with the house', async () => {
    seed({ 'shares.json': { H1: { pct: 30 } }, 'settings.json': {}, 'shareearnings.json': {} });
    const credited = await shares.distributeProfit([], 1.00, T);
    assert.ok(near(credited.H1, 0.30), 'holder gets exactly their 30%; the other 70% stays house profit');
});

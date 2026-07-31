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

const GID = '100000000000000001';
const SRV_OWNER = '200000000000000002';

test('payShares routes 100% of a server\'s net profit to its assigned owner (bypassing the global split)', async () => {
    seed({
        'siteconfig.json': { serverProfitOwner: { [GID]: SRV_OWNER } },
        'shares.json': { H1: { pct: 100 } }, 'settings.json': {}, 'shareearnings.json': {}, 'serverprofit.json': {}
    });
    // profit = revenue(0.10) − partner(0.05) − acquiring(0.05*0.03=0.0015) = 0.0485
    await shares.payShares([], 0.05, { revenuePerJoin: 0.10, guildId: GID, nowMs: T });
    const s = read('settings.json');
    const led = read('serverprofit.json');
    assert.ok(near(s[SRV_OWNER]?.balance, 0.04), `owner credited whole cents of the profit, got ${s[SRV_OWNER]?.balance}`);
    assert.ok(near(led[SRV_OWNER]?.earned, 0.0485), 'exact profit recorded in the per-server ledger');
    assert.ok(!s.H1 || !(Number(s.H1.balance) > 0), 'the global shareholder gets nothing for an assigned server');
});

test('payShares falls back to the global split when the server has no assigned owner', async () => {
    seed({
        'siteconfig.json': { serverProfitOwner: { [GID]: SRV_OWNER } },
        'shares.json': { H1: { pct: 100 } }, 'settings.json': {}, 'shareearnings.json': {}, 'serverprofit.json': {}
    });
    await shares.payShares([], 0.05, { revenuePerJoin: 0.10, guildId: '999000000000000999', nowMs: T });
    const s = read('settings.json');
    const led = read('serverprofit.json');
    assert.ok(near(s.H1?.balance, 0.04), 'unassigned server profit goes to the global holder');
    assert.ok(!led[SRV_OWNER] || !(Number(led[SRV_OWNER].earned) > 0), 'no per-server credit for an unassigned server');
});

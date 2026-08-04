const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const botfarm = require('../botfarm.js');

const OWNER = '111111111111111111';
const BOT = '222222222222222222';
const near = (a, b, eps = 0.0001) => Math.abs(Number(a) - Number(b)) <= eps;
const links = (n) => Array.from({ length: n }, (_, i) => ({ id: 'L' + i, reserveBotId: BOT, status: 'joined' }));

beforeEach(() => reset());

test('accrue pays the token owner $0.01 per 10 verified entries', () => {
    seed({ 'usertokenmeta.json': { [BOT]: { addedBy: OWNER } }, 'joinlinks.json': links(25), 'settings.json': {}, 'reserveearnings.json': {} });
    botfarm.accrueReserveEarnings();
    const s = read('settings.json');
    assert.ok(near(s[OWNER]?.balance, 0.02), `25 entries → 2 groups of 10 → $0.02, got ${s[OWNER]?.balance}`);
});

test('accrual is idempotent (no double-pay) and only credits NEW groups', () => {
    seed({ 'usertokenmeta.json': { [BOT]: { addedBy: OWNER } }, 'joinlinks.json': links(25), 'settings.json': {}, 'reserveearnings.json': {} });
    botfarm.accrueReserveEarnings();
    botfarm.accrueReserveEarnings();
    assert.ok(near(read('settings.json')[OWNER].balance, 0.02), 'still $0.02 after a second sweep');
    seed({ 'joinlinks.json': links(40) });   // 40 entries → 4 groups → $0.04; settings/earnings persist on disk
    botfarm.accrueReserveEarnings();
    assert.ok(near(read('settings.json')[OWNER].balance, 0.04), 'topped up to $0.04 for the two new groups');
});

test('entries verified by a token with no known owner are not paid', () => {
    seed({ 'usertokenmeta.json': {}, 'joinlinks.json': links(50), 'settings.json': {}, 'reserveearnings.json': {} });
    botfarm.accrueReserveEarnings();
    assert.deepEqual(read('settings.json'), {}, 'nobody credited when the bot has no addedBy owner');
});

test('leaves do not reduce the reward — an entry counts once, whatever its later status', () => {
    const mixed = links(10);
    mixed.forEach((r, i) => { if (i < 7) r.status = 'left'; });   // 10 entries; 7 later left
    seed({ 'usertokenmeta.json': { [BOT]: { addedBy: OWNER } }, 'joinlinks.json': mixed, 'settings.json': {}, 'reserveearnings.json': {} });
    botfarm.accrueReserveEarnings();
    assert.ok(near(read('settings.json')[OWNER].balance, 0.01), '10 entries → $0.01 regardless of later leaves');
});

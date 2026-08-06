require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { reset, seed } = require('./setup');
const ct = require('../calibtrack.js');

const NOW = 1_700_000_000_000;
beforeEach(() => reset());

const M = { creatorId: '833442190427684914', roleId: 'R', channelId: 'CH', campaignId: 'CID' };

test('conversion = net real joins ÷ unique clickers, attributed to the click (with pay meta)', () => {
    for (const u of ['u1', 'u2', 'u3', 'u4']) ct.recordClick(u, 'A', 'SP', M, NOW);   // 4 clickers on server A
    assert.equal(ct.clickers('A'), 4);
    assert.equal(ct.conversionFor('A'), null, 'no joins yet → null');
    const a1 = ct.onJoin('u1', 'SP', NOW + 1000);
    assert.equal(a1 && a1.g, 'A', 'real join attributed to A');
    assert.equal(a1.cr, M.creatorId, 'carries the partner id for crediting');
    assert.equal(ct.onJoin('u2', 'SP', NOW + 2000).g, 'A');
    assert.equal(ct.netJoins('A'), 2);
    assert.equal(ct.conversionFor('A'), 0.5, '2 real joins / 4 clickers = 0.50');
});

test('a join with no calibration click is not attributed (organic / other source)', () => {
    ct.recordClick('u1', 'A', 'SP', M, NOW);
    assert.equal(ct.onJoin('u2', 'SP', NOW + 1000), null, 'u2 never clicked → not ours');
    assert.equal(ct.netJoins('A'), 0);
});

test('leaving drops the join from the net conversion; a genuine re-join counts again', () => {
    ct.recordClick('u1', 'A', 'SP', M, NOW);
    ct.onJoin('u1', 'SP', NOW + 1000);
    assert.equal(ct.netJoins('A'), 1);
    ct.onLeave('u1', 'SP', NOW + 2000);
    assert.equal(ct.netJoins('A'), 0, 'left → not a net stay');
    assert.equal(ct.onJoin('u1', 'SP', NOW + 3000).g, 'A', 're-join after a tracked leave');
    assert.equal(ct.netJoins('A'), 1);
});

test('an active tracked join is never double-counted', () => {
    ct.recordClick('u1', 'A', 'SP', M, NOW);
    ct.onJoin('u1', 'SP', NOW + 1000);
    assert.equal(ct.onJoin('u1', 'SP', NOW + 1500), null, 'already active → no second attribution');
    assert.equal(ct.netJoins('A'), 1);
});

test('a join is attributed to the MOST RECENT calibration click across servers', () => {
    ct.recordClick('u1', 'A', 'SP', M, NOW);
    ct.recordClick('u1', 'B', 'SP', M, NOW + 500);       // clicked B more recently
    assert.equal(ct.onJoin('u1', 'SP', NOW + 1000).g, 'B');
    assert.equal(ct.netJoins('B'), 1);
    assert.equal(ct.netJoins('A'), 0);
    assert.equal(ct.clickers('A'), 1, 'A still counts its clicker in the denominator');
});

test('conversion is measured PER CARD (role + creator), not pooled onto every card', () => {
    const A = { creatorId: 'CR', roleId: 'R1', channelId: 'CH', campaignId: 'CID' };
    const B = { creatorId: 'CR', roleId: 'R2', channelId: 'CH', campaignId: 'CID' };   // same server + owner, different card
    ct.recordClick('u1', 'G', 'SP', A, NOW); ct.recordClick('u2', 'G', 'SP', A, NOW);   // card A: 2 clickers
    ct.recordClick('u3', 'G', 'SP', B, NOW); ct.recordClick('u4', 'G', 'SP', B, NOW);   // card B: 2 clickers
    ct.onJoin('u1', 'SP', NOW + 1);                                                      // u1 (card A) really joins
    assert.equal(ct.conversionFor('G', 'R1', 'CR'), 0.5, 'card A = 1 join / 2 clickers');
    assert.equal(ct.conversionFor('G', 'R2', 'CR'), null, 'card B has its own (no joins yet) — NOT card A\'s number');
    assert.equal(ct.conversionFor('G'), 0.25, 'server-level pools all cards (1/4)');
    assert.equal(ct.netJoins('G'), 1, 'server delivery counter sums all cards');
});

test('migrateJoins() backfills the card (role+creator) onto old joins from the matching click', () => {
    // Old-format data: click carries the card, but the join (pre-per-card) does not.
    seed({ 'calibtrack.json': {
        clicks: [{ u: 'u1', g: 'G', sp: 'SP', t: NOW, r: 'R1', cr: 'CR' }],
        joins: [{ u: 'u1', g: 'G', sp: 'SP', t: NOW + 1, left: 0 }]   // no r/cr
    } });
    assert.equal(ct.netJoins('G', 'R1', 'CR'), 0, 'before migrate: old join not attributed to its card');
    ct.migrateJoins();
    assert.equal(ct.netJoins('G', 'R1', 'CR'), 1, 'after migrate: join attributed to its card');
    assert.equal(ct.conversionFor('G', 'R1', 'CR'), 1, '1 join / 1 clicker');
    assert.equal(ct.netJoins('G'), 1, 'server-level unchanged');
});

test('unattributed() lists clicks with no active tracked join (for the reconcile sweep)', () => {
    ct.recordClick('u1', 'A', 'SP', M, NOW);
    ct.recordClick('u2', 'A', 'SP', M, NOW);
    ct.onJoin('u1', 'SP', NOW + 1000);                    // u1 tracked, u2 not yet
    const pend = ct.unattributed();
    assert.equal(pend.length, 1);
    assert.equal(pend[0].u, 'u2');
    assert.equal(pend[0].cr, M.creatorId, 'carries pay meta so the sweep can credit');
});

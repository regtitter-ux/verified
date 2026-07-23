const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const campaigns = require('../campaigns.js');
const { adKeyOf } = require('../adcreative.js');

const INVITE = 'https://discord.gg/sharedx';
const KEY = adKeyOf(INVITE);
const T1 = 1_700_000_000_000;   // A paid first
const T2 = T1 + 60_000;          // B paid later

// N verified joins on the shared ad-key, one per distinct user, after both paidAt.
function joins(n, base = T2 + 1000) {
    return Array.from({ length: n }, (_, i) => ({ id: 'U' + i, guildId: 'CARD', roleId: 'R', creatorId: 'P', timestamp: base + i, adKey: KEY }));
}

beforeEach(() => reset());

test('two active campaigns sharing an invite never double-count a join (FIFO allocation)', () => {
    const camps = {
        A: { id: 'A', invite: INVITE, sponsorGuildId: 'S', purchased: 2, status: 'active', paidAt: T1, adKeys: [] },
        B: { id: 'B', invite: INVITE, sponsorGuildId: 'S', purchased: 2, status: 'active', paidAt: T2, adKeys: [] },
    };
    const verified = joins(3);          // 3 distinct users joined via the shared invite
    seed({ 'campaigns.json': camps, 'verified.json': verified });

    const dA = campaigns.delivered(camps.A, verified, camps);
    const dB = campaigns.delivered(camps.B, verified, camps);

    // Each join counts toward exactly ONE campaign: totals sum to the real join
    // count, never above it (the double-count bug summed to ~2x).
    assert.equal(dA + dB, 3, 'sum of delivered equals distinct real joins (no double-count)');
    assert.ok(dA <= camps.A.purchased && dB <= camps.B.purchased, 'no campaign over its purchased');
    // FIFO by paidAt: the earlier-paid A fills first (2), B gets the overflow (1).
    assert.equal(dA, 2);
    assert.equal(dB, 1);
});

test('a brand-new campaign queued behind an unfilled earlier one delivers 0', () => {
    const camps = {
        A: { id: 'A', invite: INVITE, sponsorGuildId: 'S', purchased: 100, status: 'active', paidAt: T1, adKeys: [] },
        B: { id: 'B', invite: INVITE, sponsorGuildId: 'S', purchased: 50, status: 'active', paidAt: T2, adKeys: [] },
    };
    const verified = joins(5);   // 5 joins, A has room (100) → all go to A, B waits
    seed({ 'campaigns.json': camps, 'verified.json': verified });

    assert.equal(campaigns.delivered(camps.A, verified, camps), 5);
    assert.equal(campaigns.delivered(camps.B, verified, camps), 0, 'newest campaign is queued, not double-counting A\'s joins');
});

test('a fulfilled (completed) campaign is NEVER reopened, even if it drops below target', async () => {
    // Reached target once (fulfilled), but only 3 of 5 joins remain now (2 churned).
    const camps = { A: { id: 'A', invite: INVITE, sponsorGuildId: 'S', purchased: 5, status: 'complete', fulfilled: true, paidAt: T1, completedAt: T1 + 1000, adKeys: [], inviteCheckedAt: T1 + 1000 } };
    seed({ 'campaigns.json': camps, 'verified.json': joins(3), 'sponsorshow.json': {}, 'sponsorera.json': {}, 'siteconfig.json': {} });
    await campaigns.reconcile([]);
    assert.equal(read('campaigns.json').A.status, 'complete', 'fulfilled order stays complete — no re-open, no duplicate "Campaign complete!"');
});

test('a legacy completion still at/above target is stamped fulfilled (terminal) by reconcile', async () => {
    const camps = { A: { id: 'A', invite: INVITE, sponsorGuildId: 'S', purchased: 3, status: 'complete', paidAt: T1, completedAt: T1 + 1000, adKeys: [], inviteCheckedAt: T1 + 1000 } };
    seed({ 'campaigns.json': camps, 'verified.json': joins(4), 'sponsorshow.json': {}, 'sponsorera.json': {}, 'siteconfig.json': {} });
    await campaigns.reconcile([]);
    const A = read('campaigns.json').A;
    assert.equal(A.status, 'complete');
    assert.equal(A.fulfilled, true, 'backfilled terminal so it can never re-open later');
});

test('a unique-invite campaign counts its own joins (deduped by user)', () => {
    const camps = { A: { id: 'A', invite: INVITE, sponsorGuildId: 'S', purchased: 100, status: 'active', paidAt: T1, adKeys: [] } };
    const verified = [
        ...joins(3),
        { id: 'U0', guildId: 'CARD2', roleId: 'R', creatorId: 'P', timestamp: T2 + 5000, adKey: KEY }, // U0 again on another card → same user, counts once
    ];
    seed({ 'campaigns.json': camps, 'verified.json': verified });
    assert.equal(campaigns.delivered(camps.A, verified, camps), 3, 'unique users, not raw entries');
});

const { seed, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const campaigns = require('../campaigns.js');
const { adKeyOf } = require('../adcreative.js');

const INVITE = 'https://discord.gg/sponsorx';
const KEY = adKeyOf(INVITE);
const PAID = 1_700_000_000_000;
const joins = (n) => Array.from({ length: n }, (_, i) => ({ id: 'U' + i, guildId: 'SPON', roleId: 'R', creatorId: 'P', timestamp: PAID + 1000 + i, adKey: KEY }));

beforeEach(() => reset());

test('delivered subtracts joiners who LEFT the sponsor (stays product), not those who left elsewhere', () => {
    const A = { id: 'A', invite: INVITE, sponsorGuildId: 'SPON', status: 'active', purchased: 100, paidAt: PAID };
    seed({
        'campaigns.json': { A }, 'verified.json': joins(20),
        'joinlinks.json': [
            { userId: 'U0', guildId: 'SPON', status: 'left' },     // left the sponsor → drop
            { userId: 'U1', guildId: 'SPON', status: 'left' },
            { userId: 'U2', guildId: 'SPON', status: 'left' },
            { userId: 'U3', guildId: 'OTHER', status: 'left' },    // left a different server → still counts
            { userId: 'U4', guildId: 'SPON', status: 'joined' }    // still standing → counts
        ]
    });
    assert.equal(campaigns.delivered(A, joins(20), { A }), 17, '20 joined − 3 who left the sponsor = 17 net stays');
});

test('with no leavers the count is unchanged (gross == net)', () => {
    const A = { id: 'A', invite: INVITE, sponsorGuildId: 'SPON', status: 'active', purchased: 100, paidAt: PAID };
    seed({ 'campaigns.json': { A }, 'verified.json': joins(12), 'joinlinks.json': [] });
    assert.equal(campaigns.delivered(A, joins(12), { A }), 12);
});

test('leavers are dropped in the shared-invite cohort allocation too', () => {
    // Two campaigns share the invite (same sponsor); B paid later. 15 joins, 5 left.
    const A = { id: 'A', invite: INVITE, sponsorGuildId: 'SPON', status: 'active', purchased: 10, paidAt: PAID };
    const B = { id: 'B', invite: INVITE, sponsorGuildId: 'SPON', status: 'active', purchased: 10, paidAt: PAID + 60000 };
    const jl = ['U0', 'U1', 'U2', 'U3', 'U4'].map((u) => ({ userId: u, guildId: 'SPON', status: 'left' }));
    seed({ 'campaigns.json': { A, B }, 'verified.json': joins(15), 'joinlinks.json': jl });
    // 15 − 5 = 10 net stays; A (earliest) fills its 10 first, B gets 0.
    assert.equal(campaigns.delivered(A, joins(15), { A, B }), 10, 'A takes the 10 net stays');
    assert.equal(campaigns.delivered(B, joins(15), { A, B }), 0, 'nothing left for B');
});

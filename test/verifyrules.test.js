const { test } = require('node:test');
const assert = require('node:assert');
const { shouldCountJoin, isDuplicateJoin } = require('../verifyrules.js');

test('shouldCountJoin requires role + ad shown + adRaw + resolved sponsor + not a dup', () => {
    const ok = { roleId: 'R', adShown: true, adRaw: 'https://discord.gg/x', sponsor: { guildId: 'S' }, isDupJoin: false };
    assert.equal(shouldCountJoin(ok), true);

    assert.equal(shouldCountJoin({ ...ok, sponsor: null }), false, 'no sponsor resolved → not counted (transient-failure guard)');
    assert.equal(shouldCountJoin({ ...ok, isDupJoin: true }), false, 'duplicate → not counted');
    assert.equal(shouldCountJoin({ ...ok, adShown: false }), false, 'no ad shown → not counted');
    assert.equal(shouldCountJoin({ ...ok, adRaw: '' }), false, 'no raw ad → not counted');
    assert.equal(shouldCountJoin({ ...ok, roleId: null }), false, 'legacy no-role card → never counts');
});

test('isDuplicateJoin flags a user already joined/settled for the sponsor', () => {
    const jl = [
        { userId: 'U1', guildId: 'S1', status: 'joined' },
        { userId: 'U2', guildId: 'S1', status: 'left' },
        { userId: 'U3', guildId: 'S1', status: 'settled' },
    ];
    assert.equal(isDuplicateJoin(jl, 'U1', 'S1'), true, 'live joined → dup');
    assert.equal(isDuplicateJoin(jl, 'U3', 'S1'), true, 'settled (kept) → dup');
    assert.equal(isDuplicateJoin(jl, 'U2', 'S1'), false, 'left (reversed) → NOT a dup, a real rejoin counts again');
    assert.equal(isDuplicateJoin(jl, 'U1', 'S2'), false, 'different sponsor → not a dup');
    assert.equal(isDuplicateJoin([], 'U1', 'S1'), false);
    assert.equal(isDuplicateJoin(jl, 'U1', null), false, 'missing sponsor id → not a dup');
});

const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const jc = require('../joincheck.js');

const P = 'PARTNER', REF = 'REFERRER', U = 'USER1', SPON = 'SPONSOR', CARD = 'CARD', R = 'ROLE1';
const now = 1_700_000_000_000; // fixed base ts (Date.now unavailable constraint doesn't apply in tests)

function seedBase(extra = {}) {
    seed({
        'settings.json': { [P]: { balance: 10, advText: '', serverAds: {}, partners: [] }, ...extra.settings },
        'joinlinks.json': extra.joinlinks || [],
        'sponsorshow.json': { [SPON]: Date.now() },   // ad currently showing
        'sponsorera.json': {},                          // no era → join never predates
        'siteconfig.json': {},
        'campaigns.json': {},
        ...extra.files,
    });
}

beforeEach(() => reset());

test('creditJoin credits the partner exactly once and records a joined joinlink', () => {
    seedBase();
    const r1 = jc.creditJoin(P, SPON, U, CARD, R, null);
    assert.equal(r1.duplicate, false);
    assert.equal(r1.amount, 0.05);
    assert.equal(read('settings.json')[P].balance, 10.05);
    const jl = read('joinlinks.json');
    assert.equal(jl.length, 1);
    assert.equal(jl[0].status, 'joined');
    assert.equal(jl[0].amount, 0.05);

    // Second call for the SAME (user, sponsor) is a duplicate — no double credit.
    const r2 = jc.creditJoin(P, SPON, U, CARD, R, null);
    assert.equal(r2.duplicate, true);
    assert.equal(r2.amount, 0);
    assert.equal(read('settings.json')[P].balance, 10.05, 'balance unchanged on duplicate');
    assert.equal(read('joinlinks.json').length, 1, 'no second joinlink');
});

test('creditJoin pays the referrer their bonus once and stores it on the joinlink', () => {
    // Partner bids $10/100 → $0.10/join; referrer earns 10% = $0.01.
    seedBase({ settings: {
        [P]: { balance: 0, joinBid: 10, advText: '', serverAds: {}, partners: [] },
        [REF]: { balance: 0, referrals: [P], advText: '', serverAds: {}, partners: [] },
    } });
    const r = jc.creditJoin(P, SPON, U, CARD, R, null);
    assert.equal(r.amount, 0.10);
    assert.equal(r.referrerId, REF);
    assert.equal(r.refBonus, 0.01);
    const s = read('settings.json');
    assert.equal(s[P].balance, 0.10);
    assert.equal(s[REF].balance, 0.01);
    assert.equal(read('joinlinks.json')[0].refBonus, 0.01, 'bonus stored for symmetric reversal');
});

test('finalizeLeavers claws back exactly once (single debit) and is idempotent', async () => {
    seedBase({ joinlinks: [{ id: 'J1', userId: U, guildId: SPON, creatorId: P, amount: 0.05, status: 'joined', cardGuildId: CARD, roleId: R, ts: now }] });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 9.95, 'single debit, not double (regression: loadJSON shared-cache)');
    assert.equal(read('joinlinks.json')[0].status, 'left');

    // Re-running must not debit again (winning the joined->left transition is the guard).
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 9.95, 'idempotent — no second debit');
});

test('finalizeLeavers reverses the referral bonus symmetrically', async () => {
    seedBase({
        settings: {
            [P]: { balance: 0.10, advText: '', serverAds: {}, partners: [] },
            [REF]: { balance: 0.01, advText: '', serverAds: {}, partners: [] },
        },
        joinlinks: [{ id: 'J1', userId: U, guildId: SPON, creatorId: P, amount: 0.10, status: 'joined', cardGuildId: CARD, roleId: R, ts: now, referrerId: REF, refBonus: 0.01 }],
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    const s = read('settings.json');
    assert.equal(s[P].balance, 0, 'partner clawed back exactly the payout');
    assert.equal(s[REF].balance, 0, 'referrer clawed back exactly the stored bonus');
});

test('finalizeLeavers does NOT claw back when the sponsor ad is not showing (settled)', async () => {
    seedBase({
        joinlinks: [{ id: 'J1', userId: U, guildId: SPON, creatorId: P, amount: 0.05, status: 'joined', cardGuildId: CARD, roleId: R, ts: now }],
        files: { 'sponsorshow.json': {} },   // ad NOT showing
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 10, 'no clawback — partner keeps the payout');
    assert.equal(read('joinlinks.json')[0].status, 'settled');
});

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

test('finalizeLeavers STILL claws back when the sponsor advertised within the day (rotation gap ≠ deal over)', async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // stale for the 30-min display window, fresh for the 24h clawback window
    seedBase({
        joinlinks: [{ id: 'J1', userId: U, guildId: SPON, creatorId: P, amount: 0.05, status: 'joined', cardGuildId: CARD, roleId: R, ts: now }],
        files: { 'sponsorshow.json': { [SPON]: oneHourAgo } },
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 9.95, 'clawed back — a 1h rotation gap must not settle an active-campaign leaver');
    assert.equal(read('joinlinks.json')[0].status, 'left');
});

test('finalizeLeavers does NOT claw back when the sponsor has been dark for over a day (deal over → settled)', async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    seedBase({
        joinlinks: [{ id: 'J1', userId: U, guildId: SPON, creatorId: P, amount: 0.05, status: 'joined', cardGuildId: CARD, roleId: R, ts: now }],
        files: { 'sponsorshow.json': { [SPON]: twoDaysAgo } },
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 10, 'not clawed — sponsor genuinely stopped advertising');
    assert.equal(read('joinlinks.json')[0].status, 'settled');
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

// --- Root #3: clawback gated on the delivering campaign's OWN lifecycle when the
// join carries a campaignId (stamped at credit time), not on ad-display timestamps.
const CAMP = 'CAMP1';
function taggedLink() {
    return { id: 'J1', userId: U, guildId: SPON, creatorId: P, amount: 0.05, status: 'joined', cardGuildId: CARD, roleId: R, ts: now, campaignId: CAMP };
}

test('finalizeLeavers claws back a campaign-tagged join while the campaign is LIVE — even with an empty sponsorshow (the 0c530cb fix: a display gap no longer stops clawbacks)', async () => {
    seedBase({
        joinlinks: [taggedLink()],
        files: { 'sponsorshow.json': {}, 'campaigns.json': { [CAMP]: { id: CAMP, sponsorGuildId: SPON, status: 'active', purchased: 100 } } },
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 9.95, 'clawed — campaign is active, so the freed slot refills; ad-display timestamps are irrelevant');
    assert.equal(read('joinlinks.json')[0].status, 'left');
});

test('finalizeLeavers SETTLES a campaign-tagged join once the campaign is complete (closed deal)', async () => {
    seedBase({
        joinlinks: [taggedLink()],
        files: { 'sponsorshow.json': { [SPON]: Date.now() }, 'campaigns.json': { [CAMP]: { id: CAMP, sponsorGuildId: SPON, status: 'complete', fulfilled: true, purchased: 100 } } },
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 10, 'not clawed — the campaign closed, so no slot to refill even though the ad recently showed');
    assert.equal(read('joinlinks.json')[0].status, 'settled');
});

test('finalizeLeavers SETTLES a campaign-tagged join while the campaign is paused', async () => {
    seedBase({
        joinlinks: [taggedLink()],
        files: { 'sponsorshow.json': { [SPON]: Date.now() }, 'campaigns.json': { [CAMP]: { id: CAMP, sponsorGuildId: SPON, status: 'active', paused: true, purchased: 100 } } },
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 10, 'not clawed — a paused campaign is not currently an open deal');
    assert.equal(read('joinlinks.json')[0].status, 'settled');
});

test('finalizeLeavers SETTLES a campaign-tagged join when the campaign no longer exists (missing)', async () => {
    seedBase({
        joinlinks: [taggedLink()],
        files: { 'sponsorshow.json': { [SPON]: Date.now() }, 'campaigns.json': {} },   // campaign gone
    });
    await jc.finalizeLeavers([], new Set(['J1']));
    assert.equal(read('settings.json')[P].balance, 10, 'not clawed — no live campaign backs this join');
    assert.equal(read('joinlinks.json')[0].status, 'settled');
});

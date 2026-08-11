const { seed, read, reset } = require('./setup');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const wallet = require('../wallet.js');
const dmallop = require('../dmallop.js');
const dmallruns = require('../dmallruns.js');
const { performDmallRunCreate } = require('../api.js');

const BUYER = 'BUYER', CREATOR = 'CREATOR', GID = '999000111';
let runSeq = 0;
const origRunCreate = dmallop.runCreate;

beforeEach(() => {
    reset();
    runSeq = 0;
    // Stub the external operator: every create yields a fresh run id, echoing the body.
    dmallop.runCreate = async (body) => ({ ok: true, status: 200, body: { run: { id: 'RUN' + (++runSeq), template_name: 't' }, echo: body } });
});
afterEach(() => { dmallop.runCreate = origRunCreate; });

const runBody = () => ({ template_id: 'TPL1', server_ids: [GID], message_limit: 1000, targeting: { audience: 'all' }, options: {}, destination_link: '' });

// Creating a run against someone else's lot charges the buyer creatorPrice+fee upfront and
// persists the body so "Repeat" can re-run it. A repeat is a second, independent billable run.
test('lot run charges buyer, stores repeat body; repeat charges again and tracks a new run', async () => {
    seed({
        'wallets.json': { [BUYER]: { balance: 20, topups: [] } },
        'dmalllots.json': { L1: { id: 'L1', creatorId: CREATOR, serverId: GID, serverName: 'S', pricePer1k: 5, createdAt: 1 } },
    });
    const out = await performDmallRunCreate(BUYER, false, runBody(), 'idem-a');
    assert.equal(out.status, 200);
    assert.equal(out.payload.charged, 6, 'creatorPrice $5 + fee $1 per 1k');
    assert.equal(wallet.balanceOf(BUYER), 14);
    const stored = dmallruns.get('RUN1');
    assert.ok(stored && stored.body && stored.body.template_id === 'TPL1', 'run body persisted for repeat');
    assert.equal(stored.creatorId, CREATOR);
    assert.equal(stored.creatorPrice, 5);

    // Repeat: re-run the stored body → a NEW run, charged again.
    const rep = await performDmallRunCreate(BUYER, false, { ...stored.body }, 'repeat-RUN1-1');
    assert.equal(rep.payload.run.id, 'RUN2', 'a distinct new run');
    assert.equal(rep.payload.charged, 6);
    assert.equal(wallet.balanceOf(BUYER), 8, 'charged a second time');
    assert.ok(dmallruns.get('RUN2'), 'the repeat is tracked too');
});

// The same idempotency key never charges twice (double-click / retry safety).
test('a repeated idempotency key returns the first run without a second charge', async () => {
    seed({ 'wallets.json': { [BUYER]: { balance: 10, topups: [] } } });
    const a = await performDmallRunCreate(BUYER, false, runBody(), 'idem-dup');
    assert.equal(a.payload.run.id, 'RUN1');
    assert.equal(wallet.balanceOf(BUYER), 9, 'fee-only $1 charged once');
    const b = await performDmallRunCreate(BUYER, false, runBody(), 'idem-dup');
    assert.equal(b.payload.duplicate, true);
    assert.equal(b.payload.run.id, 'RUN1', 'returns the first run');
    assert.equal(wallet.balanceOf(BUYER), 9, 'no second charge');
});

// Staff broadcast free — no charge, but the body is still stored so they can repeat.
test('staff run with no lot is free (own/no lot: only the waived service fee)', async () => {
    seed({ 'wallets.json': { [BUYER]: { balance: 3, topups: [] } } });
    const out = await performDmallRunCreate(BUYER, true, runBody(), 'idem-staff');
    assert.equal(out.payload.charged, 0);
    assert.equal(wallet.balanceOf(BUYER), 3, 'staff not charged');
    assert.ok(dmallruns.get('RUN1').body.template_id === 'TPL1');
});

// Staff only get the $1/1k service fee waived — on someone else's lot they still pay the
// creator's price, which is credited to the creator.
test('staff on another lot pays the creator price (fee waived), credited to the creator', async () => {
    seed({
        'wallets.json': { [BUYER]: { balance: 20, topups: [] } },
        'dmalllots.json': { L1: { id: 'L1', creatorId: CREATOR, serverId: GID, serverName: 'S', pricePer1k: 5, createdAt: 1 } },
    });
    const out = await performDmallRunCreate(BUYER, true, runBody(), 'idem-staff-lot');
    assert.equal(out.payload.charged, 5, 'creator price $5/1k, no $1 service fee');
    assert.equal(wallet.balanceOf(BUYER), 15);
    const stored = dmallruns.get('RUN1');
    assert.equal(stored.creatorId, CREATOR);
    assert.equal(stored.creatorPrice, 5, 'creator still earns their price on settlement');
});

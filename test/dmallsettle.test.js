const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const wallet = require('../wallet.js');
const ledger = require('../ledger.js');
const { settleDmallRun } = require('../api.js');

const BUYER = 'BUYER';
const CREATOR = 'CREATOR';
beforeEach(() => reset());

// A DMALL run charges the buyer UPFRONT for the requested count. On its terminal state we
// refund the undelivered portion and pay the lot creator ONLY for delivered messages.
test('under-delivery refunds the buyer and pays the creator pro-rata', () => {
    // count=1000, creatorPrice=$5/1k, fee=$1/1k → buyer paid $6 upfront (balance already 0).
    seed({
        'wallets.json': { [BUYER]: { balance: 0, topups: [] } },
        'dmallruns.json': { R1: { id: 'R1', buyerId: BUYER, count: 1000, charge: 6, creatorId: CREATOR, creatorPrice: 5, fee: 1, settled: false } },
    });
    settleDmallRun('R1', { status: 'completed', messages_sent: 600 });
    // Undelivered 400/1000 of the $6 hold → $2.40 back to the buyer.
    assert.equal(wallet.balanceOf(BUYER), 2.4);
    // Creator earns their price for the 600 delivered only → $3.00.
    assert.equal(ledger.balanceOf(CREATOR), 3);
    assert.equal(read('dmallruns.json').R1.settled, true);

    // Idempotent: a second settle (repeat poll) must not refund or pay again.
    settleDmallRun('R1', { status: 'completed', messages_sent: 600 });
    assert.equal(wallet.balanceOf(BUYER), 2.4);
    assert.equal(ledger.balanceOf(CREATOR), 3);
});

test('a failed run with zero delivered refunds the full hold, pays the creator nothing', () => {
    seed({
        'wallets.json': { [BUYER]: { balance: 0, topups: [] } },
        'dmallruns.json': { R2: { id: 'R2', buyerId: BUYER, count: 500, charge: 3, creatorId: CREATOR, creatorPrice: 5, fee: 1, settled: false } },
    });
    settleDmallRun('R2', { status: 'failed', messages_sent: 0 });
    assert.equal(wallet.balanceOf(BUYER), 3, 'full refund');
    assert.equal(ledger.balanceOf(CREATOR), 0, 'creator paid nothing');
});

test('full delivery keeps the charge and pays the creator in full', () => {
    seed({
        'wallets.json': { [BUYER]: { balance: 0, topups: [] } },
        'dmallruns.json': { R3: { id: 'R3', buyerId: BUYER, count: 1000, charge: 6, creatorId: CREATOR, creatorPrice: 5, fee: 1, settled: false } },
    });
    settleDmallRun('R3', { status: 'completed', messages_sent: 1000 });
    assert.equal(wallet.balanceOf(BUYER), 0, 'no refund when fully delivered');
    assert.equal(ledger.balanceOf(CREATOR), 5, 'creator paid for the full 1000');
});

test('a still-running run is not settled (no premature refund/payout)', () => {
    seed({
        'wallets.json': { [BUYER]: { balance: 0, topups: [] } },
        'dmallruns.json': { R4: { id: 'R4', buyerId: BUYER, count: 1000, charge: 6, creatorId: CREATOR, creatorPrice: 5, fee: 1, settled: false } },
    });
    settleDmallRun('R4', { status: 'running', messages_sent: 300 });
    assert.equal(wallet.balanceOf(BUYER), 0);
    assert.equal(ledger.balanceOf(CREATOR), 0);
    assert.equal(read('dmallruns.json').R4.settled, false);
});

test('no lot (self-serve) settles with a fee-only refund and no creator payout', () => {
    // Broadcasting with no lot: buyer paid only the $1/1k fee, no creator.
    seed({
        'wallets.json': { [BUYER]: { balance: 0, topups: [] } },
        'dmallruns.json': { R5: { id: 'R5', buyerId: BUYER, count: 1000, charge: 1, creatorId: '', creatorPrice: 0, fee: 1, settled: false } },
    });
    settleDmallRun('R5', { status: 'stopped', messages_sent: 250 });
    // Undelivered 750/1000 of the $1 fee → $0.75 back.
    assert.equal(wallet.balanceOf(BUYER), 0.75);
    assert.equal(ledger.balanceOf(CREATOR), 0);
});

const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const payouts = require('../payouts.js');

const near = (a, b, eps = 0.0001) => Math.abs(Number(a) - Number(b)) <= eps;
const U = '100000000000000001';

beforeEach(() => reset());

// A 'review' withdrawal had its balance consumed but never refunded (the bug that
// stranded money). Retry must restore it and re-file the payout — no longer stuck.
test('retryWithdrawal on a review restores the balance and re-runs the payout', async () => {
    seed({ 'settings.json': {
        [U]: { balance: 0, withdrawals: [
            { id: 'w-review', amount: 10.02, status: 'review', method: 'nowpayments_ltc', createdAt: 1 }
        ] }
    } });
    const r = await payouts.retryWithdrawal([], U, 'w-review');
    assert.ok(r.ok, 'retry succeeded');
    assert.ok(near(r.restored, 10.02), 'the consumed amount was restored');
    const s = read('settings.json')[U];
    const old = s.withdrawals.find((w) => w.id === 'w-review');
    assert.equal(old.status, 'retried', 'the stuck review record is marked retried (not actionable again)');
    // No auto-payout method is configured in tests, so the restored balance is
    // re-filed as a fresh manual 'processing' request — the money is LIVE, not stuck.
    const refiled = s.withdrawals.find((w) => w.status === 'processing' && near(w.amount, 10.02));
    assert.ok(refiled, 'the amount was re-filed as a fresh live withdrawal request');
    assert.ok(near(s.balance, 0), 'balance moved into the fresh request (not left double-credited)');
});

// A 'failed' record was ALREADY refunded by the settle sweep, so retry must NOT
// credit again (that would create money). Seed balance 0 to isolate the guard.
test('retryWithdrawal on a failed record does not double-refund', async () => {
    seed({ 'settings.json': {
        [U]: { balance: 0, withdrawals: [
            { id: 'w-failed', amount: 10.02, status: 'failed', method: 'nowpayments_ltc', createdAt: 1 }
        ] }
    } });
    const r = await payouts.retryWithdrawal([], U, 'w-failed');
    assert.ok(r.ok && r.restored === 0, 'failed retry restores nothing (money already back)');
    const s = read('settings.json')[U];
    assert.equal(s.withdrawals.find((w) => w.id === 'w-failed').status, 'retried');
    assert.ok(near(s.balance, 0), 'no phantom credit — balance stays 0 (below threshold, no re-file)');
});

// A MANUAL request (status 'processing', no provider payoutId) can sit forever —
// e.g. filed before crypto auto-payout was turned on. Retry restores + re-runs.
test('retryWithdrawal on a stuck manual processing request restores + re-runs', async () => {
    seed({ 'settings.json': {
        [U]: { balance: 0, withdrawals: [
            { id: 'w-manual', amount: 10.00, status: 'processing', requisites: 'ltc1q...', createdAt: 1 } // no payoutId/method → manual
        ] }
    } });
    const r = await payouts.retryWithdrawal([], U, 'w-manual');
    assert.ok(r.ok, 'manual processing is retryable');
    assert.ok(near(r.restored, 10.00), 'the zeroed balance is restored');
    const s = read('settings.json')[U];
    assert.equal(s.withdrawals.find((w) => w.id === 'w-manual').status, 'retried');
    const refiled = s.withdrawals.find((w) => w.status === 'processing' && near(w.amount, 10.00));
    assert.ok(refiled, 'amount re-filed as a fresh live request (no auto method configured in tests)');
});

test('retryWithdrawal refuses an in-flight provider batch and terminal statuses', async () => {
    seed({ 'settings.json': {
        [U]: { balance: 0, withdrawals: [
            { id: 'w-done', amount: 10.02, status: 'completed', createdAt: 1 },
            { id: 'w-ltc', amount: 10.02, status: 'processing', method: 'nowpayments_ltc', payoutId: 'batch-1', createdAt: 1 }
        ] }
    } });
    const a = await payouts.retryWithdrawal([], U, 'w-done');
    const b = await payouts.retryWithdrawal([], U, 'w-ltc');   // in-flight batch → must refuse (double-pay guard)
    const c = await payouts.retryWithdrawal([], U, 'nope');
    assert.ok(!a.ok && !b.ok && !c.ok, 'completed / in-flight-LTC / missing are all rejected');
    assert.match(b.error, /in flight/, 'in-flight batch refused for the right reason');
    assert.equal(read('settings.json')[U].withdrawals.find((w) => w.id === 'w-ltc').status, 'processing', 'in-flight batch left untouched');
});

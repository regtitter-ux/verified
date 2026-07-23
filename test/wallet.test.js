const { seed, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const wallet = require('../wallet.js');

const B = 'BUYER';
beforeEach(() => reset());

test('debit reduces the balance and never overdraws', () => {
    seed({ 'wallets.json': { [B]: { balance: 20, topups: [] } } });
    assert.equal(wallet.debit(B, 12), 8);
    assert.equal(wallet.balanceOf(B), 8);
    // Insufficient → null, balance untouched (gates order creation → no free order).
    assert.equal(wallet.debit(B, 12), null);
    assert.equal(wallet.balanceOf(B), 8, 'balance unchanged after a rejected debit');
});

test('setBalance sets the wallet to an exact value (owner edit)', () => {
    seed({ 'wallets.json': { [B]: { balance: 20, topups: [] } } });
    assert.equal(wallet.setBalance(B, 7.5), 7.5);
    assert.equal(wallet.balanceOf(B), 7.5);
    assert.equal(wallet.setBalance(B, 0), 0);
    assert.equal(wallet.setBalance('NEWUSER', 3), 3, 'auto-creates the wallet');
});

test('reconcileTopups credits a paid invoice exactly once (idempotent)', async () => {
    seed({ 'wallets.json': { [B]: { balance: 0, topups: [
        { invoiceId: 'INV1', amount: 25, status: 'pending', createdAt: 1 },
    ] } } });
    const alwaysPaid = async () => true;

    const credited1 = await wallet.reconcileTopups(B, alwaysPaid);
    assert.equal(credited1, 25);
    assert.equal(wallet.balanceOf(B), 25);

    // Running again (webhook + reconcile both fire, or repeated polls) must not re-credit.
    const credited2 = await wallet.reconcileTopups(B, alwaysPaid);
    assert.equal(credited2, 0, 'already-paid top-up is not credited twice');
    assert.equal(wallet.balanceOf(B), 25);
});

test('settlePending credits a matched pending top-up once', () => {
    seed({ 'wallets.json': { [B]: { balance: 0, topups: [
        { orderId: 'O1', amount: 10, status: 'pending', createdAt: 1 },
    ] } } });
    assert.equal(wallet.settlePending(B, { orderId: 'O1' }), 10);
    assert.equal(wallet.balanceOf(B), 10);
    // Replayed webhook for the same order → already paid → 0.
    assert.equal(wallet.settlePending(B, { orderId: 'O1' }), 0);
    assert.equal(wallet.balanceOf(B), 10);
});

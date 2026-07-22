const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const ledger = require('../ledger.js');

const U = '111111111111111111'; // numeric so partnerlog accepts it too
beforeEach(() => reset());

test('credit and debit move the balance atomically and report the new balance', () => {
    seed({ 'settings.json': { [U]: { balance: 1.00, advText: '', serverAds: {}, partners: [] } } });
    assert.equal(ledger.credit(U, 0.05, { reason: 'paid' }).balance, 1.05);
    assert.equal(read('settings.json')[U].balance, 1.05);
    assert.equal(ledger.debit(U, 0.05, { reason: 'left' }).balance, 1.00);
    assert.equal(read('settings.json')[U].balance, 1.00);
    assert.equal(ledger.balanceOf(U), 1.00);
});

test('debit may take the balance negative (clawbacks / manual edits)', () => {
    seed({ 'settings.json': { [U]: { balance: 0.02, advText: '', serverAds: {}, partners: [] } } });
    assert.equal(ledger.debit(U, 0.05).balance, -0.03);
});

test('credit auto-creates a missing user and ignores zero amounts', () => {
    seed({ 'settings.json': {} });
    assert.equal(ledger.credit(U, 0.10).balance, 0.10);
    assert.equal(ledger.credit(U, 0).applied, false, 'zero is a no-op');
    assert.equal(ledger.balanceOf(U), 0.10);
});

const { seed, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const partnerlog = require('../partnerlog.js');

const U = '1234832716034347059';
beforeEach(() => reset());

// Regression: the DMALL cabinet's "Начислено / accrued" journal calls
// forPartner(uid, { reason: 'dmall_lot' }) and expects ONLY lot-earning credits.
// forPartner used to ignore its second arg and return the partner's WHOLE ledger,
// so unrelated debits (verification clawbacks 'left', 'payout' withdrawals) were
// summed in — dragging "accrued" negative even when the user only ever SOLD.
test('forPartner(reason) returns only that reason — DMALL earnings never mix in clawbacks/payouts', () => {
    seed({
        'partnerlog.json': {
            [U]: [
                { ts: 1, type: 'credit', reason: 'dmall_lot', amount: 0.50, srcId: 'a' },
                { ts: 2, type: 'debit', reason: 'left', amount: 3.00, srcId: 'b' },        // verification clawback — NOT dmall
                { ts: 3, type: 'debit', reason: 'payout', amount: 0.90, srcId: 'c' },      // a withdrawal — NOT dmall
                { ts: 4, type: 'credit', reason: 'dmall_lot', amount: 0.50, srcId: 'd' },
            ],
        },
    });
    const evs = partnerlog.forPartner(U, { reason: 'dmall_lot', limit: 100 });
    assert.equal(evs.length, 2, 'only the two dmall_lot events');
    assert.ok(evs.every((e) => e.reason === 'dmall_lot'));
    // The cabinet's reducer (credit +, debit -) over the filtered set → +1.00, never negative.
    const earned = evs.reduce((a, e) => a + (e.type === 'debit' ? -e.amount : e.amount), 0);
    assert.equal(+earned.toFixed(2), 1.00);
});

test('forPartner without opts still returns the full ledger (newest-first, unchanged)', () => {
    seed({ 'partnerlog.json': { [U]: [
        { ts: 1, type: 'credit', reason: 'dmall_lot', amount: 1, srcId: 'a' },
        { ts: 2, type: 'debit', reason: 'payout', amount: 1, srcId: 'b' },
    ] } });
    const evs = partnerlog.forPartner(U);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].srcId, 'b', 'newest-first');
});

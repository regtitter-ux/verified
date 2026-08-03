const { reset } = require('./setup'); // isolate DATA_DIR (sets OWNER_ID='OWNER')

// These must be set BEFORE payouts (→ admin-auth) is required, so the modules
// capture them at load. node --test runs each file in its own process, so this
// is isolated from the other suites.
process.env.ADMIN_OWNER_ID = '111111111111111111'; // web primary owner (adminAuth.OWNER_ID)
process.env.OWNER_ID = '999999999999999999';        // bot primary owner (payouts OWNER_ID)
const payouts = require('../payouts.js');
const auth = require('../admin-auth.js');

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const CO = '222222222222222222';
const MANUAL = '833442190427684914'; // hardcoded MANUAL_USER

beforeEach(() => reset());

test('canManage lets bot money commands through for the bot owner, web primary, MANUAL_USER, and co-owners', () => {
    assert.equal(payouts.canManage('999999999999999999'), true, 'bot primary owner');
    assert.equal(payouts.canManage('111111111111111111'), true, 'web primary owner');
    assert.equal(payouts.canManage(MANUAL), true, 'hardcoded manual user');

    auth.saveOwners([CO]);
    assert.equal(payouts.canManage(CO), true, 'a co-owner added in settings (live) is allowed');

    assert.equal(payouts.canManage('444444444444444444'), false, 'a random user is not');
    assert.equal(payouts.canManage(''), false, 'empty id is not');
});

test('removing a co-owner revokes their bot money rights immediately', () => {
    auth.saveOwners([CO]);
    assert.equal(payouts.canManage(CO), true);
    auth.saveOwners([]);
    assert.equal(payouts.canManage(CO), false, 'no restart needed — read live');
});

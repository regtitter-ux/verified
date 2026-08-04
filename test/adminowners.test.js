const { reset } = require('./setup'); // isolate DATA_DIR
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const PRIMARY = '111111111111111111';
process.env.ADMIN_OWNER_ID = PRIMARY;   // must be set BEFORE admin-auth is required
const auth = require('../admin-auth.js');

const CO = '222222222222222222';
const ADMIN = '333333333333333333';

beforeEach(() => reset());

test('the primary env owner is always an owner and cannot be added/removed as a co-owner', () => {
    assert.equal(auth.isOwnerId(PRIMARY), true);
    assert.equal(auth.roleOf(PRIMARY), 'owner');
    assert.deepEqual(auth.saveOwners([PRIMARY]), [], 'primary is filtered out of the co-owner list');
});

test('a co-owner added live gets full owner rights, and removal revokes them', () => {
    auth.saveOwners([CO]);
    assert.equal(auth.isOwnerId(CO), true, 'co-owner is an owner');
    assert.equal(auth.roleOf(CO), 'owner', 'co-owner resolves to the owner role');
    assert.ok(auth.loadOwners().includes(CO));

    auth.saveOwners(auth.loadOwners().filter((x) => x !== CO));
    assert.equal(auth.isOwnerId(CO), false, 'removed co-owner is no longer an owner');
    assert.equal(auth.roleOf(CO), null);
});

test('an id cannot be both owner and admin — owner wins and is stripped from admins', () => {
    auth.saveOwners([CO]);
    const savedAdmins = auth.saveAdmins([CO, ADMIN]);
    assert.ok(!savedAdmins.includes(CO), 'a co-owner is excluded from the admins list');
    assert.ok(savedAdmins.includes(ADMIN), 'a normal admin stays');
    assert.equal(auth.roleOf(CO), 'owner', 'owner role takes precedence');
    assert.equal(auth.roleOf(ADMIN), 'admin');
});

test('saveOwners validates + dedups ids', () => {
    const saved = auth.saveOwners([CO, CO, 'nope', '123', ADMIN]);
    assert.deepEqual([...saved].sort(), [ADMIN, CO].sort(), 'only valid, unique ids kept');
});

test('isBotKeeper: owners, co-owners, admins, and explicit keepers — not randoms', () => {
    auth.saveOwners([CO]);
    auth.saveAdmins([ADMIN]);
    auth.saveBotKeepers(['444444444444444444']);
    assert.equal(auth.isBotKeeper(PRIMARY), true, 'primary owner');
    assert.equal(auth.isBotKeeper(CO), true, 'co-owner');
    assert.equal(auth.isBotKeeper(ADMIN), true, 'assigned admin has access by default');
    assert.equal(auth.isBotKeeper('444444444444444444'), true, 'explicitly granted keeper');
    assert.equal(auth.isBotKeeper('555555555555555555'), false, 'a random user does not');
});

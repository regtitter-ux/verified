require('./setup'); // isolate DATA_DIR (module loads config.js indirectly)
const { test } = require('node:test');
const assert = require('node:assert');
const { makeSticky } = require('../reserveproxy.js');

const IPROYAL = 'http://user123:pass456@geo.iproyal.com:12321';

test('makeSticky pins an IPRoyal base proxy to a sticky session (one stable IP)', () => {
    delete process.env.RESERVE_PROXY_STICKY;
    const out = makeSticky(IPROYAL);
    assert.match(out, /session-vmnreserve/, 'a sticky session id is injected');
    assert.match(out, /lifetime-10m/, 'default IP lifetime applied');
    assert.match(out, /geo\.iproyal\.com:12321/, 'host/port preserved');
    assert.match(out, /pass456@/, 'password preserved');
});

test('makeSticky honors a custom lifetime and can be turned off', () => {
    process.env.RESERVE_PROXY_STICKY = '30m';
    assert.match(makeSticky(IPROYAL), /lifetime-30m/, 'custom lifetime used');
    process.env.RESERVE_PROXY_STICKY = 'off';
    assert.equal(makeSticky(IPROYAL), IPROYAL, 'off → left rotating, untouched');
    delete process.env.RESERVE_PROXY_STICKY;
});

test('makeSticky leaves non-IPRoyal and already-sticky proxies untouched', () => {
    delete process.env.RESERVE_PROXY_STICKY;
    const other = 'http://u:p@proxy.example.com:8080';
    assert.equal(makeSticky(other), other, 'non-IPRoyal host is not rewritten');
    const already = 'http://user_session-mine_lifetime-1h:p@geo.iproyal.com:12321';
    assert.equal(makeSticky(already), already, 'an operator-set session is preserved');
    assert.equal(makeSticky(''), '', 'empty stays empty');
});

require('./setup'); // isolate DATA_DIR (module loads config.js indirectly)
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const rp = require('../reserveproxy.js');

const BASE = 'http://user123:pass456@geo.iproyal.com:12321';

// The module reads RESERVE_PROXY_* live, so these env vars must not leak between tests.
afterEach(() => { delete process.env.RESERVE_PROXY; delete process.env.RESERVE_PROXY_STICKY; });

test('proxyUrlFor pins an IPRoyal base to a sticky session (one stable IP)', () => {
    process.env.RESERVE_PROXY = BASE;
    const out = rp.proxyUrlFor('some-token');
    assert.match(out, /_session-v[0-9a-f]{10}_/, 'a per-account sticky session id is injected');
    assert.match(out, /lifetime-30m/, 'default IP lifetime applied');
    assert.match(out, /geo\.iproyal\.com:12321/, 'host/port preserved');
    assert.match(out, /pass456@/, 'password preserved');
    assert.ok(!out.endsWith('/'), 'no trailing slash added (matches the base format)');
});

test('proxyUrlFor gives DIFFERENT sticky IPs to different tokens, stable per token', () => {
    process.env.RESERVE_PROXY = BASE;
    const a1 = rp.sessionIdFor('token-A'), a2 = rp.sessionIdFor('token-A'), b = rp.sessionIdFor('token-B');
    assert.equal(a1, a2, 'same token → same session (stable IP for that account)');
    assert.notEqual(a1, b, 'different tokens → different sessions (accounts never share an IP)');
    assert.ok(!a1.includes('token'), 'session id does not leak the token');
});

test('proxyUrlFor honors a custom lifetime and can be turned off', () => {
    process.env.RESERVE_PROXY = BASE;
    process.env.RESERVE_PROXY_STICKY = '30m';
    assert.match(rp.proxyUrlFor('t'), /lifetime-30m/, 'custom lifetime used');
    process.env.RESERVE_PROXY_STICKY = 'off';
    assert.equal(rp.proxyUrlFor('t'), BASE, 'off → left rotating, untouched');
});

test('proxyUrlFor leaves non-IPRoyal / already-sticky / unset proxies untouched', () => {
    process.env.RESERVE_PROXY = 'http://u:p@proxy.example.com:8080';
    assert.equal(rp.proxyUrlFor('t'), 'http://u:p@proxy.example.com:8080', 'non-IPRoyal host is not rewritten');
    process.env.RESERVE_PROXY = 'http://user_session-mine_lifetime-1h:p@geo.iproyal.com:12321';
    assert.match(rp.proxyUrlFor('t'), /session-mine/, 'an operator-set session is preserved');
    delete process.env.RESERVE_PROXY;
    assert.equal(rp.proxyUrlFor('t'), '', 'no proxy configured → empty');
});

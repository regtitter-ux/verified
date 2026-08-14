const { reset, DIR } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const mute = require('../dmallticketmute.js');

const U = '111111111111111111';
beforeEach(() => reset());

test('timed mute expires; permanent does not; unmute clears', () => {
    assert.equal(mute.isMuted(U), false);
    mute.mute(U, 10);
    assert.equal(mute.isMuted(U), true);
    require('fs').writeFileSync(require('path').join(DIR, mute.FILE), JSON.stringify({ [U]: Date.now() - 1000 }));
    require('../database.js')._resetCache();
    assert.equal(mute.isMuted(U), false, 'expired');
    mute.mute(U, 0);
    assert.equal(mute.load()[U], -1, 'permanent = -1');
    assert.equal(mute.isMuted(U), true);
    mute.unmute(U);
    assert.equal(mute.isMuted(U), false);
});

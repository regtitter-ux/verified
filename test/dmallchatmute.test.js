const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const mute = require('../dmallchatmute.js');

const U = '111111111111111111';
beforeEach(() => reset());

test('timed mute expires; permanent mute does not; unmute clears', () => {
    assert.equal(mute.isMuted(U), false, 'not muted by default');
    mute.mute(U, 10);
    assert.equal(mute.isMuted(U), true, 'timed mute active');
    // Force it into the past → expired.
    const { DIR } = require('./setup');
    require('fs').writeFileSync(require('path').join(DIR, mute.FILE), JSON.stringify({ [U]: Date.now() - 1000 }));
    require('../database.js')._resetCache();
    assert.equal(mute.isMuted(U), false, 'expired timed mute');

    mute.mute(U, 0);   // permanent
    assert.equal(mute.load()[U], -1, 'permanent stored as -1');
    assert.equal(mute.isMuted(U), true);
    mute.unmute(U);
    assert.equal(mute.isMuted(U), false, 'unmuted');
});

const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const lots = require('../dmalllots.js');

beforeEach(() => reset());

const GID = '111111111111111111';

// Regression: a lot could be created (create runs a LIVE botOnGuild check) yet vanish from
// the catalog because the list uses the 10-min-cached guildInfo, which may still hold a
// stale `present:false` from a check made before the bot was added. invalidateGuild clears
// that so the list re-checks fresh. (guildInfo reads its cache BEFORE any token/network, so
// this is fully offline: no AUTH_BOT_TOKEN needed to hit the cache path.)
test('invalidateGuild drops a stale present:false so guildInfo no longer returns it', async () => {
    delete process.env.AUTH_BOT_TOKEN;   // ensure the post-invalidate path can't fetch (→ null, not the stale value)
    lots.primeGuild(GID, { present: false });
    assert.deepEqual(await lots.guildInfo(GID), { present: false }, 'served from cache');

    lots.invalidateGuild(GID);
    // Cache miss + no token → guildInfo returns null (unknown), NOT the stale present:false.
    // The list treats unknown (`!== false`) as shown, so the fresh lot is no longer hidden.
    assert.equal(await lots.guildInfo(GID), null);
});

test('primeGuild present:true is served from cache without a token', async () => {
    delete process.env.AUTH_BOT_TOKEN;
    lots.primeGuild(GID, { present: true, name: 'S', members: 5, icon: '', banner: '' });
    const g = await lots.guildInfo(GID);
    assert.equal(g.present, true);
    assert.equal(g.name, 'S');
});

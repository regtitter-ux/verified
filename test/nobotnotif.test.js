const { seed, read, reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const campaigns = require('../campaigns.js');

const GID = '111111111111111111';
const GRACE = 10 * 60 * 1000;
const camp = (over = {}) => ({ id: 'c1', status: 'active', sponsorGuildId: GID, invite: 'https://discord.gg/x', ...over });

beforeEach(() => reset());

test('uncovered order requests a ping the first time, then not again until the repeat window', async () => {
    seed({ 'campaigns.json': { c1: camp() } });
    const r1 = await campaigns.autoPauseUncovered([], new Set(), GRACE);       // no coverage
    assert.equal(r1.needBotNotify.length, 1, 'first sweep asks for a ping');
    assert.equal(r1.needBotNotify[0].oldMsgId, '', 'no previous message to delete');
    // caller records the posted message id
    campaigns.setNoBotNotifMsg('c1', 'MSG1', 'CH1');

    const r2 = await campaigns.autoPauseUncovered([], new Set(), GRACE);       // still uncovered, <10min later
    assert.equal(r2.needBotNotify.length, 0, 'not re-pinged inside the repeat window');
});

test('after the repeat window a fresh ping replaces the old one (old msg id returned to delete)', async () => {
    // notifiedAt 11 minutes ago → due again
    seed({ 'campaigns.json': { c1: camp({ noBotNotifiedAt: Date.now() - 11 * 60 * 1000, noBotNotifMsgId: 'OLD', noBotNotifChannelId: 'CH1' }) } });
    const r = await campaigns.autoPauseUncovered([], new Set(), GRACE);
    assert.equal(r.needBotNotify.length, 1, 're-ping is due');
    assert.equal(r.needBotNotify[0].oldMsgId, 'OLD', 'the previous message is handed back for deletion');
    assert.equal(r.needBotNotify[0].oldChannelId, 'CH1');
});

test('coverage returning clears the standing ping (returns its msg id) and resets state', async () => {
    seed({ 'campaigns.json': { c1: camp({ noBotNotifiedAt: Date.now(), noBotNotifMsgId: 'MSG1', noBotNotifChannelId: 'CH1' }) } });
    const r = await campaigns.autoPauseUncovered([], new Set([GID]), GRACE);   // sponsor now covered
    assert.equal(r.clearBotNotify.length, 1, 'the ping is scheduled for deletion');
    assert.deepEqual(r.clearBotNotify[0], { channelId: 'CH1', msgId: 'MSG1' });
    assert.equal(r.needBotNotify.length, 0, 'no new ping when covered');
    const c = read('campaigns.json').c1;
    assert.ok(!c.noBotNotifMsgId && !c.noBotNotifiedAt, 'notif state cleared on coverage');
});

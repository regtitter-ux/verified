require('./setup');
const { test } = require('node:test');
const assert = require('node:assert');
const dmallemojis = require('../dmallemojis.js');
const dmallupload = require('../dmallupload.js');

// A fake discord.js client: guilds.cache is a Map of guilds, each with emojis/stickers caches.
function fakeGuild(id, name, members, emojis, stickers) {
    return {
        id, name, memberCount: members, iconURL: () => 'https://cdn/icon/' + id + '.png',
        emojis: { cache: new Map(emojis.map((e) => [e.id, e])) },
        stickers: { cache: new Map(stickers.map((s) => [s.id, s])) },
    };
}
function fakeClient(guilds) { return { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } }; }

test('emoji catalog groups by guild, largest first, with CDN urls', () => {
    const small = fakeGuild('10', 'Small', 5,
        [{ id: '901', name: 'wave', animated: false, available: true }], []);
    const big = fakeGuild('20', 'Big', 5000,
        [{ id: '902', name: 'fire', animated: true, available: true }, { id: '903', name: 'gone', available: false }],
        [{ id: '801', name: 'cat', format: 1 }, { id: '802', name: 'gifcat', format: 4 }]);
    const cat = dmallemojis.build([fakeClient([small, big])]);
    // Largest guild first.
    assert.equal(cat.emojis[0].guildName, 'Big');
    assert.equal(cat.emojis[0].items.length, 1, 'unavailable emoji filtered out');
    assert.equal(cat.emojis[0].items[0].id, '902');
    assert.ok(cat.emojis[0].items[0].url.includes('/emojis/902.gif'), 'animated → gif');
    assert.equal(cat.emojis[1].guildName, 'Small');
    // Stickers: png for format 1, gif for format 4.
    const st = cat.stickers.find((g) => g.guildId === '20');
    assert.equal(st.items.length, 2);
    assert.ok(st.items.find((s) => s.id === '801').url.includes('/stickers/801.png'));
    assert.ok(st.items.find((s) => s.id === '802').url.includes('/stickers/802.gif'));
});

test('emoji catalog dedupes a guild seen by two bots and skips empty guilds', () => {
    const g = fakeGuild('30', 'Dup', 10, [{ id: '999', name: 'x', available: true }], []);
    const empty = fakeGuild('40', 'Empty', 9, [], []);
    const cat = dmallemojis.build([fakeClient([g, empty]), fakeClient([g])]);
    assert.equal(cat.emojis.length, 1, 'one group despite two clients + empty guild dropped');
    assert.equal(cat.emojis[0].guildId, '30');
});

test('upload.save accepts a tiny PNG and rejects bad/oversize data', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const ok = dmallupload.save(png, 'pixel.png');
    assert.equal(ok.kind, 'image');
    assert.match(ok.url, /^\/uploads\/[0-9a-f]{16}\.png$/, 'hashed url');
    // Same bytes → same hashed name (content-addressed dedupe).
    assert.equal(dmallupload.save(png, 'again.png').url, ok.url);
    assert.equal(dmallupload.save('not-a-data-url', 'x').error, 'need-file');
    assert.equal(dmallupload.save('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'x.svg').error, 'image-type', 'svg blocked');
});

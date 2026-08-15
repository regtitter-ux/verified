const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { dmSanitizeMsg } = require('../api.js');

beforeEach(() => reset());

// The order-details view stores a copy of the client-composed broadcast message. dmSanitizeMsg
// bounds that untrusted input so a crafted payload can't bloat the store (many/huge embeds/fields).
test('non-object input → null', () => {
    assert.equal(dmSanitizeMsg(null), null);
    assert.equal(dmSanitizeMsg('x'), null);
    assert.equal(dmSanitizeMsg(42), null);
});

test('trims content and caps embeds/fields/components', () => {
    const out = dmSanitizeMsg({
        content: 'a'.repeat(9000),
        embeds: Array.from({ length: 30 }, (_, i) => ({
            title: 't'.repeat(500), description: 'd'.repeat(9000),
            fields: Array.from({ length: 40 }, () => ({ name: 'n', value: 'v', inline: true })),
        })),
        components: Array.from({ length: 40 }, () => ({ label: 'l'.repeat(200), url: 'u' })),
    });
    assert.equal(out.content.length, 4000, 'content capped at 4000');
    assert.equal(out.embeds.length, 10, 'at most 10 embeds');
    assert.equal(out.embeds[0].title.length, 256, 'embed title capped');
    assert.equal(out.embeds[0].description.length, 4000, 'embed description capped');
    assert.equal(out.embeds[0].fields.length, 25, 'at most 25 fields');
    assert.equal(out.components.length, 25, 'at most 25 components');
    assert.equal(out.components[0].label.length, 80, 'component label capped');
});

test('keeps a normal message intact', () => {
    const out = dmSanitizeMsg({ content: 'Hello', embeds: [{ title: 'Hi', description: 'World' }], components: [{ label: 'Open', url: 'https://x.io' }] });
    assert.equal(out.content, 'Hello');
    assert.equal(out.embeds[0].title, 'Hi');
    assert.equal(out.components[0].url, 'https://x.io');
});

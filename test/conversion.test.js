const { seed, reset } = require('./setup');
const { test } = require('node:test');
const assert = require('node:assert');
const conv = require('../conversion.js');

const near = (a, b, e = 0.0001) => Math.abs(Number(a) - Number(b)) <= e;
const NOW = 1_700_000_000_000;

test('conversion = join-check joins ÷ unique clickers over the aligned window', () => {
    const joins = Array.from({ length: 20 }, (_, i) => NOW - i * 1000);      // 20 joins over the last ~19s
    const clicks = Array.from({ length: 100 }, (_, i) => ({ u: 'u' + i, t: NOW - i * 180 })); // 100 clickers, all inside that window
    const r = conv.fromSamples(joins, clicks, NOW);
    assert.equal(r.joins, 20);
    assert.equal(r.clickers, 100);
    assert.ok(near(r.conv, 0.20), `20/100 = 0.20, got ${r.conv}`);
});

test('only the last 100 joins are sampled', () => {
    const joins = Array.from({ length: 250 }, (_, i) => NOW - i * 1000);
    const clicks = Array.from({ length: 500 }, (_, i) => ({ u: 'u' + i, t: NOW - i * 100 }));
    const r = conv.fromSamples(joins, clicks, NOW);
    assert.ok(r.joins <= 100, `≤100 joins sampled, got ${r.joins}`);
});

test('clickers are de-duplicated and conversion is bounded at 1', () => {
    const joins = [NOW - 1000, NOW - 2000];
    const clicks = [{ u: 'a', t: NOW }, { u: 'a', t: NOW - 10 }, { u: 'a', t: NOW - 20 }]; // 1 unique clicker
    const r = conv.fromSamples(joins, clicks, NOW);
    assert.equal(r.clickers, 1);
    assert.equal(r.conv, 1, '2 joins / 1 clicker capped at 1.0');
});

test('null conversion until there is both a join and a clicker', () => {
    assert.equal(conv.fromSamples([], [{ u: 'a', t: NOW }], NOW).conv, null);
    assert.equal(conv.fromSamples([NOW], [], NOW).conv, null);
});

test('no-check (nc) clicks are excluded from the conversion denominator', () => {
    const joins = Array.from({ length: 10 }, (_, i) => NOW - i * 1000);           // 10 join-check joins
    const calib = Array.from({ length: 20 }, (_, i) => ({ u: 'c' + i, t: NOW - i * 100 }));            // 20 calibration clickers
    const nocheck = Array.from({ length: 80 }, (_, i) => ({ u: 'n' + i, t: NOW - i * 100, nc: 1 }));   // 80 no-check clickers (ignored)
    const r = conv.fromSamples(joins, calib.concat(nocheck), NOW);
    assert.equal(r.clickers, 20, 'only calibration clickers count');
    assert.ok(near(r.conv, 0.5), `10/20 = 0.50 (no-check clicks must not dilute it), got ${r.conv}`);
});

test('no-ad (na) clicks are excluded from the conversion denominator', () => {
    const joins = Array.from({ length: 10 }, (_, i) => NOW - i * 1000);                                 // 10 join-check joins
    const adClicks = Array.from({ length: 20 }, (_, i) => ({ u: 'c' + i, t: NOW - i * 100 }));          // 20 real ad-clickers
    const noAd = Array.from({ length: 80 }, (_, i) => ({ u: 'n' + i, t: NOW - i * 100, na: 1 }));       // 80 no-ad clickers (ignored)
    const r = conv.fromSamples(joins, adClicks.concat(noAd), NOW);
    assert.equal(r.clickers, 20, 'only clicks that showed a join-check ad count');
    assert.ok(near(r.conv, 0.5), `10/20 = 0.50 (no-ad clicks must not dilute it), got ${r.conv}`);
});

test('CALIB_RATE is a fraction in (0, 1]', () => {
    assert.ok(conv.CALIB_RATE > 0 && conv.CALIB_RATE <= 1, `got ${conv.CALIB_RATE}`);
});

test('noCheckEligible needs BOTH levers on AND a conversion', () => {
    assert.equal(conv.noCheckEligible(true, true, 0.2), true, 'server + ad + conv → eligible');
    assert.equal(conv.noCheckEligible(false, true, 0.2), false, 'server off → no');
    assert.equal(conv.noCheckEligible(true, false, 0.2), false, 'ad not opted in → no');
    assert.equal(conv.noCheckEligible(true, true, null), false, 'no conversion yet → no');
    assert.equal(conv.noCheckEligible(true, true, 0), true, 'a real 0% conversion is still a measured value');
});

test('networkAvg = all join-check joins ÷ summed per-card unique clickers (fresh-card fallback)', () => {
    reset();
    seed({
        'verified.json': [
            { id: 'a', adKey: 'K', timestamp: NOW - 1000 },                  // join-check → counts
            { id: 'b', adKey: 'K', timestamp: NOW - 2000 },                  // join-check → counts
            { id: 'c', adKey: 'K', timestamp: NOW - 3000, noCheck: true },   // virtual → excluded
            { id: 'd', adKey: 'K', timestamp: NOW - 4000, viaExtra: true }   // bonus ad → excluded
        ],
        'cardclicks.json': [
            { k: 'g1:r:cr', u: 'a', t: NOW - 100 },
            { k: 'g1:r:cr', u: 'b', t: NOW - 200 },
            { k: 'g1:r:cr', u: 'a', t: NOW - 300 },              // dup clicker same card → 1
            { k: 'g2:r:cr', u: 'x', t: NOW - 400 },              // other card → +1
            { k: 'g2:r:cr', u: 'y', t: NOW - 500, nc: 1 }        // no-check click → excluded
        ]
    });
    // joins = 2 (a,b); clickers = g1{a,b}=2 + g2{x}=1 = 3 → 0.6667
    assert.ok(near(conv.networkAvg(NOW), 2 / 3), `2/3, got ${conv.networkAvg(NOW)}`);
});

test('networkAvg is null when the network has no data yet', () => {
    reset();
    seed({ 'verified.json': [], 'cardclicks.json': [] });
    assert.equal(conv.networkAvg(NOW), null);
});

test('ratePer100Clicks = joinRate × conversion (matches per-join earnings)', () => {
    assert.ok(near(conv.ratePer100Clicks(0.18, 5), 0.90), '$5/100 joins × 0.18 = $0.90/100 clicks');
    assert.equal(conv.ratePer100Clicks(null, 5), 0, 'no rate without a conversion');
    assert.equal(conv.ratePer100Clicks(0.2, 0), 0, 'no rate without a join rate');
    assert.ok(near(conv.ratePerClick(0.18, 5), 0.009), 'per-click = per-100 ÷ 100 = 0.90/100');
});

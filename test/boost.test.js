const { test } = require('node:test');
const assert = require('node:assert');
const { boostActive, boostedRate, BOOST_MS, BOOST_RATE } = require('../referral.js');

test('boostActive: within the window and not manually off → active', () => {
    assert.equal(boostActive({ referrerAt: Date.now() - 1000 }), true);
});

test('boostActive: the manual off-switch ends the boost early, still inside the window', () => {
    assert.equal(boostActive({ referrerAt: Date.now() - 1000, boostOff: true }), false);
});

test('boostActive: an expired window is inactive regardless of the flag', () => {
    assert.equal(boostActive({ referrerAt: Date.now() - BOOST_MS - 1000 }), false);
    assert.equal(boostActive({ referrerAt: Date.now() - BOOST_MS - 1000, boostOff: false }), false);
});

test('boostedRate falls back to base when the boost is manually off', () => {
    const at = Date.now() - 1000;
    assert.equal(boostedRate({ referrerAt: at }, 5), BOOST_RATE, 'active → floor at the boost rate');
    assert.equal(boostedRate({ referrerAt: at, boostOff: true }, 5), 5, 'off → base rate only');
});

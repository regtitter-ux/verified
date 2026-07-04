// Shared referral / boost rules.
//
// A referred user picks the person who invited them ("Referrer" in /bal). From then
// on that referrer earns REFERRAL_RATE of the referred user's withdrawals, and the
// referred user gets a boosted per-100 verification rate (BOOST_RATE) for BOOST_MS.
//
// Anti-twink: a referrer is locked per server — once set from any account, the
// button disappears for that server forever (see serverreferrers.json in index.js).
const REFERRAL_RATE = 0.10;        // referrer earns 10% of referred user's withdrawals
const BOOST_RATE = 7;              // $ per 100 verifications while the boost is active
const BOOST_DAYS = 7;
const BOOST_MS = BOOST_DAYS * 24 * 60 * 60 * 1000;

// Is the referral boost still active for this user's settings record?
const boostActive = (s) => {
    const at = Number(s?.referrerAt);
    return Number.isFinite(at) && at > 0 && (Date.now() - at) < BOOST_MS;
};

// Effective per-100 rate: the boost acts as a floor of BOOST_RATE while active.
const boostedRate = (s, base) => {
    const b = Number(base) || 0;
    return boostActive(s) ? Math.max(b, BOOST_RATE) : b;
};

module.exports = { REFERRAL_RATE, BOOST_RATE, BOOST_DAYS, BOOST_MS, boostActive, boostedRate };

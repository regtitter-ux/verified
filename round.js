// Single source of truth for money rounding. These two helpers were copy-pasted
// — identically — into ~10 modules; divergent copies are exactly how accounting
// drift creeps in, so every module now imports them from here instead.
//   round2 — cents (balances, payouts, per-join rates)
//   round4 — sub-cent revenue math (share splits, manager economics)
// Both coerce a non-number to 0 first, so a bad input rounds to 0, never NaN.
const round2 = (n) => +((Number(n) || 0).toFixed(2));
const round4 = (n) => +((Number(n) || 0).toFixed(4));

module.exports = { round2, round4 };

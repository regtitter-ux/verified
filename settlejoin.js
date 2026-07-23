const { payShares } = require('./shares.js');
const { logFunds } = require('./fundslog.js');
const { maybeAutoWithdraw } = require('./payouts.js');
const partnerlog = require('./partnerlog.js');

// The shared "settlement tail" that runs AFTER creditJoin() has paid a
// non-duplicate join. creditJoin (joincheck.js) is the single, tested,
// race-proof point that moves the balance; everything here is the bookkeeping
// that must follow a paid join:
//   1) activity-log the paid grant (partner cabinet feed),
//   2) post the funds audit embed,
//   3) split shareholder profit — UNLESS an investor already funded this join
//      (their revenue funds the investor return and the split happened at buy-in),
//   4) trigger auto-withdraw for the partner, and for any referrer whose 10% cut
//      creditJoin just paid.
//
// This tail was copy-pasted into the in-Discord second-click path (index.js) and
// the auto-join path (autojoin.js), which "had to stay byte-for-byte consistent
// by hand" — a change to one that missed the other silently diverged the money
// bookkeeping between the two ways a join can be confirmed. One function now
// serves both. (The developer-API path in api.js interleaves API-specific work —
// recordApiVerified, webhooks — in a different order and is intentionally left on
// its own for now.)
//
// Error handling mirrors the original inline code EXACTLY so this is a pure
// extraction: partnerlog is best-effort (never blocks); logFunds and the
// partner's own auto-withdraw propagate to the caller's guard; payShares and the
// referrer auto-withdraw are swallowed.
async function settleCreditedJoin(clients, {
    creatorId, joinerId, cardGuildId, channelId, roleId, sponsorGuildId,
    amount, linkId, referrerId, investorOwned, revenue, reason,
}) {
    try { partnerlog.logEvent(creatorId, { type: 'grant', reason: 'paid', amount, userId: joinerId, guildId: cardGuildId, roleId, sponsorGuildId, srcId: linkId }); } catch { /* never block */ }
    await logFunds(clients, { type: 'credit', creatorId, userId: joinerId, guildId: cardGuildId, channelId, amount, sponsorGuildId, reason });
    if (!investorOwned) await payShares(clients, amount, { revenuePerJoin: revenue }).catch(() => null);
    await maybeAutoWithdraw(clients, creatorId);
    if (referrerId) await maybeAutoWithdraw(clients, referrerId).catch(() => null);
}

module.exports = { settleCreditedJoin };

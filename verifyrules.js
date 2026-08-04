// Pure decision rules for the verification / auto-join flow.
//
// Extracted from the index.js interaction mega-handler so the money-gating logic
// — the exact code where the counting/payout bugs hid — is unit-testable in
// isolation. NO Discord objects, NO I/O here: just the predicates. index.js,
// autojoin.js and api.js (dev API) all route their "does this join count + pay?"
// and "is this a duplicate?" decisions through here, so the rule is defined once.

// A confirmed join is COUNTED toward the buyer's order AND PAID to the partner
// only when a real join-check ad was shown, a sponsor resolved, it isn't a
// duplicate, AND the user's membership was actually CONFIRMED. `memberConfirmed`
// defaults true (callers that only reach this after a confirmed check keep their
// behavior); the interactive verifier passes false when it grants access on a
// reserve sponsor it couldn't verify (banned/down user-token) — access is given
// but nothing is paid, since the join was never confirmed.
function shouldCountJoin({ roleId, adShown, adRaw, sponsor, isDupJoin, memberConfirmed = true }) {
    return Boolean(roleId && adShown && adRaw && sponsor && !isDupJoin && memberConfirmed);
}

// One real invite = one join. A user is a duplicate for a sponsor if they already
// have a live ('joined') or finalized-but-kept ('settled') join record for it —
// they verified elsewhere in the network, so don't count or pay them again.
function isDuplicateJoin(joinlinks, userId, sponsorGuildId) {
    if (!userId || !sponsorGuildId) return false;
    return (Array.isArray(joinlinks) ? joinlinks : []).some(
        (r) => r && (r.status === 'joined' || r.status === 'settled') && r.userId === userId && r.guildId === sponsorGuildId
    );
}

module.exports = { shouldCountJoin, isDuplicateJoin };

// Pure decision rules for the verification / auto-join flow.
//
// Extracted from the index.js interaction mega-handler so the money-gating logic
// — the exact code where the counting/payout bugs hid — is unit-testable in
// isolation. NO Discord objects, NO I/O here: just the predicates. index.js,
// autojoin.js and api.js (dev API) all route their "does this join count + pay?"
// and "is this a duplicate?" decisions through here, so the rule is defined once.

// A confirmed join is COUNTED toward the buyer's order AND PAID to the partner
// only when a real join-check ad was shown, a sponsor resolved, and it isn't a
// duplicate. (Membership itself is confirmed separately, before this is asked.)
function shouldCountJoin({ roleId, adShown, adRaw, sponsor, isDupJoin }) {
    return Boolean(roleId && adShown && adRaw && sponsor && !isDupJoin);
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

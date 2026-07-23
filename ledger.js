// Single money primitive: the ONE sanctioned way to move a user's balance.
//
// Balance arithmetic used to be hand-rolled in ~9 files (`settings[uid].balance =
// round2(... ± X)` + a separate log), which is how the balance and its audit log
// drifted apart (the double-clawback logged once but debited twice). `ledger`
// centralizes it: an atomic balance change (via database.mutate → no shared-cache
// leak) PLUS the partner activity-log entry, in one call. Returns the new balance.
//
//   ledger.credit(uid, 0.05, { reason: 'paid', srcId: linkId })
//   ledger.debit(uid, 0.05, { reason: 'left',  srcId: linkId })   // balance may go negative (clawbacks/manual edits)
//
// `srcId`/`reason`/`meta` are forwarded to partnerlog (which dedupes its OWN lines
// by (type, srcId)). Idempotency of the BALANCE change stays with the caller's
// own state (joinlink dup-guard, withdrawal record, reservation) — this primitive
// applies exactly the delta it's told to, atomically.
const { loadJSON, mutate } = require('./database.js');
const partnerlog = require('./partnerlog.js');

const { round2 } = require('./round.js');

function balanceOf(uid) {
    const s = loadJSON('settings.json', {});
    return round2((s && s[uid] && s[uid].balance) || 0);
}

// Apply a signed delta to uid's balance atomically, then log it. `type` is
// 'credit' | 'debit' for the log; the sign of the actual math follows `delta`.
function apply(uid, delta, type, opts = {}) {
    const d = round2(delta);
    if (!uid || !d) return { applied: false, balance: balanceOf(uid) };
    const balance = mutate('settings.json', (s) => {
        if (!s[uid]) s[uid] = { advText: '', serverAds: {}, partners: [] };
        s[uid].balance = round2((Number(s[uid].balance) || 0) + d);
        return s[uid].balance;
    }, {});
    try {
        partnerlog.logEvent(uid, { type, reason: opts.reason, amount: Math.abs(d), srcId: opts.srcId, userId: opts.userId, guildId: opts.guildId, sponsorGuildId: opts.sponsorGuildId, roleId: opts.roleId });
    } catch { /* logging must never block a balance change */ }
    return { applied: true, balance };
}

const credit = (uid, amount, opts = {}) => apply(uid, +Math.abs(round2(amount)), 'credit', opts);
const debit = (uid, amount, opts = {}) => apply(uid, -Math.abs(round2(amount)), 'debit', opts);

module.exports = { balanceOf, credit, debit };

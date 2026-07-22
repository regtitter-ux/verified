// Credit a join even without the SECOND verification click.
//
// Many users click the ad, join the sponsor server, but never click "verify"
// again. If their FIRST click showed a join-check ad and our checker later
// confirms they actually joined that sponsor, we complete the verification for
// them — count the invite, pay the partner, grant the card role — exactly as the
// second click would. Leaves are then handled by the normal clawback sweep, even
// if the user leaves before ever clicking again (the join was already credited).
//
// A persistent pending list (pendingjoins.json) is written on the first click and
// polled here; an entry expires after WINDOW if no join is detected. Money is safe:
// creditJoin is idempotent per (user, sponsor), and verified.json is written once
// per (user, card, role) — so this can never double-pay or double-count against a
// later manual click.
const { loadJSON, saveJSON } = require('./database.js');
const { isMember, creditJoin } = require('./joincheck.js');
const { isDuplicateJoin } = require('./verifyrules.js');
const { touchCreative, maybeNotifyAdComplete } = require('./adcreative.js');
const { logFunds } = require('./fundslog.js');
const { syncHubMember } = require('./hubrole.js');
const { payShares } = require('./shares.js');
const sharesMod = require('./shares.js');
const { maybeAutoWithdraw } = require('./payouts.js');
const managers = require('./managers.js');
const campaigns = require('./campaigns.js');
const investors = require('./investors.js');
const partnerlog = require('./partnerlog.js');

const FILE = 'pendingjoins.json';
const WINDOW_MS = Number(process.env.AUTOJOIN_WINDOW_MS) || 6 * 3600 * 1000;   // still auto-credit for this long after the first click
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => { const r = loadJSON(FILE, []); return Array.isArray(r) ? r : []; };

// Called on the first click when a join-check ad was shown. One entry per
// (user, card, role); prunes expired ones on write.
function record(entry) {
    if (!entry || !entry.userId || !entry.sponsorGuildId || !entry.cardGuildId) return;
    const now = Date.now();
    const list = load().filter((e) => e && (now - (Number(e.ts) || 0) < WINDOW_MS)
        && !(e.userId === entry.userId && e.cardGuildId === entry.cardGuildId && (e.roleId || null) === (entry.roleId || null)));
    list.push({ ...entry, ts: now });
    saveJSON(FILE, list);
}

function alreadyJoined(userId, sponsorGuildId) {
    return isDuplicateJoin(loadJSON('joinlinks.json', []), userId, sponsorGuildId);
}
function alreadyVerified(userId, cardGuildId, roleId) {
    const v = loadJSON('verified.json', []);
    return (Array.isArray(v) ? v : []).some((u) => u && u.id === userId && u.guildId === cardGuildId && (u.roleId || null) === (roleId || null));
}
// A COUNTED verification — a verified.json entry that actually carries an adKey
// (i.e. the join was tallied toward the order). A bare `noAd` placeholder does
// NOT count: it must not stop auto-join from later tallying the confirmed join.
function alreadyCounted(userId, cardGuildId, roleId) {
    const v = loadJSON('verified.json', []);
    return (Array.isArray(v) ? v : []).some((u) => u && u.id === userId && u.guildId === cardGuildId && (u.roleId || null) === (roleId || null) && u.adKey);
}

// Confirmed membership → finish the verification. Mirrors the second-click path.
async function complete(clients, e) {
    const dup = alreadyJoined(e.userId, e.sponsorGuildId);
    const adKey = (!dup && e.adRaw) ? touchCreative(e.adRaw) : '';

    // verified.json entry (once per user+card+role) so delivery counts it. If a
    // placeholder `noAd` entry already exists (the user clicked "confirm" during a
    // transient sponsor-resolution failure and got verified WITHOUT the join being
    // tallied), UPGRADE it to a counted entry now that membership is confirmed —
    // that is the whole point of auto-join: count at JOIN time even when the second
    // confirm click never landed or failed. Load→mutate→save is await-free (atomic).
    {
        const v = loadJSON('verified.json', []);
        const arr = Array.isArray(v) ? v : [];
        const idx = arr.findIndex((u) => u && u.id === e.userId && u.guildId === e.cardGuildId && (u.roleId || null) === (e.roleId || null));
        if (idx === -1) {
            const rec = { id: e.userId, guildId: e.cardGuildId, roleId: e.roleId || null, creatorId: e.creatorId, timestamp: Date.now(), viaAutoJoin: true };
            if (e.viaExtra) rec.viaExtra = true;   // bonus-ad delivery, isolated from card stats
            if (adKey) rec.adKey = adKey; else rec.noAd = true;
            arr.push(rec);
            saveJSON('verified.json', arr);
            if (adKey) maybeNotifyAdComplete(clients, adKey, arr).catch(() => null);
        } else if (adKey && !arr[idx].adKey) {
            arr[idx].adKey = adKey;
            delete arr[idx].noAd; delete arr[idx].noAdReason;
            arr[idx].viaAutoJoin = true;
            saveJSON('verified.json', arr);
            maybeNotifyAdComplete(clients, adKey, arr).catch(() => null);
        }
    }

    // Grant the card role (best-effort — the credit is the point, access is a
    // bonus). Skipped for the EXTRA bonus ad: it has no role requirement and its
    // roleId is a sentinel ('extra:<campaignId>'), not a real Discord role.
    if (!e.viaExtra && e.roleId && e.cardGuildId) {
        const bot = (Array.isArray(clients) ? clients : []).find((c) => c.guilds?.cache?.has(e.cardGuildId));
        const g = bot?.guilds.cache.get(e.cardGuildId);
        if (g) {
            const m = await g.members.fetch(e.userId).catch(() => null);
            const role = g.roles.cache.get(e.roleId);
            if (m && role && role.editable && !m.roles.cache.has(e.roleId)) await m.roles.add(role).catch(() => null);
        }
    }
    if (!e.viaExtra) syncHubMember(clients, e.creatorId).catch(() => null); // hub role tracks the PARTNER (card owner)

    // Pay the partner (idempotent, reversible on leave).
    if (dup) {
        try { partnerlog.logEvent(e.creatorId, { type: 'grant', reason: 'dup_join', userId: e.userId, guildId: e.cardGuildId, roleId: e.roleId, sponsorGuildId: e.sponsorGuildId, srcId: `dup:${e.userId}:${e.sponsorGuildId}` }); } catch { /* never block */ }
        return;
    }
    let investorOwned = false;
    try { investorOwned = investors.serverOutstanding(e.cardGuildId, loadJSON('verified.json', [])) > 0; } catch { /* never block */ }
    const camp = e.campaignId ? campaigns.loadCampaigns()[e.campaignId] : null;
    const econ = managers.joinEconomics(camp, sharesMod.REVENUE_PER_JOIN);
    const credit = creditJoin(e.creatorId, e.sponsorGuildId, e.userId, e.cardGuildId, e.roleId, e.channelId, { revenue: econ.revenue, managerId: econ.managerId, extraPlacement: e.viaExtra ? (e.placement || 'pre') : undefined, noPay: e.viaExtra });
    if (credit.duplicate) {
        try { partnerlog.logEvent(e.creatorId, { type: 'grant', reason: 'dup_join', userId: e.userId, guildId: e.cardGuildId, roleId: e.roleId, sponsorGuildId: e.sponsorGuildId, srcId: `dup:${e.userId}:${e.sponsorGuildId}` }); } catch { /* never block */ }
        return;
    }
    // EXTRA bonus ad: the campaign delivery + a $0 joinlink (for the stat and for
    // reversing the delivery on leave) are recorded, but the PARTNER IS NOT PAID
    // for it — no balance credit, no shares, no funds-log entry.
    if (e.viaExtra) { console.log(`[AUTOJOIN] extra-ad delivery ${e.userId} on sponsor ${e.sponsorGuildId} (no partner credit)`); return; }
    const amount = credit.amount;
    try { partnerlog.logEvent(e.creatorId, { type: 'grant', reason: 'paid', amount, userId: e.userId, guildId: e.cardGuildId, roleId: e.roleId, sponsorGuildId: e.sponsorGuildId, srcId: credit.linkId }); } catch { /* never block */ }
    await logFunds(clients, { type: 'credit', creatorId: e.creatorId, userId: e.userId, guildId: e.cardGuildId, channelId: e.channelId, amount, sponsorGuildId: e.sponsorGuildId, reason: 'Join auto-verified — first click + confirmed join (no second click)' });
    if (!investorOwned) await payShares(clients, amount, { revenuePerJoin: econ.revenue }).catch(() => null);
    await maybeAutoWithdraw(clients, e.creatorId);
    if (credit.referrerId) await maybeAutoWithdraw(clients, credit.referrerId).catch(() => null); // referral bonus credited at join
    console.log(`[AUTOJOIN] credited ${e.userId} on sponsor ${e.sponsorGuildId} (partner ${e.creatorId}) $${amount}`);
}

async function sweepOnce(clients) {
    const list = load();
    if (!list.length) return;
    const now = Date.now();
    const keep = [];
    let i = 0;
    for (const e of list) {
        if (!e || !e.userId || !e.sponsorGuildId) continue;
        if (now - (Number(e.ts) || 0) >= WINDOW_MS) continue;                        // expired → drop
        // Drop only when the join is ALREADY tallied: a joinlink exists for this
        // sponsor (partner credited) OR a COUNTED verified entry exists. A bare
        // `noAd` placeholder (e.g. the confirm click failed to resolve the sponsor)
        // must NOT drop the entry — auto-join upgrades it to a counted join below.
        if (alreadyJoined(e.userId, e.sponsorGuildId) || alreadyCounted(e.userId, e.cardGuildId, e.roleId)) continue;
        const bot = (Array.isArray(clients) ? clients : []).find((c) => c.guilds?.cache?.has(e.sponsorGuildId));
        const present = await isMember(bot || null, e.sponsorGuildId, e.userId).catch(() => null);
        if (present === true) {
            try { await complete(clients, e); }                                       // success → drop
            catch (err) { console.error('[AUTOJOIN] complete:', err.message); keep.push(e); }
        } else {
            keep.push(e);                                                             // false/null → retry next sweep
        }
        if (++i % 5 === 0) await sleep(300);                                          // gentle on rate limits
    }
    if (keep.length !== list.length) saveJSON(FILE, keep);
}

function startAutoJoinSweep(clients) {
    const every = Number(process.env.AUTOJOIN_SWEEP_MS) || 3 * 60 * 1000;
    const tick = () => sweepOnce(clients).catch((e) => console.error('[AUTOJOIN] sweep error:', e.message));
    setInterval(tick, every);
    setTimeout(tick, 75 * 1000);
    console.log(`[AUTOJOIN] first-click→join sweep every ${Math.round(every / 60000)}m`);
}

module.exports = { record, complete, sweepOnce, startAutoJoinSweep };

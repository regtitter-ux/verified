// Join-verification ("проверка на заход").
//
// When the ad shown on a verification card links to a Discord server that one of
// our network bots is already a member of, that card automatically switches to a
// pay-per-real-join model:
//   • payout rate becomes $5 per 100 successful (joined) verifications;
//   • a verification pays out only once the user is confirmed a member of that
//     sponsor server;
//   • if the user later leaves the sponsor server, the payout for that member is
//     clawed back from the card owner's balance.
//
// Leave detection uses a periodic REST reconciliation sweep. A single-member
// `guild.members.fetch(id)` needs no privileged gateway intent, so every public
// bot stays intent-free (no Server Members intent required anywhere).
const { loadJSON, saveJSON } = require('./database.js');
const { logFunds } = require('./fundslog.js');
const { boostedRate, REFERRAL_RATE } = require('./referral.js');
const { syncHubMember } = require('./hubrole.js');
const partnerlog = require('./partnerlog.js');
const campaigns = require('./campaigns.js');

const JOIN_BID = 5;               // default $ per 100 successful (joined) verifications
const PER_JOIN = JOIN_BID / 100;  // $0.05 per confirmed join (default rate)
const round2 = (n) => +((Number(n) || 0).toFixed(2));
const round4 = (n) => +((Number(n) || 0).toFixed(4));

// Per-user join-check rate ($ per 100 joins), overridable via "Bid extra" in /bal.
const getJoinBid = (s) => {
    const v = Number(s?.joinBid);
    return Number.isFinite(v) && v >= 0 ? v : JOIN_BID;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// discord.gg/CODE · discord.com/invite/CODE · discordapp.com/invite/CODE · .gg/CODE
// The bare ".gg/" shorthand must be preceded by a non-alphanumeric (or start),
// so a template with no space before the link (e.g. "Join:{link}") still
// extracts the code — but "discord.gg/" is still handled by its own branch.
const INVITE_RE = /(?:discord(?:app)?\.com\/invite\/|discord\.gg\/|(?:^|[^a-z0-9])\.gg\/)([a-z0-9-]+)/gi;
function extractInviteCodes(text) {
    const codes = new Set();
    if (!text) return [];
    let m;
    INVITE_RE.lastIndex = 0;
    while ((m = INVITE_RE.exec(String(text)))) codes.add(m[1]);
    return [...codes];
}

// code -> { guildId|null, ts, ttl }; resolved invites are cached to avoid
// re-fetching. A POSITIVE resolution is cached long; a "genuinely dead invite"
// (Unknown Invite) only briefly so a fixed link recovers fast; a TRANSIENT
// failure (rate-limit, network, any other error) is NOT cached at all — one
// blip must never suppress a valid ad for hours.
const inviteCache = new Map();
const INVITE_TTL = 6 * 3600 * 1000;      // positive result
const INVITE_NEG_TTL = 5 * 60 * 1000;    // confirmed-dead invite

async function inviteGuildId(client, code) {
    const hit = inviteCache.get(code);
    if (hit && Date.now() - hit.ts < hit.ttl) return hit.guildId;
    try {
        const inv = await client.fetchInvite(code);
        const guildId = inv?.guild?.id || null;
        // A successful fetch that yields no guild id (group-DM invite / odd
        // Discord response) is treated as a short negative, not cached 6h.
        inviteCache.set(code, { guildId, ts: Date.now(), ttl: guildId ? INVITE_TTL : INVITE_NEG_TTL });
        return guildId;
    } catch (e) {
        if (e?.code === 10006) inviteCache.set(code, { guildId: null, ts: Date.now(), ttl: INVITE_NEG_TTL }); // Unknown Invite
        // else: transient — do NOT cache; retry on the next call.
        return null;
    }
}

// Resolve the sponsor server referenced in an ad and check whether any network
// bot is a member of it. Returns { guildId, bot } if a bot is present, else null.
async function resolveSponsorPresence(clients, adText) {
    const codes = extractInviteCodes(adText);
    if (!codes.length || !clients.length) return null;
    for (const code of codes) {
        // Try each bot as the resolver until one succeeds — so a single bot being
        // rate-limited / unable to fetch this invite doesn't suppress the ad. The
        // per-code cache short-circuits once any bot resolves it.
        let guildId = null;
        for (const c of clients) { guildId = await inviteGuildId(c, code); if (guildId) break; }
        if (!guildId) continue;
        const bot = clients.find((c) => c.guilds.cache.has(guildId));
        if (bot) return { guildId, bot };
    }
    return null;
}

// Is `userId` currently a member of `guildId`, seen through `bot`?
// Returns true / false / null (null = couldn't determine, transient error).
async function isMember(bot, guildId, userId) {
    const g = bot?.guilds.cache.get(guildId);
    if (!g) return null;
    try {
        await g.members.fetch({ user: userId, force: true });
        return true;
    } catch (e) {
        if (e?.code === 10007 || e?.code === 10013) return false; // Unknown Member / Unknown User
        return null;
    }
}

// Credit the card owner for one confirmed join (at their join-check rate) and
// remember the payout — plus the granted role — so both can be reversed if the
// user later leaves the sponsor server.
// Returns { amount, linkId, duplicate }. `duplicate:true` (amount 0) means this
// (user, sponsor) already had a live join — nothing was credited or recorded.
function creditJoin(creatorId, guildId, userId, cardGuildId, roleId, channelId, extra = {}) {
    // Atomic idempotency guard. One real invite pays once per (user, sponsor).
    // The caller's isDupJoin pre-check has awaits between it and this call, so two
    // concurrent verify clicks can both pass it — but THIS function is fully
    // synchronous (no await), so the single-threaded event loop can't interleave
    // two calls: the second sees the first's appended joinlink and bails. This is
    // the race-proof point of truth for "one join = one credit".
    const list = loadJSON('joinlinks.json', []);
    const arr = Array.isArray(list) ? list : [];
    if (arr.some((r) => r && (r.status === 'joined' || r.status === 'settled') && r.userId === userId && r.guildId === guildId)) {
        return { amount: 0, linkId: null, duplicate: true };
    }

    const settings = loadJSON('settings.json');
    if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
    const s = settings[creatorId];
    // Boosted referral rate acts as a floor while active (see referral.js).
    const perJoin = round2(boostedRate(s, getJoinBid(s)) / 100);
    s.balance = round2((Number(s.balance) || 0) + perJoin);
    saveJSON('settings.json', settings);

    const id = newId();
    const rec = {
        id, userId, guildId, creatorId, amount: perJoin,
        cardGuildId: cardGuildId || null, roleId: roleId || null, channelId: channelId || null,
        ts: Date.now(), status: 'joined'
    };
    // Optional economics for the shares/revenue stats: revenue (what the buyer
    // actually paid per join — lower for a manager sale). Absent = the standard
    // $0.10 revenue (recomputed downstream).
    if (extra && typeof extra === 'object') {
        if (Number.isFinite(Number(extra.revenue))) rec.revenue = round4(Number(extra.revenue));
        if (extra.managerId) rec.managerId = String(extra.managerId);
    }
    arr.push(rec);
    saveJSON('joinlinks.json', arr);
    return { amount: perJoin, linkId: id, duplicate: false };
}

// Is the sponsor server `gid` being advertised on the network right now?
// index.js stamps sponsorshow.json every time a join-check ad for a sponsor is
// actually displayed to a user. If the last display is older than the stale
// window, the ad is considered "not showing" — whatever the reason (campaign
// delivered, house-ad limit hit, kran closed, ad removed, opted out on every
// partner server). We treat that as the ad being off.
const SHOW_STALE_MS = Number(process.env.SPONSOR_SHOW_STALE_MS) || 30 * 60 * 1000;
function sponsorAdShowing(gid, shows) {
    const map = shows || loadJSON('sponsorshow.json', {});
    return (Date.now() - (Number(map?.[gid]) || 0)) <= SHOW_STALE_MS;
}

// Apply the leave-clawback to the given set of joinlink record IDs: reverse the
// payout on the card owner (and any referrer bonus already earned via a
// withdrawal), strip the granted role in the card guild, and drop the
// verified.json entry so the user can re-verify later.
async function finalizeLeavers(clients, leaverIds) {
    const idSet = leaverIds instanceof Set ? leaverIds : new Set(leaverIds || []);
    if (!idSet.size) return;

    // The loop below awaits Discord/audit calls between reading and writing the
    // money files, so it must not save a snapshot loaded up-front — a concurrent
    // creditJoin would be clobbered. Instead we read from `settings` (a snapshot,
    // used only for consistent in-loop reads), accumulate the net changes, and
    // apply them synchronously to a FRESH load at the end (see the apply block).
    const list = loadJSON('joinlinks.json', []);
    const settings = loadJSON('settings.json');
    let verifiedChanged = false;
    // Per-record outcomes, committed atomically at the end. Each money change is
    // gated on winning the joined->left transition on a FRESH load, so a
    // concurrent finalizeLeavers for the same record can't double-claw, and a
    // concurrent creditJoin isn't clobbered.
    const outcomes = [];         // { id, kind, ts, creatorId?, amt?, referrerId?, refClaw? }
    const verifiedRemovals = []; // { userId, cardGuildId, roleId }

    // A member leaving only claws back the payout while the SPONSOR's ad is
    // actively being shown on the network. Once that ad has been off for a
    // while (campaign delivered, house-ad limit hit, kran closed, removed, or
    // opted out on every partner server), a later leave no longer reverses the
    // partner's earnings — the join is finalized as 'settled' and never
    // revisited, even if the ad resumes. Both the automatic ad-off check and
    // the manual owner opt-out are keyed by the sponsor server (rec.guildId),
    // the same key sponsorshow.json is stamped under.
    //
    // (Previously the automatic skip was gated behind the owner flag, but the
    // admin toggle stores that flag under the PARTNER server id — a different
    // guild dimension than rec.guildId — so it never matched and clawbacks kept
    // firing days after a sponsor's ad had stopped. The ad-off skip is now
    // automatic, correctly keyed by the sponsor.)
    const cfg = loadJSON('siteconfig.json', {});
    const clawOff = (cfg.clawbackOffAfterComplete && typeof cfg.clawbackOffAfterComplete === 'object') ? cfg.clawbackOffAfterComplete : {};
    const shows = loadJSON('sponsorshow.json', {});

    // A partner can hide a sponsor on one of their servers (partner cabinet →
    // "Активные рекламы"). Hiding = "stop running this sponsor here", so — like an
    // ad that stopped showing — a later leave of that sponsor must NOT be clawed
    // back from that partner. The hide list stores campaign ids per card guild;
    // map them to sponsor guild ids (rec.guildId is a sponsor guild). Memoized
    // per (creator, card guild). `settings` is the in-loop snapshot, read-only here.
    const camps = campaigns.loadCampaigns();
    const hiddenSponsorCache = new Map();
    const hiddenSponsorsFor = (creatorId, cardGuildId) => {
        const key = `${creatorId}:${cardGuildId}`;
        if (hiddenSponsorCache.has(key)) return hiddenSponsorCache.get(key);
        const set = new Set();
        const ids = settings[creatorId] && settings[creatorId].hiddenByGuild && settings[creatorId].hiddenByGuild[cardGuildId];
        if (Array.isArray(ids)) for (const cid of ids) { const sp = camps[cid] && camps[cid].sponsorGuildId; if (sp) set.add(sp); }
        hiddenSponsorCache.set(key, set);
        return set;
    };

    for (const rec of Array.isArray(list) ? list : []) {
        if (rec.status !== 'joined' || !idSet.has(rec.id)) continue;

        // Skip the clawback when the sponsor's ad isn't showing (automatic), when
        // the owner force-disabled it for this sponsor, or when the partner has
        // hidden this sponsor on the server the join came from: keep the payout,
        // role and verification, and finalize as 'settled' so no sweep retries.
        const partnerHidSponsor = hiddenSponsorsFor(rec.creatorId, rec.cardGuildId).has(rec.guildId);
        if (!sponsorAdShowing(rec.guildId, shows) || clawOff[rec.guildId] || partnerHidSponsor) {
            outcomes.push({ id: rec.id, kind: 'settled', ts: Date.now() });
            console.log(`[LEAVE] clawback skipped (${partnerHidSponsor ? 'sponsor hidden by partner' : 'sponsor ad not showing'}): sponsor=${rec.guildId} user=${rec.userId}`);
            continue;
        }

        // Reverse the payout (balance may go negative, like manual edits).
        // The portion that pushes the balance below zero is money already paid out
        // via a withdrawal — that's the part the referrer earned a bonus on.
        // `before` reads from the snapshot (mutated in-loop to stay consistent
        // across multiple records of the same creator); the actual debit is
        // applied to a fresh load in the commit block.
        const before = settings[rec.creatorId] ? (Number(settings[rec.creatorId].balance) || 0) : 0;
        const outcome = { id: rec.id, kind: 'left', ts: Date.now(), userId: rec.userId, cardGuildId: rec.cardGuildId, sponsorGuildId: rec.guildId, roleId: rec.roleId, partnerId: rec.creatorId };
        if (settings[rec.creatorId]) {
            settings[rec.creatorId].balance = round2(before - rec.amount);
            outcome.creatorId = rec.creatorId;
            outcome.amt = rec.amount;
        }
        outcomes.push(outcome);

        await logFunds(clients, {
            type: 'debit', creatorId: rec.creatorId, userId: rec.userId,
            guildId: rec.cardGuildId, channelId: rec.channelId, amount: rec.amount,
            sponsorGuildId: rec.guildId,
            reason: 'Clawback — join reversed: member left the sponsor server'
        });

        // If the referrer already got a bonus from these funds (i.e. they were
        // withdrawn), claw back their 10% share of the withdrawn portion too.
        const withdrawnPortion = round2(rec.amount - Math.max(0, Math.min(before, rec.amount)));
        if (withdrawnPortion > 0) {
            const referrerId = Object.keys(settings).find(
                (uid) => uid !== rec.creatorId && Array.isArray(settings[uid].referrals) && settings[uid].referrals.includes(rec.creatorId)
            );
            const refClaw = round2(withdrawnPortion * REFERRAL_RATE);
            if (referrerId && refClaw > 0) {
                settings[referrerId].balance = round2((Number(settings[referrerId].balance) || 0) - refClaw);
                // Keep the "unwithdrawn referral bonus" pool in sync — otherwise
                // this bonus, already clawed back off the balance, would still
                // be treated as bonus (and excluded from an upstream cut) on
                // the referrer's next withdrawal. Clamp to 0 for the case
                // where the referrer already withdrew and drained the pool.
                const accrued = Number(settings[referrerId].refBonusAccrued) || 0;
                settings[referrerId].refBonusAccrued = round2(Math.max(0, accrued - refClaw));
                outcome.referrerId = referrerId;
                outcome.refClaw = refClaw;
                await logFunds(clients, {
                    type: 'debit', creatorId: referrerId, userId: rec.creatorId,
                    amount: refClaw, sponsorGuildId: rec.guildId,
                    reason: 'Referral clawback — referred partner\'s join reversed (member left the sponsor server)'
                });
            }
        }

        // Undo the verification itself: strip the granted role and drop the verified
        // record, so leaving the sponsor server fully reverses the verification.
        if (rec.cardGuildId && rec.roleId) {
            const cardBot = clients.find((c) => c.guilds.cache.has(rec.cardGuildId));
            const g = cardBot?.guilds.cache.get(rec.cardGuildId);
            if (g) {
                const m = await g.members.fetch(rec.userId).catch(() => null);
                if (m && m.roles.cache.has(rec.roleId)) await m.roles.remove(rec.roleId).catch(() => null);
            }
            verifiedRemovals.push({ userId: rec.userId, cardGuildId: rec.cardGuildId, roleId: rec.roleId });
            verifiedChanged = true;
            outcome.unverified = true;
        }
    }

    // Commit synchronously (no awaits) on FRESH loads, so writes that landed
    // during the loop's awaits survive. Each outcome is applied only if the
    // fresh joinlink is still 'joined' — winning that transition is the single
    // commit point for both the status change and the money, so a concurrent
    // finalizeLeavers for the same record can't double-claw.
    if (outcomes.length) {
        const freshList = loadJSON('joinlinks.json', []);
        const fl = Array.isArray(freshList) ? freshList : [];
        const byId = new Map(fl.map((r) => [r.id, r]));
        const freshSettings = loadJSON('settings.json');
        let listDirty = false, settingsDirty = false;
        for (const o of outcomes) {
            const r = byId.get(o.id);
            if (!r || r.status !== 'joined') continue; // already finalized elsewhere
            if (o.kind === 'settled') { r.status = 'settled'; r.settledAt = o.ts; listDirty = true; continue; }
            r.status = 'left'; r.leftAt = o.ts; listDirty = true;
            if (o.creatorId && freshSettings[o.creatorId]) {
                freshSettings[o.creatorId].balance = round2((Number(freshSettings[o.creatorId].balance) || 0) - o.amt);
                settingsDirty = true;
                // Partner activity log — the clawback debit we actually applied.
                try { partnerlog.logEvent(o.partnerId, { type: 'debit', amount: o.amt, reason: 'left', userId: o.userId, guildId: o.cardGuildId, sponsorGuildId: o.sponsorGuildId, roleId: o.roleId, srcId: o.id }); } catch { /* never break the commit */ }
            }
            if (o.referrerId && freshSettings[o.referrerId]) {
                freshSettings[o.referrerId].balance = round2((Number(freshSettings[o.referrerId].balance) || 0) - o.refClaw);
                freshSettings[o.referrerId].refBonusAccrued = round2(Math.max(0, (Number(freshSettings[o.referrerId].refBonusAccrued) || 0) - o.refClaw));
                settingsDirty = true;
                // Partner activity log — the referrer's referral-bonus clawback.
                if (o.refClaw > 0) { try { partnerlog.logEvent(o.referrerId, { type: 'debit', amount: o.refClaw, reason: 'referral_clawback', userId: o.userId, sponsorGuildId: o.sponsorGuildId, srcId: `refclaw:${o.id}` }); } catch { /* never break the commit */ } }
            }
            // Partner activity log — the verification removal (снятие верифки).
            if (o.unverified) { try { partnerlog.logEvent(o.partnerId, { type: 'unverify', reason: 'left', userId: o.userId, guildId: o.cardGuildId, sponsorGuildId: o.sponsorGuildId, roleId: o.roleId, srcId: o.id }); } catch { /* never break the commit */ } }
        }
        if (settingsDirty) saveJSON('settings.json', freshSettings);
        if (listDirty) saveJSON('joinlinks.json', fl);
    }
    if (verifiedChanged) {
        const freshVer = loadJSON('verified.json', []);
        let fv = Array.isArray(freshVer) ? freshVer : [];
        for (const r of verifiedRemovals) {
            fv = fv.filter((u) => !(u.id === r.userId && u.guildId === r.cardGuildId && (u.roleId || null) === r.roleId));
        }
        saveJSON('verified.json', fv);
    }

    // Removed verified.json entries may have taken a user below "has any
    // active verification" — hub-role reconciliation runs after the save so
    // it reads the fresh state.
    if (verifiedChanged) {
        const touched = new Set();
        for (const rec of Array.isArray(list) ? list : []) {
            if (idSet.has(rec.id) && rec.userId) touched.add(rec.userId);
        }
        for (const uid of touched) {
            await syncHubMember(clients, uid).catch(() => null);
        }
    }
}

// Periodic reconciliation: for every still-joined record, re-check membership via
// whichever network bot sits on that server; on a confirmed leave, claw the money
// back from the card owner (balance may go negative, like manual edits).
async function sweepOnce(clients) {
    const snapshot = loadJSON('joinlinks.json', []);
    if (!Array.isArray(snapshot) || !snapshot.length) return;

    const leavers = new Set();
    for (const rec of snapshot) {
        if (rec.status !== 'joined') continue;
        const bot = clients.find((c) => c.guilds.cache.has(rec.guildId));
        if (!bot) continue; // no bot on that server right now — can't tell, skip
        const present = await isMember(bot, rec.guildId, rec.userId);
        if (present === false) leavers.add(rec.id);
        await sleep(250); // be gentle on rate limits
    }
    await finalizeLeavers(clients, leavers);
}

// Realtime path: fired from the `guildMemberRemove` gateway event on any bot
// that has Server Members Intent enabled. Immediately runs the same clawback
// logic as the sweep for every joinlink record referencing this (sponsor, user).
async function handleMemberLeave(clients, sponsorGuildId, userId) {
    if (!sponsorGuildId || !userId) return;
    const snapshot = loadJSON('joinlinks.json', []);
    if (!Array.isArray(snapshot) || !snapshot.length) return;
    const matches = new Set();
    for (const rec of snapshot) {
        if (rec.status === 'joined' && rec.guildId === sponsorGuildId && rec.userId === userId) {
            matches.add(rec.id);
        }
    }
    if (matches.size) await finalizeLeavers(clients, matches);
}

function startJoinCheckSweep(clients) {
    const every = Number(process.env.JOINCHECK_SWEEP_MS) || 15 * 60 * 1000;
    const tick = () => sweepOnce(clients).catch((e) => console.error('[JOINCHECK] sweep error:', e.message));
    setInterval(tick, every);
    setTimeout(tick, 60 * 1000); // first pass shortly after startup
    console.log(`[JOINCHECK] reconciliation sweep every ${Math.round(every / 60000)}m`);
}

module.exports = {
    JOIN_BID, PER_JOIN, getJoinBid,
    extractInviteCodes, resolveSponsorPresence, isMember,
    creditJoin, sweepOnce, startJoinCheckSweep, handleMemberLeave
};

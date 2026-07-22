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
const usertoken = require('./usertoken.js');
const sponsorshow = require('./sponsorshow.js');
const webhooks = require('./webhooks.js');
const rateLimit = require('./ratelimit.js');
const proxy = require('./proxy.js');

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

// A single Discord REST call must never hang the caller forever — a bot stuck in
// a reconnect loop (dead token, gateway 4004) can otherwise leave members.fetch /
// fetchInvite pending indefinitely, freezing the whole verification flow. Race
// every such call against a hard timeout; a timeout rejects like a transient error.
const REST_TIMEOUT_MS = 4000;
function withRestTimeout(promise, ms = REST_TIMEOUT_MS) {
    let t;
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('rest-timeout'), { code: '__TIMEOUT__' })), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function inviteGuildId(code) {
    const hit = inviteCache.get(code);
    if (hit && Date.now() - hit.ts < hit.ttl) return hit.guildId;
    // Invite lookup is a PUBLIC request (no bot token), so it doesn't matter which
    // bot asks — one fetch resolves it. It is routed through the proxy when
    // DISCORD_PROXY is set (invite endpoint is the ban-prone one), else direct.
    const inv = await rateLimit.schedule(() => proxy.getInvite(code));
    // Transient failure (timeout / rate-limit / 5xx) → NOT cached: a blip must
    // never poison a valid invite as "dead" and suppress its ad. Retry next call.
    if (!inv) return null;
    // Only a CONFIRMED-dead invite (404 Unknown Invite) is cached as negative.
    if (inv.notFound) { inviteCache.set(code, { guildId: null, ts: Date.now(), ttl: INVITE_NEG_TTL }); return null; }
    const guildId = inv.guild?.id || null;
    // A 200 with no guild id (group-DM invite / odd response) → short negative, not 6h.
    inviteCache.set(code, { guildId, ts: Date.now(), ttl: guildId ? INVITE_TTL : INVITE_NEG_TTL });
    return guildId;
}

// Resolve the sponsor server referenced in an ad and check whether any network
// bot is a member of it. Returns { guildId, bot } if a bot is present, else null.
async function resolveSponsorPresence(clients, adText) {
    const codes = extractInviteCodes(adText);
    const all = Array.isArray(clients) ? clients : [];
    // Only ask bots that are actually CONNECTED — a bot stuck reconnecting (dead
    // token / gateway 4004) makes fetchInvite hang until the timeout; skipping it
    // is what keeps this fast. But resolve SEQUENTIALLY (break on first success):
    // fetchInvite is a public lookup that any connected bot can answer, so one
    // call per invite is enough. Fanning it out to every bot at once (the earlier
    // "parallel" attempt) multiplied REST calls ~N×, tripping Discord rate limits
    // and suppressing ads network-wide. Fall back to the full list only if none
    // report ready.
    const ready = all.filter((c) => { try { return c.isReady(); } catch { return false; } });
    const pool = ready.length ? ready : all;
    if (!codes.length || !pool.length) return null;
    // Total budget for resolving THIS ad. The invite lookup is a single public
    // request (see inviteGuildId — one fetch per code, not per bot), so if it's
    // timing out (e.g. the egress IP is rate-limited) we give up fast rather than
    // hang, keeping verification responsive (shows no ad rather than freezing).
    const deadline = Date.now() + 3500;
    for (const code of codes) {
        if (Date.now() > deadline) break;
        const guildId = await inviteGuildId(code);
        if (!guildId) continue;
        const bot = pool.find((c) => c.guilds.cache.has(guildId));
        if (bot) return { guildId, bot };
        // Reserve (invisible to buyers): no network bot on this server, but the
        // personal account is a member → joins can still be verified via the user
        // token. bot:null signals "use the reserve" to isMember.
        if (usertoken.enabled() && await usertoken.coversGuild(guildId)) return { guildId, bot: null };
    }
    return null;
}

// Is `userId` currently a member of `guildId`, seen through `bot`?
// Returns true / false / null (null = couldn't determine, transient error).
// When no bot covers the guild, falls back to the reserve user account for the
// servers it's a member of (else null — never guesses).
async function isMember(bot, guildId, userId) {
    const g = bot?.guilds.cache.get(guildId);
    if (g) {
        try {
            await withRestTimeout(rateLimit.schedule(() => g.members.fetch({ user: userId, force: true })));
            return true;
        } catch (e) {
            if (e?.code === 10007 || e?.code === 10013) return false; // Unknown Member / Unknown User
            return null;                                              // incl. timeout → uncertain
        }
    }
    // Reserve path: no bot on this server → read membership via the user token,
    // but only for servers the personal account actually covers (so a 404 means
    // "not a member", not "the account isn't there").
    if (usertoken.enabled() && await usertoken.coversGuild(guildId)) {
        return usertoken.isMember(guildId, userId);
    }
    return null;
}

// Credit the card owner for one confirmed join (at their join-check rate) and
// remember the payout — plus the granted role — so both can be reversed if the
// user later leaves the sponsor server.
// Returns { amount, linkId, duplicate }. `duplicate:true` (amount 0) means this
// (user, sponsor) already has an ACTIVE (still-joined) credit — nothing was
// credited or recorded. A user who genuinely left (status 'left', clawed back —
// or 'settled', finalized without a clawback) and later rejoins is credited
// again: we bill per active membership and reverse leaves, so a real rejoin is a
// new join. Only a continuous, uninterrupted membership is paid once.
function creditJoin(creatorId, guildId, userId, cardGuildId, roleId, channelId, extra = {}) {
    // Atomic idempotency guard. One credit per ACTIVE membership per (user,
    // sponsor). The caller's isDupJoin pre-check has awaits between it and this
    // call, so two concurrent verify clicks can both pass it — but THIS function
    // is fully synchronous (no await), so the single-threaded event loop can't
    // interleave two calls: the second sees the first's appended joinlink and
    // bails. This is the race-proof point of truth for "one active join = one
    // credit". A prior 'left'/'settled' record does NOT block a genuine rejoin.
    const list = loadJSON('joinlinks.json', []);
    const arr = Array.isArray(list) ? list : [];
    if (arr.some((r) => r && r.status === 'joined' && r.userId === userId && r.guildId === guildId)) {
        return { amount: 0, linkId: null, duplicate: true };
    }

    const settings = loadJSON('settings.json');
    if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
    const s = settings[creatorId];
    // noPay = record the join (joinlink + dup guard) WITHOUT paying the partner —
    // used by the EXTRA bonus ad, which delivers to the buyer but doesn't credit
    // the partner. Amount is 0 and the balance is untouched.
    const noPay = Boolean(extra && extra.noPay);
    // Boosted referral rate acts as a floor while active (see referral.js).
    const perJoin = noPay ? 0 : round2(boostedRate(s, getJoinBid(s)) / 100);
    // Referral: the partner's referrer earns their 10% cut of THIS join right now,
    // at join time — NOT deferred to the partner's withdrawal. This keeps earnings
    // symmetric with the leave clawback (which reverses the referrer's cut the
    // instant the user leaves), so a referrer can't go negative from churn before
    // their referral has withdrawn anything. The exact bonus is stored on the
    // joinlink so the reversal debits precisely what was credited.
    let referrerId = null, refBonus = 0;
    if (!noPay && perJoin > 0) {
        referrerId = Object.keys(settings).find(
            (uid) => uid !== creatorId && Array.isArray(settings[uid].referrals) && settings[uid].referrals.includes(creatorId)
        ) || null;
        if (referrerId) {
            refBonus = round2(perJoin * REFERRAL_RATE);
            if (refBonus <= 0) referrerId = null;
        }
    }
    if (!noPay) {
        s.balance = round2((Number(s.balance) || 0) + perJoin);
        if (referrerId) settings[referrerId].balance = round2((Number(settings[referrerId].balance) || 0) + refBonus);
        saveJSON('settings.json', settings);
    }

    const id = newId();
    const rec = {
        id, userId, guildId, creatorId, amount: perJoin,
        cardGuildId: cardGuildId || null, roleId: roleId || null, channelId: channelId || null,
        ts: Date.now(), status: 'joined'
    };
    if (referrerId) { rec.referrerId = referrerId; rec.refBonus = refBonus; }
    // Optional economics for the shares/revenue stats: revenue (what the buyer
    // actually paid per join — lower for a manager sale). Absent = the standard
    // $0.10 revenue (recomputed downstream).
    if (extra && typeof extra === 'object') {
        if (Number.isFinite(Number(extra.revenue))) rec.revenue = round4(Number(extra.revenue));
        if (extra.managerId) rec.managerId = String(extra.managerId);
        if (extra.botId) rec.botId = String(extra.botId); // developer API: which bot delivered the join
        if (extra.extraPlacement) rec.extraPlacement = String(extra.extraPlacement); // 'pre' | 'post' — extra-ad button
    }
    arr.push(rec);
    saveJSON('joinlinks.json', arr);
    // Activity-log the referral credit so the referrer sees it the moment it lands
    // (symmetric with the 'referral_clawback' debit logged on a leave).
    if (referrerId && refBonus > 0) {
        try { partnerlog.logEvent(referrerId, { type: 'credit', reason: 'referral_bonus', amount: refBonus, userId: creatorId, sponsorGuildId: guildId, srcId: `refbonus:${id}` }); } catch { /* never block the credit */ }
        console.log('[REFERRAL] credit', JSON.stringify({ referrer: referrerId, referral: creatorId, sponsor: guildId, bonus: refBonus, join: id }));
    }
    return { amount: perJoin, linkId: id, duplicate: false, referrerId, refBonus };
}

// Is the sponsor server `gid` being advertised on the network right now?
// A stamp is written every time a join-check ad for a sponsor is actually
// displayed. If the last display is older than the stale window, the ad is
// considered "not showing" — whatever the reason (campaign delivered, house-ad
// limit hit, kran closed, ad removed, opted out on every partner server).
const sponsorAdShowing = (gid, shows) => sponsorshow.showing(gid, shows);

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
    const shows = sponsorshow.loadShows();
    // Ad ERAS. "Showing" is keyed by sponsor alone, so a NEW campaign for a server
    // made every historical join for it clawback-able again — a partner could be
    // charged for a leave from a deal that closed months ago (and that they may no
    // longer even run). A join delivered before the current run of advertising
    // started belongs to a closed deal and is settled instead. See sponsorshow.js.
    const eras = sponsorshow.loadEras();

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
        const oldEra = sponsorshow.joinPredatesEra(rec.guildId, rec.ts, eras);
        if (!sponsorAdShowing(rec.guildId, shows) || clawOff[rec.guildId] || partnerHidSponsor || oldEra) {
            outcomes.push({ id: rec.id, kind: 'settled', ts: Date.now() });
            const why = oldEra ? 'join predates the current ad era'
                : partnerHidSponsor ? 'sponsor hidden by partner'
                : clawOff[rec.guildId] ? 'clawback disabled for sponsor'
                : 'sponsor ad not showing';
            console.log(`[LEAVE] clawback skipped (${why}): sponsor=${rec.guildId} user=${rec.userId}`);
            continue;
        }

        // Reverse the payout (balance may go negative, like manual edits).
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

        // Referral: the referrer earned their cut of this join AT JOIN TIME, so
        // reverse EXACTLY that stored bonus now — symmetric, no withdrawn-portion
        // heuristic (which could hit a referrer whose referral simply had a low
        // balance). The bonus was recorded on the joinlink by creditJoin.
        const referrerId = rec.referrerId || null;
        const refClaw = round2(Number(rec.refBonus) || 0);
        if (referrerId && refClaw > 0) {
            if (settings[referrerId]) {
                settings[referrerId].balance = round2((Number(settings[referrerId].balance) || 0) - refClaw);
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
                const m = await rateLimit.schedule(() => g.members.fetch(rec.userId)).catch(() => null);
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
                settingsDirty = true;
                // Partner activity log — the referrer's referral-bonus clawback.
                if (o.refClaw > 0) { try { partnerlog.logEvent(o.referrerId, { type: 'debit', amount: o.refClaw, reason: 'referral_clawback', userId: o.userId, sponsorGuildId: o.sponsorGuildId, srcId: `refclaw:${o.id}` }); } catch { /* never break the commit */ } }
                console.log('[REFERRAL] clawback', JSON.stringify({ referrer: o.referrerId, referral: o.partnerId, sponsor: o.sponsorGuildId, bonus: o.refClaw, join: o.id }));
            }
            // Partner activity log — the verification removal (снятие верифки).
            if (o.unverified) { try { partnerlog.logEvent(o.partnerId, { type: 'unverify', reason: 'left', userId: o.userId, guildId: o.cardGuildId, sponsorGuildId: o.sponsorGuildId, roleId: o.roleId, srcId: o.id }); } catch { /* never break the commit */ } }
            // Developer webhook: an API-delivered join was reversed (member left the
            // sponsor). Fire 'reverted' to the developer so they can undo the reward.
            if (o.roleId === 'api' && o.partnerId) {
                webhooks.fire(o.partnerId, 'reverted', { user: o.userId, sponsorId: o.sponsorGuildId, serverId: o.cardGuildId, botId: r.botId || null, amount: o.amt, join: o.id }).catch(() => null);
            }
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
        // A clawback removed a verification → the PARTNER's (card owner's) daily
        // count may have dropped below the threshold, so re-check their hub role.
        const touched = new Set();
        for (const rec of Array.isArray(list) ? list : []) {
            if (idSet.has(rec.id) && rec.creatorId) touched.add(rec.creatorId);
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
        // No bot AND not covered by the reserve → can't tell, skip (never claw).
        if (!bot && !(usertoken.enabled() && await usertoken.coversGuild(rec.guildId))) continue;
        const present = await isMember(bot || null, rec.guildId, rec.userId);
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
    creditJoin, sweepOnce, startJoinCheckSweep, handleMemberLeave, finalizeLeavers
};

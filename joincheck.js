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

const JOIN_BID = 5;               // default $ per 100 successful (joined) verifications
const PER_JOIN = JOIN_BID / 100;  // $0.05 per confirmed join (default rate)
const round2 = (n) => +((Number(n) || 0).toFixed(2));

// Per-user join-check rate ($ per 100 joins), overridable via "Bid extra" in /bal.
const getJoinBid = (s) => {
    const v = Number(s?.joinBid);
    return Number.isFinite(v) && v >= 0 ? v : JOIN_BID;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// discord.gg/CODE · discord.com/invite/CODE · discordapp.com/invite/CODE · .gg/CODE
const INVITE_RE = /(?:discord(?:app)?\.com\/invite\/|discord\.gg\/|(?:^|\s)\.gg\/)([a-z0-9-]+)/gi;
function extractInviteCodes(text) {
    const codes = new Set();
    if (!text) return [];
    let m;
    INVITE_RE.lastIndex = 0;
    while ((m = INVITE_RE.exec(String(text)))) codes.add(m[1]);
    return [...codes];
}

// code -> { guildId|null, ts }; resolved invites are cached to avoid re-fetching.
const inviteCache = new Map();
const INVITE_TTL = 6 * 3600 * 1000;

async function inviteGuildId(client, code) {
    const hit = inviteCache.get(code);
    if (hit && Date.now() - hit.ts < INVITE_TTL) return hit.guildId;
    let guildId = null;
    try {
        const inv = await client.fetchInvite(code);
        guildId = inv?.guild?.id || null;
    } catch { guildId = null; }
    inviteCache.set(code, { guildId, ts: Date.now() });
    return guildId;
}

// Resolve the sponsor server referenced in an ad and check whether any network
// bot is a member of it. Returns { guildId, bot } if a bot is present, else null.
async function resolveSponsorPresence(clients, adText) {
    const codes = extractInviteCodes(adText);
    if (!codes.length || !clients.length) return null;
    const resolver = clients[0];
    for (const code of codes) {
        const guildId = await inviteGuildId(resolver, code);
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
function creditJoin(creatorId, guildId, userId, cardGuildId, roleId, channelId) {
    const settings = loadJSON('settings.json');
    if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
    const s = settings[creatorId];
    // Boosted referral rate acts as a floor while active (see referral.js).
    const perJoin = round2(boostedRate(s, getJoinBid(s)) / 100);
    s.balance = round2((Number(s.balance) || 0) + perJoin);
    saveJSON('settings.json', settings);

    const list = loadJSON('joinlinks.json', []);
    const arr = Array.isArray(list) ? list : [];
    arr.push({
        id: newId(), userId, guildId, creatorId, amount: perJoin,
        cardGuildId: cardGuildId || null, roleId: roleId || null, channelId: channelId || null,
        ts: Date.now(), status: 'joined'
    });
    saveJSON('joinlinks.json', arr);
    return perJoin;
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

    // Re-load fresh so records added during any concurrent sweep aren't clobbered.
    const list = loadJSON('joinlinks.json', []);
    const settings = loadJSON('settings.json');
    let verified = loadJSON('verified.json', []);
    if (!Array.isArray(verified)) verified = [];
    let changed = false, verifiedChanged = false;

    // Owner opt-out (per sponsor server): while that server's ad is NOT being
    // shown on the network, a member leaving does NOT claw back the payout —
    // the join is treated as final (money, granted role and verification all
    // stay). Members who leave during a showing period are still clawed back
    // as usual, and if the ad resumes, clawbacks resume — but the ones settled
    // while the ad was off are never revisited. Controlled from the admin
    // Statistics panel.
    const cfg = loadJSON('siteconfig.json', {});
    const clawOff = (cfg.clawbackOffAfterComplete && typeof cfg.clawbackOffAfterComplete === 'object') ? cfg.clawbackOffAfterComplete : {};
    const shows = loadJSON('sponsorshow.json', {});

    for (const rec of Array.isArray(list) ? list : []) {
        if (rec.status !== 'joined' || !idSet.has(rec.id)) continue;

        // Clawback opt-out while the sponsor's ad is off: keep the payout, role
        // and verification, and finalize the record as 'settled' so no sweep
        // ever retries it (even after the ad resumes).
        if (clawOff[rec.guildId] && !sponsorAdShowing(rec.guildId, shows)) {
            rec.status = 'settled';
            rec.settledAt = Date.now();
            changed = true;
            console.log(`[LEAVE] clawback skipped (ad not showing, owner opt-out): sponsor=${rec.guildId} user=${rec.userId}`);
            continue;
        }

        // Reverse the payout (balance may go negative, like manual edits).
        // The portion that pushes the balance below zero is money already paid out
        // via a withdrawal — that's the part the referrer earned a bonus on.
        const before = settings[rec.creatorId] ? (Number(settings[rec.creatorId].balance) || 0) : 0;
        if (settings[rec.creatorId]) {
            settings[rec.creatorId].balance = round2(before - rec.amount);
        }
        rec.status = 'left';
        rec.leftAt = Date.now();
        changed = true;

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
            const beforeLen = verified.length;
            verified = verified.filter((u) => !(u.id === rec.userId && u.guildId === rec.cardGuildId && (u.roleId || null) === rec.roleId));
            if (verified.length !== beforeLen) verifiedChanged = true;
        }
    }

    if (changed) {
        saveJSON('settings.json', settings);
        saveJSON('joinlinks.json', list);
    }
    if (verifiedChanged) saveJSON('verified.json', verified);

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

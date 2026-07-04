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
function creditJoin(creatorId, guildId, userId, dwellMs, cardGuildId, roleId) {
    const settings = loadJSON('settings.json');
    if (!settings[creatorId]) settings[creatorId] = { advText: '', serverAds: {}, partners: [] };
    const s = settings[creatorId];
    const perJoin = round2(getJoinBid(s) / 100);
    s.balance = round2((Number(s.balance) || 0) + perJoin);
    if (Number.isFinite(dwellMs)) {
        if (!Array.isArray(s.dwellSamples)) s.dwellSamples = [];
        s.dwellSamples.push(Math.max(0, Math.round(dwellMs)));
        if (s.dwellSamples.length > 5000) s.dwellSamples.splice(0, s.dwellSamples.length - 5000);
    }
    saveJSON('settings.json', settings);

    const list = loadJSON('joinlinks.json', []);
    const arr = Array.isArray(list) ? list : [];
    arr.push({
        id: newId(), userId, guildId, creatorId, amount: perJoin,
        cardGuildId: cardGuildId || null, roleId: roleId || null,
        ts: Date.now(), status: 'joined'
    });
    saveJSON('joinlinks.json', arr);
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
    if (!leavers.size) return;

    // Re-load fresh so records added during the sweep aren't clobbered.
    const list = loadJSON('joinlinks.json', []);
    const settings = loadJSON('settings.json');
    let verified = loadJSON('verified.json', []);
    if (!Array.isArray(verified)) verified = [];
    let changed = false, verifiedChanged = false;

    for (const rec of Array.isArray(list) ? list : []) {
        if (rec.status !== 'joined' || !leavers.has(rec.id)) continue;

        // Reverse the payout (balance may go negative, like manual edits).
        if (settings[rec.creatorId]) {
            settings[rec.creatorId].balance = round2((Number(settings[rec.creatorId].balance) || 0) - rec.amount);
        }
        rec.status = 'left';
        rec.leftAt = Date.now();
        changed = true;

        // Undo the verification itself: strip the granted role and drop the verified
        // record, so leaving the sponsor server fully reverses the verification.
        if (rec.cardGuildId && rec.roleId) {
            const cardBot = clients.find((c) => c.guilds.cache.has(rec.cardGuildId));
            const g = cardBot?.guilds.cache.get(rec.cardGuildId);
            if (g) {
                const m = await g.members.fetch(rec.userId).catch(() => null);
                if (m && m.roles.cache.has(rec.roleId)) await m.roles.remove(rec.roleId).catch(() => null);
            }
            const before = verified.length;
            verified = verified.filter((u) => !(u.id === rec.userId && u.guildId === rec.cardGuildId && (u.roleId || null) === rec.roleId));
            if (verified.length !== before) verifiedChanged = true;
        }
    }

    if (changed) {
        saveJSON('settings.json', settings);
        saveJSON('joinlinks.json', list);
    }
    if (verifiedChanged) saveJSON('verified.json', verified);
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
    creditJoin, sweepOnce, startJoinCheckSweep
};

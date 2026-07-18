// Hub role sync.
//
// A PARTNER role on one central guild — granted only to a user who currently
// owns an active (non-deleted) verification card that has had at least
// HUBROLE_MIN_PER_DAY verifications in the last 24h, and stripped otherwise.
// (It used to go to anyone who'd ever verified anywhere, which handed it out to
// everyone — this restricts it to active partners.)
//
// Uses `guild.members.fetch(userId)` (single-member REST fetch, works without
// any privileged intent) plus a local `hubroleusers.json` set that tracks
// users we granted the role to — so a periodic sweep can still find and
// revoke stale roles without needing the GuildMembers intent to enumerate
// role holders.
const { loadJSON, saveJSON } = require('./database.js');
const poster = require('./poster.js');

const HUB_GUILD_ID = process.env.HUB_GUILD_ID || '1521868035088978073';
const HUB_ROLE_ID = process.env.HUB_ROLE_ID || '1523062132214730813';
const MIN_PER_DAY = () => Number(process.env.HUBROLE_MIN_PER_DAY) || 1;   // min verifications/24h to qualify
const DAY_MS = 24 * 3600 * 1000;

const enabled = () => Boolean(HUB_GUILD_ID) && Boolean(HUB_ROLE_ID);

// The (guildId|roleId) keys of every LIVE (non-deleted) verification card a user
// owns — including old role ids from a "Сбросить роль" so historical verifs still
// match. Empty set = the user owns no active card.
function liveCardKeys(uid) {
    const keys = new Set();
    for (const c of loadJSON('cards.json', [])) {
        if (!c || c.deletedAt || String(c.creatorId || '') !== uid) continue;
        const roles = [c.roleId || null, ...(Array.isArray(c.roleHistory) ? c.roleHistory : [])];
        for (const r of roles) keys.add(`${c.guildId}|${r || ''}`);
    }
    return keys;
}

// A user qualifies for the hub role iff they own a live verification card AND
// that card has had at least MIN_PER_DAY real verifications in the last 24h.
// Extra-ad bonus joins (viaExtra) are NOT counted — they aren't card verifications.
function isActivePartner(userId) {
    const uid = String(userId || '');
    if (!uid) return false;
    const keys = liveCardKeys(uid);
    if (!keys.size) return false;                       // no active card
    const from = Date.now() - DAY_MS;
    const min = MIN_PER_DAY();
    let n = 0;
    for (const u of loadJSON('verified.json', [])) {
        if (!u || u.viaExtra || String(u.creatorId || '') !== uid) continue;
        if ((Number(u.timestamp) || 0) <= from) continue;
        if (!keys.has(`${u.guildId}|${u.roleId || ''}`)) continue;
        if (++n >= min) return true;
    }
    return false;
}

// Any random ready bot that's on the hub guild can manage the hub role — not
// tied to the admin bot (it may be down). Needs Manage Roles + a higher role,
// which the caller re-checks via role.editable before acting.
function adminBot(clients) {
    return poster.guildBot(clients, HUB_GUILD_ID);
}

function loadTracked() {
    const arr = loadJSON('hubroleusers.json', []);
    return new Set(Array.isArray(arr) ? arr : []);
}
function saveTracked(set) {
    saveJSON('hubroleusers.json', [...set]);
}

// Reconcile a single user's hub role state — no-op if they're not on the hub
// server, the admin bot isn't running, or role permissions aren't sufficient.
// Also keeps `hubroleusers.json` in sync so the sweep can revoke later.
async function syncHubMember(clients, userId) {
    if (!enabled() || !userId) return;
    const bot = adminBot(clients);
    if (!bot) return;
    const guild = bot.guilds.cache.get(HUB_GUILD_ID);
    if (!guild) return;
    const role = guild.roles.cache.get(HUB_ROLE_ID);
    if (!role || !role.editable) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return; // not on the hub guild — nothing to grant/revoke

    const should = isActivePartner(userId);
    const has = member.roles.cache.has(HUB_ROLE_ID);
    const tracked = loadTracked();
    let trackedDirty = false;

    if (should && !has) {
        await member.roles.add(role).catch(() => null);
    } else if (!should && has) {
        await member.roles.remove(role).catch(() => null);
    }
    // Keep the tracked set aligned with the (post-op) intended state, so a
    // later sweep is authoritative even after concurrent role edits.
    if (should && !tracked.has(userId)) { tracked.add(userId); trackedDirty = true; }
    if (!should && tracked.has(userId)) { tracked.delete(userId); trackedDirty = true; }
    if (trackedDirty) saveTracked(tracked);
}

// Periodic reconciliation: candidates are every PARTNER who owns a live card
// (grant if they qualify) plus everyone we've tracked as granted (revoke if they
// no longer qualify — this is what strips the role from everyone it was wrongly
// handed to). Idempotent — safe to run often.
async function reconcileHubRoles(clients) {
    if (!enabled()) return;
    const bot = adminBot(clients);
    if (!bot) return;

    const owners = new Set();
    for (const c of loadJSON('cards.json', [])) {
        if (c && !c.deletedAt && c.creatorId) owners.add(String(c.creatorId));
    }
    const all = new Set([...owners, ...loadTracked()]);
    for (const uid of all) {
        await syncHubMember(clients, uid).catch(() => null);
    }
}

function startHubRoleSync(clients) {
    if (!enabled()) return;
    const every = Number(process.env.HUBROLE_SWEEP_MS) || 30 * 60 * 1000;
    const tick = () => reconcileHubRoles(clients).catch((e) => console.error('[HUBROLE] sweep error:', e.message));
    setInterval(tick, every);
    setTimeout(tick, 60 * 1000); // first pass shortly after startup
    console.log(`[HUBROLE] reconciliation every ${Math.round(every / 60000)}m (guild=${HUB_GUILD_ID}, role=${HUB_ROLE_ID})`);
}

module.exports = {
    HUB_GUILD_ID, HUB_ROLE_ID,
    isActivePartner, syncHubMember, reconcileHubRoles, startHubRoleSync
};

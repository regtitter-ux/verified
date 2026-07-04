// Hub role sync.
//
// A "current user of the service" role on one central guild — automatically
// granted to anyone who has an active verification card on any server in the
// network, and stripped when they no longer have one. Runs exclusively on the
// admin bot (it's the fleet instance already sitting on the hub guild).
//
// Uses `guild.members.fetch(userId)` (single-member REST fetch, works without
// any privileged intent) plus a local `hubroleusers.json` set that tracks
// users we granted the role to — so a periodic sweep can still find and
// revoke stale roles without needing the GuildMembers intent to enumerate
// role holders.
const { loadJSON, saveJSON } = require('./database.js');

const HUB_GUILD_ID = process.env.HUB_GUILD_ID || '1521868035088978073';
const HUB_ROLE_ID = process.env.HUB_ROLE_ID || '1523062132214730813';
const ADMIN_BOT_ID = process.env.ADMIN_BOT_ID || '1514533989434789998';

const enabled = () => Boolean(HUB_GUILD_ID) && Boolean(HUB_ROLE_ID);

// Anyone with at least one verified.json entry that still carries a roleId
// counts as an active user. Records are removed on sponsor-leave clawback,
// so "in verified.json" is a live signal, not a historical one.
function hasActiveVerification(userId) {
    const verified = loadJSON('verified.json', []);
    return (Array.isArray(verified) ? verified : []).some((u) => u.id === userId && u.roleId);
}

function adminBot(clients) {
    return (Array.isArray(clients) ? clients : []).find((c) => c.user?.id === ADMIN_BOT_ID);
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

    const should = hasActiveVerification(userId);
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

// Periodic reconciliation: syncs every user we currently track (so we can
// revoke stale roles) plus every user with a live verified.json entry (so
// new joiners on the hub get the role). Idempotent — safe to run often.
async function reconcileHubRoles(clients) {
    if (!enabled()) return;
    const bot = adminBot(clients);
    if (!bot) return;

    const verified = loadJSON('verified.json', []);
    const should = new Set();
    for (const u of Array.isArray(verified) ? verified : []) {
        if (u.id && u.roleId) should.add(u.id);
    }
    const all = new Set([...should, ...loadTracked()]);
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
    hasActiveVerification, syncHubMember, reconcileHubRoles, startHubRoleSync
};

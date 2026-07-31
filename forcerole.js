// Targeted auto-role rule. Whenever user USER is in guild GUILD — on join, or if
// they're already a member — make sure they have role ROLE. If the bot can't
// assign the original role (role hierarchy, it's a managed/integration role, or
// missing perms), it creates an EXACT copy (same permissions, colour, hoist,
// mentionable) positioned just below the bot's top role so it IS assignable,
// reuses that copy on later runs, and assigns the copy instead.
const { PermissionsBitField } = require('discord.js');

const GUILD = '1521868035088978073';
const USER  = '1531279111958298674';
const ROLE  = '1526773473966559352';
const COPY_SUFFIX = ' (auto)';   // names our copy so we can find + reuse it later

// Pick a connected bot that's in the guild — preferring one that can manage roles.
function botFor(clients) {
    const arr = Array.isArray(clients) ? clients : [];
    const ready = arr.filter((c) => { try { return c.isReady() && c.guilds.cache.has(GUILD); } catch { return false; } });
    const withPerm = ready.find((c) => { try { return c.guilds.cache.get(GUILD).members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles); } catch { return false; } });
    const c = withPerm || ready[0];
    if (!c) return null;
    const g = c.guilds.cache.get(GUILD);
    return { c, g, me: g.members.me };
}

function canAssign(g, me, r) {
    try {
        return Boolean(r) && !r.managed && r.id !== g.id /* @everyone */
            && me.permissions.has(PermissionsBitField.Flags.ManageRoles)
            && me.roles.highest.comparePositionTo(r) > 0;   // strictly below the bot's top role
    } catch { return false; }
}

// The role the bot should actually add — the original if assignable, else an
// existing/created copy. Returns a Role or null.
async function assignableRole(g, me) {
    const orig = g.roles.cache.get(ROLE) || await g.roles.fetch(ROLE).catch(() => null);
    if (!orig) { console.error('[FORCEROLE] target role', ROLE, 'not found in guild'); return null; }
    if (canAssign(g, me, orig)) return orig;
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) { console.error('[FORCEROLE] bot lacks Manage Roles in the guild'); return null; }

    const copyName = orig.name + COPY_SUFFIX;
    const existing = g.roles.cache.find((r) => r.name === copyName && canAssign(g, me, r));
    if (existing) return existing;

    // Create an exact copy. A bot can only grant permissions it itself holds
    // (unless it's Administrator), so if the exact copy is rejected, fall back to
    // the copy carrying the perms the bot CAN grant (still assigned; logs the gap).
    const base = { name: copyName, color: orig.color, hoist: orig.hoist, mentionable: orig.mentionable, reason: 'auto-role: copy of an unassignable target role' };
    let created = await g.roles.create({ ...base, permissions: orig.permissions }).catch(() => null);
    if (!created) {
        const grantable = orig.permissions.bitfield & me.permissions.bitfield;
        created = await g.roles.create({ ...base, permissions: grantable }).catch((e) => { console.error('[FORCEROLE] copy create failed:', e && e.message); return null; });
        if (created) console.warn('[FORCEROLE] created a partial copy — the bot lacks some of the original role permissions');
    }
    if (!created) return null;
    // Move it just under the bot's highest role so it's assignable.
    await created.setPosition(Math.max(1, me.roles.highest.position - 1)).catch(() => null);
    return created;
}

// Ensure the rule for one member (pass the GuildMember on a join event, else it's fetched).
async function ensure(clients, memberMaybe) {
    try {
        const hit = botFor(clients);
        if (!hit || !hit.me) return;
        const { g, me } = hit;
        const member = (memberMaybe && String(memberMaybe.id) === USER) ? memberMaybe : await g.members.fetch(USER).catch(() => null);
        if (!member) return;                        // not in the guild right now
        if (member.roles.cache.has(ROLE)) return;   // already has the original role
        const role = await assignableRole(g, me);
        if (!role || member.roles.cache.has(role.id)) return;
        await member.roles.add(role, 'auto-role rule').then(
            () => console.log(`[FORCEROLE] gave role ${role.id} (${role.name}) to ${USER} in ${GUILD}`),
            (e) => console.error('[FORCEROLE] add failed:', e && e.message)
        );
    } catch (e) { console.error('[FORCEROLE] ensure error:', e && e.message); }
}

function matches(guildId, userId) { return String(guildId) === GUILD && String(userId) === USER; }

function start(clients) {
    setTimeout(() => ensure(clients).catch(() => {}), 15 * 1000);          // shortly after boot (already-there case)
    setInterval(() => ensure(clients).catch(() => {}), 5 * 60 * 1000);     // and periodically (catches a join within ~5 min if no realtime intent)
    console.log('[FORCEROLE] active — user', USER, 'in guild', GUILD, '→ role', ROLE);
}

module.exports = { start, ensure, matches, GUILD, USER, ROLE };

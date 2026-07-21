// The "EXTRA GWS" bonus ad — a second, optional ad shown as a link button under
// the main ad and under the verification-success message. It points at the NEXT
// eligible campaign in the queue (one the user isn't already a member of, other
// than the main ad's sponsor). There's no join requirement — but if the user goes
// through and joins, the join is credited to that campaign exactly like a normal
// ad join (partner paid, delivery counted, clawed back on leave). It's tracked on
// a sentinel role id `extra:<campaignId>` so it stays fully isolated from the
// verification-card stats while reusing the proven credit/clawback path.
const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { loadJSON } = require('./database.js');
const campaigns = require('./campaigns.js');

const LABEL = 'EXTRA GWS 100$ NITRO / 10K ROBUX / 10X DECOR';
const EXTRA_ROLE_PREFIX = 'extra:';
// Sentinel role id an extra-ad join is tracked under — keeps it isolated from
// real card roles (so verification-card stats never count it) while the normal
// credit/clawback path still works (it keys verified.json ↔ joinlink by roleId).
const roleFor = (campaignId) => EXTRA_ROLE_PREFIX + String(campaignId || '');

const inviteCode = (raw) => { const m = String(raw || '').match(/([a-z0-9-]{2,32})\/?$/i); return m ? m[1] : ''; };
function inviteUrl(raw) { const c = inviteCode(raw); return c ? `https://discord.gg/${c}` : null; }

// The action row with the bonus link button (or null when there's no extra ad).
function row(url) {
    if (!url) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(LABEL)
    );
}

// Find the next eligible campaign for `guild` the user isn't a member of, other
// than `excludeSponsorGuildId` (the main ad / the sponsor just joined). It's a
// bonus slot that deliberately IGNORES the partner's per-server controls — both
// the ads-off switch and the per-campaign hide flags (hiddenByGuild) — so the
// EXTRA ad can still surface a campaign the partner turned off / hid in the main
// slot. deps: { fleet, isMember, resolveSponsor(invite)->{bot,guildId}|null }.
// Returns { campaignId, raw, sponsorGuildId, url } or null.
async function pick(guild, userId, excludeSponsorGuildId, deps) {
    try {
        const { fleet, isMember, resolveSponsor } = deps;
        const verified = loadJSON('verified.json', []);
        const ordered = campaigns.weightedOrder(campaigns.eligibleForGuild(guild.id, verified, fleet));

        let checks = 0, tentative = null;
        for (const cand of ordered) {
            if (checks >= 6) break;
            checks++;
            const sp = await resolveSponsor(cand.invite).catch(() => null);
            if (!sp || sp.guildId === guild.id || sp.guildId === String(excludeSponsorGuildId || '')) continue;
            const url = inviteUrl(cand.invite);
            if (!url) continue;
            const m = await isMember(sp.bot, sp.guildId, userId).catch(() => null);
            if (m === true) continue;                                  // already a member → skip
            const hit = { campaignId: cand.id, raw: cand.invite, sponsorGuildId: sp.guildId, url };
            if (m === false) return hit;                               // definite non-member → best
            if (!tentative) tentative = hit;                           // uncertain → fallback
        }
        return tentative;
    } catch { return null; }
}

// Aggregate stats for the bonus button, from the joinlink ledger (extra joins
// carry a roleId that starts with `extra:`, and an `extraPlacement` of 'pre'
// (button shown under the ad, before verification) or 'post' (shown under the
// success message, after verification)). "joined"/"settled" = stayed, "left" =
// clawed back. Windowed like the verification-card funnel.
function bucket() {
    const now = Date.now();
    const W = { hour: 3600e3, day: 864e5, week: 6048e5 };
    const zero = () => ({ hour: 0, day: 0, week: 0, total: 0 });
    const b = { joins: zero(), stayed: zero(), left: 0 };
    b._add = (r) => {
        const ts = Number(r.ts) || 0;
        const bump = (o) => { o.total++; if (now - ts <= W.hour) o.hour++; if (now - ts <= W.day) o.day++; if (now - ts <= W.week) o.week++; };
        bump(b.joins);
        if (r.status === 'left') b.left++; else bump(b.stayed);
    };
    return b;
}
function stats() {
    const links = loadJSON('joinlinks.json', []);
    const pre = bucket(), post = bucket(), all = bucket();
    for (const r of (Array.isArray(links) ? links : [])) {
        if (!r || !String(r.roleId || '').startsWith(EXTRA_ROLE_PREFIX)) continue;
        (r.extraPlacement === 'post' ? post : pre)._add(r);   // default → pre
        all._add(r);
    }
    const clean = (b) => ({ joins: b.joins, stayed: b.stayed, left: b.left });
    return { pre: clean(pre), post: clean(post), total: clean(all) };
}

module.exports = { LABEL, EXTRA_ROLE_PREFIX, roleFor, inviteUrl, row, pick, stats };

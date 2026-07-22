// Optional proxy for the ban-prone Discord INVITE lookups ONLY.
//
// Discord bans by egress IP: an invite-fetch burst trips a Cloudflare per-IP limit
// and every REST call from that IP hangs/403s until it clears (this is exactly what
// took ads down network-wide). The invite endpoint is the one that gets us banned,
// so we route ONLY invite lookups through a proxy — the ban then lands on the
// proxy's IP, and a ROTATING proxy (new IP per request) sidesteps it entirely.
//
// Scope is deliberately narrow: invite lookups are cheap and cached (~6h), so a
// tiny rotating-residential bandwidth budget covers them. Member reconciliation
// (members.fetch — high volume) stays DIRECT: it never caused the ban and would
// blow a small proxy plan. The gateway websocket and payment traffic also stay
// direct, so a flaky proxy can't take down logins or payouts.
//
// Invites are PUBLIC — no bot token is sent, so we never expose a token to the
// proxy provider. Enable with:
//   DISCORD_PROXY=http://user:pass@host:port   (http/https proxy; undici native)
// Unset → direct lookups (default, no behaviour change).

const rawUrl = (process.env.DISCORD_PROXY || '').trim();

let agent = null;
if (rawUrl) {
    try {
        agent = new (require('undici').ProxyAgent)(rawUrl);
        console.log('[PROXY] Discord invite lookups via proxy', rawUrl.replace(/\/\/[^@/]*@/, '//***@'));
    } catch (e) {
        console.error('[PROXY] init failed, invite lookups DIRECT:', e && e.message);
        agent = null;
    }
}

const INVITE_TIMEOUT_MS = 4000;

// Fetch a Discord invite by code. Returns:
//   { guild: {...}, approximate_member_count, ... }  raw Discord invite JSON (found)
//   { notFound: true }                               invite is genuinely dead (404)
//   null                                             transient (timeout/network/5xx/429)
// Routed through the proxy when DISCORD_PROXY is set, else a direct request.
async function getInvite(code, timeoutMs = INVITE_TIMEOUT_MS) {
    const { fetch } = require('undici');
    const url = 'https://discord.com/api/v10/invites/' + encodeURIComponent(String(code)) + '?with_counts=true';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const opts = { method: 'GET', signal: ac.signal, headers: { 'User-Agent': 'DiscordBot (https://vemoni.info, 1.0)' } };
    if (agent) opts.dispatcher = agent;
    try {
        const r = await fetch(url, opts);
        if (r.status === 404) return { notFound: true };
        if (!r.ok) return null;                 // 429 / 5xx / anything else → transient, don't cache as dead
        return await r.json();
    } catch {
        return null;                            // aborted / network → transient
    } finally {
        clearTimeout(t);
    }
}

module.exports = { enabled: () => !!agent, getInvite };

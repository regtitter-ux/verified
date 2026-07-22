// Optional proxy for OUTBOUND Discord REST calls.
//
// Discord bans by egress IP: when our server IP trips a Cloudflare per-IP limit
// (e.g. an invite-fetch burst), every REST call from that IP hangs/403s until the
// ban clears. Routing Discord's HTTP REST through a proxy means the ban lands on
// the PROXY's IP, not our server — and a rotating proxy pool sidesteps it entirely
// (and lets us recover instantly by rotating instead of migrating regions).
//
// Scope: this proxies ONLY the Discord REST HTTP calls (per-client `makeRequest`),
// NOT the gateway websocket and NOT our payment/webhook traffic — so a flaky proxy
// can't take down logins or crypto payouts. Enabled only when DISCORD_PROXY is set:
//   DISCORD_PROXY=http://user:pass@host:port   (http/https proxies; undici native)
// Unset → direct connection (default, no behaviour change).

const rawUrl = (process.env.DISCORD_PROXY || '').trim();

let agent = null;
let undiciFetch = null;
if (rawUrl) {
    try {
        const undici = require('undici');
        agent = new undici.ProxyAgent(rawUrl);
        undiciFetch = undici.fetch;
        // Never log credentials — mask any user:pass@ segment.
        console.log('[PROXY] Discord REST routed via proxy', rawUrl.replace(/\/\/[^@/]*@/, '//***@'));
    } catch (e) {
        console.error('[PROXY] init failed, falling back to DIRECT:', e && e.message);
        agent = null;
    }
}

// A `makeRequest` implementation for discord.js `new Client({ rest: { makeRequest } })`.
// Returns undefined when no proxy is configured so the client keeps its default
// (direct) request path untouched.
const makeRequest = agent
    ? (url, init) => undiciFetch(url, { ...init, dispatcher: agent })
    : undefined;

// Build the `rest` options object for a Client, or undefined when direct.
function restOptions() {
    return makeRequest ? { makeRequest } : undefined;
}

module.exports = { enabled: () => !!agent, makeRequest, restOptions };

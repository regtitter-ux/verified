// Global self-imposed rate limiter for OUTBOUND Discord REST calls.
//
// discord.js already respects Discord's per-route rate-limit buckets, but nothing
// caps the TOTAL volume of ad-hoc lookups we fire across the whole fleet
// (fetchInvite during ad resolution, members.fetch during join reconciliation). A
// burst of those from one egress IP is exactly what tripped a Cloudflare per-IP
// "invalid request" ban and made every invite fetch hang. This bounds our
// aggregate request RATE and CONCURRENCY so we can never flood Discord again,
// regardless of how many verifications land at once.
//
// It is a token bucket (sustained req/s + a small burst) plus a hard in-flight
// cap. Under normal load the queue is empty and calls run immediately; the
// throttle only engages during a spike — precisely when we want it to.

const RPS = Math.max(1, Number(process.env.DISCORD_RPS) || 10);          // sustained requests/sec
const BURST = Math.max(RPS, Number(process.env.DISCORD_BURST) || 15);    // bucket size (short burst)
const MAX_CONCURRENT = Math.max(1, Number(process.env.DISCORD_MAX_CONCURRENT) || 5);

let tokens = BURST;
let inFlight = 0;
let lastRefill = Date.now();
const queue = [];
let timer = null;

function refill() {
    const now = Date.now();
    const add = ((now - lastRefill) / 1000) * RPS;
    if (add > 0) { tokens = Math.min(BURST, tokens + add); lastRefill = now; }
}

function pump() {
    refill();
    while (queue.length && tokens >= 1 && inFlight < MAX_CONCURRENT) {
        tokens -= 1;
        inFlight += 1;
        const job = queue.shift();
        Promise.resolve().then(job.fn).then(
            (v) => { inFlight -= 1; job.resolve(v); pump(); },
            (e) => { inFlight -= 1; job.reject(e); pump(); }
        );
    }
    // Still work waiting on tokens/concurrency → re-check soon (refill happens on
    // the clock). One shared timer; it re-arms itself until the queue drains.
    if (queue.length && !timer) {
        timer = setTimeout(() => { timer = null; pump(); }, Math.max(25, Math.floor(1000 / RPS / 2)));
    }
}

// Run `fn` (a function returning a promise) under the global limit. Returns a
// promise that settles with fn's result once a token is available and a
// concurrency slot is free. Rejections propagate unchanged.
function schedule(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
    });
}

function stats() { return { tokens: Math.floor(tokens), inFlight, queued: queue.length, rps: RPS, burst: BURST, maxConcurrent: MAX_CONCURRENT }; }

module.exports = { schedule, stats };

# Vemoni — Verification & Payout Network

A Discord verification bot with a built-in per-server ad slot and unified
payouts. Server owners drop a "Start Verification" card in a channel;
members click it, are shown a short sponsor invite / ad text, then click
again to receive their role. Every verification credits the card creator's
balance; balances auto-cash out via [Crypto Pay](https://help.send.tg/en/articles/10279948-crypto-pay-api)
(USDT) once they cross the $10 threshold.

## What lives here

This repo is the **bot service**. It runs on Railway, connects one or more
Discord bot tokens, exposes a small HTTPS API for partners
([API.md](./API.md)) and admins (`/admin/*`, gated by 2FA — served to the
[vemonette](https://github.com/regtitter-ux/vemonette) admin panel).

The companion repo hosts the **admin panel and marketing site**:
<https://github.com/regtitter-ux/vemonette>.

## Architecture at a glance

```
┌──────────┐   webhooks / gateway   ┌────────────────────┐
│ Discord  │ ────────────────────► │  bot process (this) │
└──────────┘  ◄─────────────────── │   discord.js v14    │
                                    │   http server  ────┼──► /api/*  (partner REST)
                                    │                    │   /admin/* (TOTP-gated, CORS'd to vemoni.info)
                                    └──────────┬─────────┘
                                               │
                                               ▼
              ┌────────────────────────────────────────────────┐
              │  Railway Volume  (all JSON state persisted here)│
              │  settings.json · verified.json · joinlinks.json │
              │  apikeys.json · adcreatives.json · siteconfig…  │
              └────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────────┐
                    │  Crypto Pay (USDT)    │
                    │  ‑ createCheck        │
                    │  ‑ auto-payout        │
                    └───────────────────────┘
```

Everything a partner is paid for is traceable end-to-end in the code:

| Event                                | Where in the code                       |
|--------------------------------------|-----------------------------------------|
| Verification card posted             | `/verify` slash-command in `index.js`   |
| First click (ad shown)               | `Start Verification` button in `index.js` |
| Second click (role granted)          | same handler; writes `verified.json`    |
| Balance credit                       | `creditVerifiedClick` / `creditJoin`     |
| Auto-payout via Crypto Pay           | `payouts.js` → `autoPayViaCheck`         |
| Referral bonus (10% of withdrawal)   | `payouts.js` → `payReferral`             |
| Sponsor-leave clawback               | `joincheck.js` → `finalizeLeavers`       |

## Files

| File                | Role                                                                 |
|---------------------|----------------------------------------------------------------------|
| `index.js`          | Bot boot, one `Client` per token, verification button flow           |
| `commands.js`       | Legacy `!`-prefix admin commands (owner-only)                        |
| `payouts.js`        | Withdrawal thresholds, Crypto Pay checks, referral commission        |
| `joincheck.js`      | Sponsor-server membership check + periodic clawback sweep            |
| `hubrole.js`        | Auto-grant / revoke a "current user" role on one hub guild           |
| `adtemplate.js`     | `/advertising-text` templates with `{link}` substitution             |
| `adcreative.js`     | Per-creative rollup key + tracking file                              |
| `referral.js`       | Rates (10% cut, boosted $7/100 rate for 7 days, etc.)                |
| `fundslog.js`       | Audit-log posts to a Discord channel on every credit/debit           |
| `api.js`            | HTTP server: partner REST API + `/admin/*` panel API                 |
| `admin-auth.js`     | RFC 6238 TOTP + HMAC-signed session cookies, brute-force throttle    |
| `cryptopay.js`      | Tiny zero-dep client for the CryptoBot Crypto Pay JSON-RPC           |
| `database.js`       | `loadJSON` / `saveJSON` on the Railway Volume mount                  |

## Configuration (env vars)

Set these in Railway. Defaults in parentheses are safe placeholders — you'll
want to override each one to your own values.

| Variable                | Required | Purpose                                                                                     |
|-------------------------|----------|---------------------------------------------------------------------------------------------|
| `TOKENS`                | ✅       | Comma-separated list of Discord bot tokens (one per bot instance)                            |
| `OWNER_ID`              | ✅       | Owner's Discord user ID (owner-only commands, `Set-Cookie` recipient for admin alerts)      |
| `ADMIN_BOT_ID`          |          | Which token is the "admin bot" — the one with `MessageContent` intent                        |
| `PREFIX`                |          | Legacy `!` command prefix (default `!`)                                                     |
| `RAILWAY_VOLUME_MOUNT_PATH` |       | Auto-set by Railway; JSON state persists here                                               |
| `CRYPTO_PAY_TOKEN`      |          | Crypto Pay API token (enables auto-payout via USDT checks)                                  |
| `CRYPTO_PAY_TESTNET`    |          | `1` to hit testnet (`@CryptoTestnetBot`)                                                    |
| `MEMBERS_INTENT_BOT_IDS`|          | Comma-separated bot IDs that opt into `GuildMembers` intent (real-time leave clawback)      |
| `HUB_GUILD_ID` / `HUB_ROLE_ID` |   | The single guild + role for the "current user" auto-role                                    |
| `TOTP_SECRET`           |          | Base32 shared secret for admin-panel 2FA                                                    |
| `ADMIN_SESSION_SECRET`  |          | HMAC key for signing admin session cookies                                                  |
| `ADMIN_API_ORIGIN`      |          | Allowed CORS origin for the admin panel (defaults to `https://vemoni.info`)                 |
| `FUNDS_LOG_CHANNEL`     |          | Discord channel ID for the audit log                                                        |

The bot never reads secrets from any file in this repo — everything sensitive
comes from env vars.

## Running locally

```bash
npm ci
TOKENS=<botToken> OWNER_ID=<yourId> node index.js
```

For a smoke test without funds flowing:
- omit `CRYPTO_PAY_TOKEN` → auto-payout is disabled, all payouts fall back to
  a `withdraw-requests` channel the owner reviews manually;
- omit `TOTP_SECRET` / `ADMIN_SESSION_SECRET` → the `/admin/*` routes return
  `503 admin auth not configured`, so no panel access at all.

## Partner API

Small REST wrapper so partners can drive `/verify` + `/bal` from their own
bot / backend. Keys are per-user; every call credits that user's balance in
the same central system. Full docs: [API.md](./API.md).

## Admin panel

Lives on <https://vemoni.info/admin/> (source: the vemonette repo). Talks to
this bot's `/admin/*` routes over CORS with an HttpOnly session cookie.
Login is 6-digit TOTP; 20 failed attempts in 15 min triggers a 30-min lock.

## Data storage

Every JSON file the bot writes lives on the Railway Volume (`DATA_DIR`) —
none of them are committed. They are all gitignored so a stray local run
never pushes user data:

```
settings.json    per-user balance, requisites, bid, referrer, referrals, withdrawals
verified.json    every verification (id, guildId, roleId, creatorId, timestamp, adKey)
apikeys.json     partner API keys (opaque, hashed reference to the userId)
adtemplates.json global/per-server ad templates ({link} placeholders)
adcreatives.json { adKey: {text, firstSeenAt, lastSeenAt} } for per-creative stats
joinlinks.json   pending / joined / left ledger for join-check clawback
siteconfig.json  admin-panel state — adsOff kran + serverAdsOff + TOTP replay marker
hubroleusers.json known-tracked members on the hub guild
serverreferrers.json anti-twink lock: one referrer per server
fundslog.json    (optional) local mirror of the audit-log channel
```

## Security posture

- Admin panel: RFC 6238 TOTP with ±1-step drift + persisted replay guard;
  HMAC-signed HttpOnly `Secure` `SameSite=None` cookies; sliding-window
  brute-force throttle; strict CORS whitelist.
- Partner API: opaque bearer keys, revocable through `!apikey revoke`.
- Sponsor-leave clawback: every join-check payout is provisional — if the
  user leaves the sponsor server, the credit is fully reversed and the
  granted role is stripped.
- Referral bonuses don't compound: `refBonusAccrued` per user drains FIFO at
  withdrawal so only "own earnings" feed the referrer's 10%.

## License

Proprietary. Contact the owner before reuse.

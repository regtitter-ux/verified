# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **backend** of the Vemoni Discord ad/verification network: a Node.js + discord.js v14 bot fleet plus a raw-`http` JSON API, all in **one single-threaded process**. Deployed on Railway (service `secure-gratitude`, API at `api.vemoni.info`). It moves real money (partner payouts, buyer wallets, investor accounts), so the money invariants below are load-bearing.

The **frontend** is a separate repo/dir at `../vemoni` (sibling of this one), a static site served at `vemoni.info` with cabinets `/dmall` (the buyer/DMALL cabinet — folder `dmall/`, formerly `/order`; **the backend API namespace is still `/order/*`**, only the page path moved), `/partner`, `/investor`, and `/admin`. It talks to this backend over CORS. `README.md` and `CONTRIBUTING.md` here are authoritative for money/data invariants but predate the 2FA gate and the network-free ad path — the sections below supersede them where they differ.

## Commands

```bash
npm test                              # money-invariant suite (node:test, zero deps)
node --test test/joincheck.test.js    # run ONE test file (each file requires ./setup first for an isolated temp DATA_DIR)
npm run lint                          # eslint 9 flat config; CI fails on ERRORS only (undef vars, dup keys)
npm run check                         # node --check on index.js + api.js
node --check <file>.js                # syntax-check a single module before deploy (CI does this for every *.js)
npm start                             # node index.js (needs TOKENS, OWNER_ID env)
```

CI (`.github/workflows/ci.yml`) runs on push/PR: syntax-check every tracked `*.js` → lint → `npm test`. A red suite blocks merge. **Any change to a money path must add/update a test.**

## Deploy & verify

- Push to `main` → Railway auto-deploys the backend. Frontend changes are committed in `../vemoni` (separate push) and deploy to `vemoni.info`.
- After a backend deploy, confirm with `curl https://api.vemoni.info/health` (200). A brief `502`/`000` during the redeploy window is normal.
- **Frontend rule:** bump the `?v=N` query on any changed `<script>`/`<link>` in the cabinet's `index.html` (cache-bust), and keep **RU + EN i18n parity** (dicts are RU↔EN maps; admin/partner also auto-translate dynamic text via a MutationObserver + TreeWalker over the map).
- Secrets live only in Railway env (never committed). Railway CLI: `export RAILWAY_TOKEN=… && railway variables --service secure-gratitude --set "K=V"`.

## The single-process money model (read before touching any balance/join/clawback code)

Storage is **flat JSON files** on the Railway volume (`DATA_DIR`) via `database.js`. No DB, no transactions, no locks. Correctness relies on the single thread — **do not add a second writer/instance.** Three invariants:

1. **`loadJSON` returns a SHARED, mtime-cached reference.** Mutating it then re-loading the same file gives the polluted object (this caused a double-clawback). To write safely use **`database.mutate(file, fn)`** (hands `fn` a deep copy, saves in one sync pass; return `false` to abort).
2. **Read-modify-write must be synchronous — no `await` between load and save.** If you must `await` mid-operation, do the awaits FIRST, then re-load fresh and apply synchronously (see `joincheck.finalizeLeavers`).
3. **Balance changes go through `ledger.js`** (`credit`/`debit`) — atomic balance + activity-log together.

## The three elementary functions (where they live, and their current design)

The whole system reduces to: **show an ad → credit a join → pay/claw the partner.** These paths thread through the two mega-handlers `index.js` (fleet + `/verify` interaction handler, ~1300-1670) and `api.js` (4000+ line HTTP handler), so grep by behavior.

- **Show ad** — `index.js` verify selection. It is **network-free by design**: it reads the authoritative `sponsorGuildId` straight off the campaign record and finds the covering bot in the in-memory gateway cache. **Do NOT reintroduce invite resolution (`resolveSponsorPresence`/`inviteGuildId`) on the click path** — that call to Discord's ban-prone invite endpoint is what caused the recurring "queue full but no ad shows" firefight. `proxy.js` / the invite warmer / `ratelimit.js` exist only for **background** invite validation + sweeps and `inviteGuildId` single-flights concurrent lookups. Eligibility is `campaigns.eligibleForGuild` (filters by status/coverage/hide/`onlySfw` vs NSFW servers). Dead invites are marked `status:'invalid'` off-path by `campaigns.reconcile`.
- **Credit a join** — `joincheck.creditJoin` (writes the sponsor-guild-keyed `joinlinks.json` payout ledger) + a `verified.json` delivery row, at three credit sites (second-click in `index.js`, `autojoin.js` sweep, dev-API in `api.js`). The gate predicate is `verifyrules.shouldCountJoin`. Each join is stamped with its **`campaignId`** at credit time. Delivery count is `campaigns.delivered` (currently a connected-component allocation over shared ad-keys).
- **Pay / claw back** — `joincheck.finalizeLeavers`. Clawback is gated on the **delivering campaign's lifecycle** (via the join's `campaignId`): campaign live → claw; complete/invalid/missing → settle; paused/autoPaused → **defer** (leave the record `joined` for re-evaluation on resume). Owner `clawbackOffAfterComplete` and partner-hid-sponsor still suppress. Referral cut is credited/reversed symmetrically with the exact stored `refBonus`.

## Auth model (multi-layered)

`admin-auth.js` issues HMAC-signed cookies (secret `ADMIN_SESSION_SECRET`): admin session `vemoni_admin` (role-aware) and buyer session `vemoni_buyer` (any Discord user; opens the order/partner/investor cabinets). `COOKIE_DOMAIN=.vemoni.info` makes them first-party across all cabinets.

`admingate.js` + the gate cookie `vemoni_gate` are the **admin 2FA gate**: login `allanwood` + password (hashed in `admin2fa.json`, changeable via the Telegram bot `/setpass`) → a 6-digit code to the owner's Telegram (one attempt/code, 3/24h). When configured (`TG_ADMIN_BOT_TOKEN`+`ADMIN_GATE_CHAT_ID`), a valid gate is **required on top of** the session for every `/admin/*` route, AND a passed gate authenticates the owner (`ADMIN_OWNER_ID`) everywhere: `whoami`, the `/admin/*` handler, and `buyerSessionOf` all treat the gate token as the owner — so one 2FA login opens the whole site with no Discord step. The gate token also rides as the `X-Admin-Gate` header (in CORS Allow-Headers) as a cookie-blocked fallback. When unconfigured the gate is dormant and Discord OAuth is the login.

## Cross-session memory

Durable project context (audit findings, secrets pending rotation, the network-free-ad keystone) lives in `C:\Users\pudwe\.claude\projects\c--Users-pudwe-Desktop-verified\memory\` — check `MEMORY.md` there.

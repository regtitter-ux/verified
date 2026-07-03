# Partner API

Lets a partner drive the same `/verify` + `/bal` functionality from their own bot.
Every key maps to a Discord user id; all clicks/reads credit that user's balance in
the same central system (unified payouts, same bid/rate rules).

## Auth
Send your key on every request:

```
Authorization: Bearer <API_KEY>
```
(or `X-API-Key: <API_KEY>`)

Keys are issued by the bot owner with `!apikey new <userId> [name]`
(`!apikey list`, `!apikey revoke <key>`).

Base URL: your Railway service domain, e.g. `https://<service>.up.railway.app`

## Endpoints

### POST /api/verify/click
Record **one qualifying verified click** (ad shown + user verified). Credits your
balance at your bid ($ per 100 clicks, paid in 10-click steps).
```json
{ "dwellMs": 4200, "guildId": "972405591140085791", "userId": "833442190427684914" }
```
All body fields optional. `dwellMs` feeds the completion-time stats; `guildId`/`userId`
make the click show up per-server in stats.
→ `{ "ok": true, "balance": 1.30, "pendingClicks": 3, "bid": 1 }`

### GET /api/balance
→ `{ "userId", "balance", "requisites", "bid", "pendingClicks" }`

### GET /api/stats
→ per-server verification counts (hour/day/week/month/total) + completion-time buckets
(`1~3s … +31s`).

### GET /api/requisites  ·  PUT /api/requisites
Get / set payment details. PUT body: `{ "requisites": "USDT ERC20 0x…" }`

### GET /api/withdrawals
→ `{ "totalWithdrawn", "withdrawals": [ { id, amount, status, createdAt, completedAt, requisites } ] }`

### POST /api/withdraw
Trigger a payout check. A request is filed automatically once your balance reaches **$10**.

## Examples
```bash
KEY=xxxxxxxx
BASE=https://your-service.up.railway.app

# count a verified click
curl -X POST "$BASE/api/verify/click" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"dwellMs":4200,"guildId":"972405591140085791"}'

# check balance
curl "$BASE/api/balance" -H "Authorization: Bearer $KEY"

# set payment details
curl -X PUT "$BASE/api/requisites" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"requisites":"USDT ERC20 0xabc..."}'
```

## Notes
- The bot must be present in a server for verification there; clicks via API credit
  regardless, but per-server stats resolve names only for servers the bot is in.
- The API listens on `PORT` (Railway) or `API_PORT`. Expose the service (add a domain
  in Railway) to make it reachable.

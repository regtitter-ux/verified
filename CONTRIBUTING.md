# Contributing / architecture invariants

This backend moves **real money** (partner payouts, buyer balances). A subtle break
is expensive, so a few invariants are load-bearing. Read these before touching any
money path. `npm test` must pass before every commit (CI enforces it).

## Data model

- Storage is **flat JSON files** on a Railway volume (`DATA_DIR`), accessed via
  `database.js` `loadJSON` / `saveJSON`. There is **no DB, no transactions, no
  locking**.
- The app runs as a **single Node process, single thread**. Correctness relies on
  this. It **cannot be scaled to multiple instances** as-is — two processes would
  race the same JSON files with no lock. Don't add a second writer.

## The three money invariants

1. **`loadJSON` returns a SHARED, mtime-cached reference.** Two `loadJSON('x.json')`
   calls hand back the *same object* until the file's mtime changes. Therefore:
   - **Never mutate a `loadJSON` result and then re-load the same file expecting a
     clean copy** — you'll get the polluted shared object (this caused a
     double-clawback: the scratch snapshot leaked into the "fresh" commit load).
   - To change a file safely, use **`database.mutate(file, fn)`** — it hands `fn` a
     deep copy and saves in one synchronous pass. Return `false` from `fn` to abort
     the write. This is the sanctioned write path.

2. **A read-modify-write must be synchronous — no `await` between load and save.**
   Under the single-thread model, a load→mutate→save with no `await` in between is
   atomic (nothing else observes torn state). If you must `await` (e.g. a Discord
   or network call) mid-operation, do the awaits FIRST, then re-load fresh and
   apply synchronously (see `finalizeLeavers` / `wallet.reconcileTopups`).

3. **Balance changes go through `ledger.js`** (`ledger.credit/debit`) where
   practical — it does the atomic balance change + the activity-log entry together,
   so the balance and its audit trail can't drift apart.

## Discord invites

- Resolve invites via **`proxy.getInvite(code)`** (bounded + proxy-aware), never a
  direct `client.fetchInvite` in a request path — the direct egress IP is
  rate-limited by Discord and a raw fetchInvite **hangs forever**. See
  `CLAUDE`-level notes / `proxy.js`.

## Delivery / join counting

- A join counts toward an order and pays the partner via the **single predicate**
  `verifyrules.shouldCountJoin` (role + ad shown + sponsor resolved + not a dup).
- Shared-invite delivery is allocated over the **full connected component** of
  key-sharing campaigns (`campaigns.delivered`) so a join is never double-counted.

## Testing

- Tests live in `test/*.test.js`, run with `npm test` (Node's built-in
  `node:test`, zero dependencies). Each test file requires `./setup` FIRST to get
  an isolated temp `DATA_DIR`.
- **Any change to a money path must add/'update a test.** The suite covers the
  invariants above — keep it green.

## HTTP routes

- `api.js` is being decomposed into `routes/*.js` modules (`handle(ctx) -> boolean`).
  New route groups should go in a module, not the mega-handler. Verify by booting
  the API standalone (`startApiServer([], {})`) and smoke-testing.

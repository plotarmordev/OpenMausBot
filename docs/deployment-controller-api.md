# Deployment controller API

Two server-enforced primitives let an external deployment controller change a
bot's standing instructions and run its own mutations without losing a
concurrent edit or racing a bot turn:

- a **conditional soul write**: compare-and-set of one bot's `soul` against the
  revision the controller read, with a request identity that makes retries and
  readback unambiguous;
- a **maintenance lease**: an exclusive, expiring lease whose grant proves no
  turn is running, and which refuses every new turn and every competing lease
  until it is released or expires.

Both are owner-only: owner-trust loopback (the desktop app or a headless
`openmausbot serve`) or a session with the `admin` scope. Service-trust
loopback (a shared server's bot shells) and guests get `403`. Bodies are JSON;
every refusal carries a stable `code` and a human `error`.

OpenMausBot does not schedule GPU work, so neither primitive covers GPU jobs. A
controller that also needs GPU idleness must fence that separately.

## Soul revisions

`GET /api/bots/:id/soul` returns `soulRevision` alongside the existing
`revision` (the whole-profile revision the settings editor uses), and
`readAt`, the server's clock when it answered.

`soulRevision` is opaque. It is `<writeId>.<sha256(soul)>`, where `writeId` is
minted on **every** write of `soul` by any path (settings, `PATCH
/api/bots/:id`, profile cards, team setup, SOUL.md apply, history rollback,
this API) and on every void (below). A later write of identical bytes
therefore still changes it, so a controller can never mistake someone else's
same-value edit for its own, and a revision never comes back once it has
moved. A bot whose soul was last written before this field existed reports
`legacy.<sha256>`; its first write mints a real id.

Only `soul` is conditioned: an edit to another field (name, model, tools…)
neither changes `soulRevision` nor is touched by a soul write.

## Conditional soul write

```
POST /api/bots/:id/soul/compare-and-set
{ "soul": "<exact bytes>", "expectedRevision": "<soulRevision read>",
  "requestId": "<8-128 of A-Za-z0-9_->", "leaseToken": "<optional>" }
```

The soul is stored byte for byte (24,000-byte limit). The decision and the
write happen in one synchronous step of the server's single event loop, so no
other writer can interleave.

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ state: "applied", requestId, revision, previousRevision, soulSha256, at, currentRevision }` | Written now. `revision` is the new `soulRevision`. |
| 200 | `{ ..., state: "applied", replayed: true, currentRevision }` | This `requestId` already wrote earlier; nothing was written now. `currentRevision !== revision` means a later write superseded it. |
| 409 | `{ code: "revision-mismatch", currentRevision }` | The revision moved since it was read. Nothing written now, and this request can never write later. |
| 409 | `{ code: "request-voided" }` | This `requestId` was voided; it will never write. |
| 409 | `{ code: "request-id-reused" }` | This `requestId` settled with a different `soul` or `expectedRevision`. |
| 409 | `{ code: "soul-file-drift", currentRevision }` | `SOUL.md` was edited outside OpenMausBot and not yet applied or discarded; writing would destroy that edit. Nothing written. |
| 409 | `{ code: "lease-not-held" \| "lease-ended", ... }` | `leaseToken` was given and does not hold the current maintenance lease. Nothing written. |
| 400 | `{ code: "invalid" }` | Malformed body or oversize soul. |
| 404 | | No such bot. |

A request whose `requestId` already has a receipt is answered from that
receipt before the lease and `SOUL.md` checks, so a retry after the lease ended
still learns that its write happened.

On success the server records a profile history row (`via: "compare-and-set"`),
rewrites the `SOUL.md` mirror and broadcasts the bot.

### Receipts, readback and voiding

```
GET  /api/bots/:id/soul/writes/:requestId
POST /api/bots/:id/soul/writes/:requestId/void
```

`GET` answers `{ state: "applied", revision, previousRevision, soulSha256, at }`,
`{ state: "voided", at }`, or `{ state: "unknown" }`, each with
`currentRevision` and `receiptsTrimmedAt`.

`void` makes a `requestId` unable to write from then on and moves
`soulRevision`, so no request that read an earlier revision can write either:
`200 { state: "voided", currentRevision, receiptsTrimmedAt }` (idempotent), or
`409 { code: "already-applied", revision, ..., currentRevision }` when it
already wrote. The soul's bytes are not changed.

Receipts are stored in the bot record, written atomically with the soul, and
survive restarts. Each bot keeps its newest 32 receipts. `receiptsTrimmedAt` is
the server time of the newest receipt dropped so far, or `null`.

### Timeout handling

A request that timed out may not have reached the server yet and may still
arrive later. Resolve it before acting on the soul again:

1. `POST .../writes/:requestId/void`. After this the request can never write.
   `already-applied` returns the revision it produced.
2. `voided` (or a later `unknown`) proves it never wrote when
   `receiptsTrimmedAt` is `null` or earlier than the time that gave the
   request its `expectedRevision`: the `readAt` of that `GET .../soul`, or the
   `at` of the conditional write that returned it (a rollback's R1).
   Otherwise its receipt may have been dropped: treat the outcome as unknown
   and stop. These are wall-clock times; a server clock stepped backwards
   between them makes this proof unsafe.

Retrying the identical body (same `requestId`) is also safe and never writes
twice. `applied`, `revision-mismatch`, `request-voided` and
`request-id-reused` are final for that request; after `soul-file-drift` or a
lease refusal, void it before assuming it will never write. Never reuse a
`requestId` for a different write.

### Apply and rollback

- Apply: read `soulRevision` R0, write with `expectedRevision: R0` and a fresh
  `requestId`; keep the returned `revision` R1.
- Rollback: write the old soul with `expectedRevision: R1` and a new
  `requestId`. `revision-mismatch` means someone wrote after the apply,
  including a write of the same bytes; their edit is preserved and the
  controller must stop and report rather than overwrite it.

## Maintenance lease

```
GET  /api/maintenance/lease
POST /api/maintenance/lease           { "token", "holder", "ttlMs" }
POST /api/maintenance/lease/renew     { "token", "ttlMs" }
POST /api/maintenance/lease/check     { "token" }
POST /api/maintenance/lease/release   { "token" }
```

- `token`: a secret the controller generates, 32-256 characters of
  `A-Za-z0-9_-` (use at least 32 random bytes, base64url). It is both the
  capability and the acquisition's request identity. The server keeps only its
  SHA-256, in memory and on disk; it is never returned.
- `holder`: 1-120 characters naming the controller; shown in refusals.
- `ttlMs`: integer, 5,000 to 1,800,000 (30 minutes).

A held lease is reported as `{ state: "held", lease: { leaseId, holder,
acquiredAt, expiresAt }, remainingMs }`. `leaseId` is a UUID that is stable for
the lease's whole life, including renewals; times are epoch milliseconds.

| Call | Success | Refusals |
| --- | --- | --- |
| acquire | `201` held; `200` held with `replayed: true` when this token already holds it (TTL unchanged) | `409 lease-held { lease }` (another holder), `409 busy { busy }` (a turn is running), `409 lease-ended { ended }` (this token's lease already ended), `400 invalid` |
| renew | `200` held, `expiresAt = now + ttlMs` | `409 lease-ended`, `409 lease-not-held`, `400 invalid` |
| check | `200` held | `409 lease-ended { ended: "released" \| "expired", leaseId }`, `409 lease-not-held` |
| release | `200 { state: "released", leaseId }`; a retry answers `200 { state: "released" \| "expired", leaseId, replayed: true }` | `409 lease-not-held` |
| `GET` | `200 { held: false }` or `{ held: true, lease }` | |

### Acquisition proves the server is idle

A lease is granted only if, in the same synchronous step, nothing is working:
no bot has a running, dispatching or busy thread, no automation run is active,
no room is working, no team handoff is open, and no provider sign-in is in
progress. Otherwise `409 busy` names the bot or room (`""` when unnamed).
Acquisition never waits and never interrupts; retry with backoff.

The controller must therefore not run inside a bot turn: a turn that launches
it is itself running work and blocks the grant. Launch it detached (for
example `systemd-run --user`) and let the launching turn end first.

### While held

Every new turn is refused with a sentence naming the holder and expiry (an
HTTP `503 { code: "maintenance" }` where a request asked for it):

- a direct or room message is refused before it is stored;
- a team handoff into a room is refused at dispatch;
- an automation run (routine, app event) that comes due fails with that
  sentence;
- a webhook delivery gets `503` from the receiver, so its sender can retry;
- a calendar room kickoff is skipped and logged;
- a message that was already queued fails with a "could not start" line.

Competing acquisitions get `409 lease-held`. Ordinary API reads and writes are
not blocked; pair soul writes with `leaseToken` to make the lease a
precondition of the write itself.

### Validation and expiry

- Before each external mutation, `check` the lease and require enough
  `remainingMs` for that step; `renew` well before expiry. Pass `leaseToken`
  on soul writes so validation and write are one atomic step.
- A lease ends at `expiresAt` with no call needed; turns are admitted again at
  once. An expired lease cannot be renewed or reacquired with the same token
  (`lease-ended`): acquire again with a new token, which re-proves idleness.
- Release is idempotent. After a crash, the controller can learn how its lease
  ended from `check` or `release`.

### Persistence and server restarts

The lease is stored in `maintenance-lease.json` in the data folder (mode 0600,
atomic writes) and survives a server restart until its `expiresAt`. A write
that cannot be saved fails the call (`500`) and leaves the lease unchanged. If
the file exists but cannot be read, the server assumes an unknown lease and
refuses turns and acquisitions for 30 minutes from start, the longest any lease
can have left. Workspace backups neither export nor overwrite this file.

Expiry uses the wall clock. A clock step forward shortens a lease; the
controller's `check` before each mutation is what keeps it safe.

## What these primitives do not cover

- Writers outside OpenMausBot (files, services, other daemons) are not fenced;
  the lease covers turn admission only.
- Live voice calls are neither counted as running work nor blocked; their
  spoken requests become turns and are refused.
- Background model calls that are not turns (thread titles, memory upkeep,
  skill review) keep running.
- The lease token and owner trust guard against mistakes, not against a
  hostile process that already has owner access to this server.

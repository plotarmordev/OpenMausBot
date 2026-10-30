# Deployment controller primitives

The [conditional soul write and maintenance lease](../deployment-controller-api.md)
are HTTP routes for an external controller; `control-omb` has no verb for them,
so the recipe sends them to the fixture's own URL with `curl`, as the
[Live calls fixture](live-calls.md) does for its routes.

## Permanent checks

```sh
pnpm exec vitest run server/maintenance-lease-api.test.ts \
  server/maintenance-lease.test.ts server/store.test.ts server/workspace-backup.test.ts
```

`server/maintenance-lease-api.test.ts` launches an isolated fake-engine server. It
holds a turn open and proves acquisition is refused as `busy`, granted once the
turn ends, and that while held direct and room messages are refused before
they are stored, a competing lease is refused, and no turn starts. It writes the
soul under the lease, replays a retried request, refuses a rollback after a
foreign write of the same bytes, voids a request, releases idempotently and
sends a turn again. A second case races a message against an acquisition eight
times and three soul writers against one revision: exactly one side wins each
race.

`server/maintenance-lease.test.ts` covers expiry, renewal, release retries, refusal to
reuse a retained ended token, restart persistence, an unreadable state file and failed saves.
Ended-token refusal and release replay retain only the last 32 ended leases;
after eviction they do not guarantee global token nonreuse or recover the old
outcome. Controllers must always generate a fresh random acquisition token.
A stale different token cannot affect the current lease.
`server/store.test.ts` covers receipts across a restart, voiding, a failed save and
the receipt bound. `server/workspace-backup.test.ts` proves backups neither export
nor overwrite the lease file.

The restart cases persist a held lease and direct/room follow-ups in the
disposable fixture. Neither queue is consumed while held; both resume after
release or expiry. Coordinator and unattended admission also remain held,
without changing main-chat versus delegated-task capacity rules.
Move-to-Cloud keeps its bounded move-wait policy; maintenance acquisition uses
strict idle accounting instead and never ages an active turn out of its gate.

The proposal integration case in `server/cloud-personal.e2e.test.ts`, selected
with `-t "shares the pending proposal budget"`, uses a real guest turn's source
capability to fill the shared pending-card budget with profile and thread-model
proposals. It checks refusal without mutation at capacity, restored capacity
after cancellation of either type, and immediate thread-model changes in the
owner's Ask and Full access conversations without consuming pending capacity.

## By hand

```sh
node --experimental-strip-types scripts/control-omb.ts launch
```

With the printed `URL` (never the live app's):

```sh
B=$(curl -s -H 'content-type: application/json' -d '{"name":"Lease bot"}' "$URL/api/bots" | jq -r .bot.id)
T=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
curl -s -H 'content-type: application/json' "$URL/api/maintenance/lease" \
  -d "{\"token\":\"$T\",\"holder\":\"recipe\",\"ttlMs\":60000}"
pnpm control:omb send --url "$URL" --bot "$B" --text hello   # refused: paused for maintenance
R=$(curl -s "$URL/api/bots/$B/soul" | jq -r .soulRevision)
curl -s -H 'content-type: application/json' "$URL/api/bots/$B/soul/compare-and-set" \
  -d "{\"soul\":\"Be brief.\",\"expectedRevision\":\"$R\",\"requestId\":\"recipe-0001\",\"leaseToken\":\"$T\"}"
curl -s -H 'content-type: application/json' "$URL/api/maintenance/lease/release" -d "{\"token\":\"$T\"}"
pnpm control:omb send --url "$URL" --bot "$B" --text hello   # answered
```

Stop the launcher with Ctrl-C; it removes its temporary data. Nothing here
touches a live server, systemd unit or GPU.

# coil update relay

A fork-owned Cloudflare Worker that tells running T3 Code desktop apps when a new build exists.

**Zero upstream seams.** Every file here is new; nothing under `infra/relay/` is touched.

## Why not a route in `infra/relay/`

`infra/relay/` is upstream-owned and the fork edits none of it. Adding routes there would open a
new front on `docs/coil/SEAMS.md`, whose own tripwire reads _"Before adding row 35, re-isolate
something instead."_ It also has never deployed on this fork — `deploy-relay.yml` has one
cancelled run in the repo's history, is `disabled_manually`, and needs six secrets and twelve
variables the fork does not have. There was nothing to piggyback on.

## What it does

```
release workflow ──POST /notify (HMAC)──> Worker ──> UpdateChannel (Durable Object)
                                                        │
                        desktop apps <──SSE /events─────┤
                        desktop apps <──GET /latest ────┘
```

| Route          | Auth | Purpose                                                                 |
| -------------- | ---- | ----------------------------------------------------------------------- |
| `POST /notify` | HMAC | The release workflow announcing a build. The only authenticated route.  |
| `GET /latest`  | none | Current payload. The client's fallback tier. `Cache-Control: no-store`. |
| `GET /events`  | none | SSE broadcast. Replays current payload on connect.                      |
| `GET /health`  | none | Liveness.                                                               |

## Three decisions worth knowing before you change anything

**It is almost schema-blind.** The only field it parses is `buildNumber`. Asset URLs, checksums,
platform keys and commit hashes are opaque passthrough, rebroadcast verbatim. If the relay parsed
the manifest, every manifest change would need a relay deploy in lockstep with an app release, and
an older relay would start rejecting valid payloads.

**Reads are unauthenticated on purpose.** This fork is a public repo, so "main moved to `<sha>`"
is already public. Subscriber tokens would buy no confidentiality and would cost every client a
provisioning step and us a revocation story. Writes are authenticated because that is where the
leverage is: a forged notify would restart every installed app into an artifact of the attacker's
choosing.

**Ordering is `buildNumber`, not time and not the commit.** The commit hash cannot answer "is this
newer", and on this fork it especially cannot — `main` is force-pushed by the sync playbook, so a
released commit may not even be an ancestor of `main`. Timestamps lose to clock skew between two
matrix legs racing to notify. A payload whose `buildNumber` is `<=` the stored one is rejected with
`409`, because an accepted out-of-order notify would move every client _backwards_ onto an older
build while reporting success.

## SSE streams are capped at 15 minutes

Hibernation exists only for WebSockets. An SSE response is a stream the Durable Object must hold
open, so every connected app pins the object in memory, and DO duration bills on wall time rather
than CPU. Uncapped, a handful of always-on desktop apps would keep it resident indefinitely.

Capping turns "connected" into a repeating 15-minute cycle. It costs no latency — the client
reconnects immediately and gets the current payload replayed on connect.

## Deploying

```bash
pnpm dlx wrangler@4 secret put T3X_UPDATE_HMAC_SECRET
pnpm --filter coil-update-relay deploy
```

`wrangler` is deliberately **not** a dependency. It drags ~500 lines into `pnpm-lock.yaml`, which
`SEAMS.md` records as the second-worst rebase-conflict surface in this fork, and it is only ever
needed at deploy time. `pnpm dlx` fetches it for that one command instead.

> The wrangler migration must use `new_sqlite_classes`, not `new_classes`. Durable Objects are on
> the Workers free plan only in their SQLite-backed form, and since 2026-07 new KV-backed
> namespaces are refused outright. The wrong one fails at deploy time, not review time.

### The legacy hostname

This Worker was called `t3x-update-relay` until #71. That hostname is **not** retired, and cannot
be: `DEFAULT_RELAY_URL` is compiled into every desktop build, the env override that could point an
install elsewhere is never set in practice, and a build that stops finding its relay has no
remaining channel through which to be told about a new one.

So the old hostname is redeployed as a pass-through to this one, from this same package:

```bash
pnpm --filter coil-update-relay deploy:legacy
```

Order matters. Deploy `coil-update-relay` first, notify it at least once (publish a release, or
POST `/notify` by hand), and only then deploy the shim — otherwise every installed build is briefly
pointed at a relay whose `/latest` is `null`. That reads as "nothing to act on" rather than an
error, so nothing breaks, but no client sees an update until the next release.

The shim reaches this Worker through a **service binding**, not a `fetch` to its public hostname.
That is not a preference. A subrequest from one Worker to a `workers.dev` hostname on the same
account is answered by Cloudflare's own HTML 404 and never arrives: the shim logs `outcome: ok`
with no exception, and `wrangler tail` on the target records zero requests. Repointing the
inherited `host` header does not help. If you ever split these two Workers across packages, the
binding is the thing that has to survive the split.

Retire it only when the Worker's request log shows no `/events` or `/latest` traffic on the old
hostname. There is no deadline by which that becomes true.

### Renaming this Worker

A renamed Worker is a **new** Worker. Two things do not come with it, and neither fails at deploy
time:

- **Secrets.** `wrangler secret list` on the new name returns `[]`. Without
  `T3X_UPDATE_HMAC_SECRET` every `/notify` is a `401`, three retries deep, after the release has
  already published its assets. Cloudflare secrets are write-only, so the old value cannot be
  copied — mint a new one and set it on the Worker and in `gh secret set` together.
- **`T3X_UPDATE_RELAY_URL`.** The release workflow's target is a repo _variable_, so it is invisible
  to any test and to review. It keeps pointing at the old hostname until someone changes the value.
  (#71 kept every `T3X_`-prefixed name deliberately; the _value_ still had to move.)

## Testing

```bash
pnpm --filter coil-update-relay test
```

Covers signature verification (including a replayed request whose timestamp header was swapped for
a fresh one), timestamp skew in both directions, and the ordering rules — most importantly that an
older `buildNumber` is refused, which is the downgrade case.

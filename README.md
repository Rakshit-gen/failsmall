# failsmall

Staged config rollout on Cloudflare Workers. A new version of a config (cache rules, WAF rules, rate limits) goes to one colo first, then 5%, 25%, 50% and everywhere. After each stage it bakes and gets checked against the traffic it served before, and against the colos still on the old version. If it made things worse, every colo goes back to the stable version without anyone being paged first.

The fleet is simulated: 24 colos with real airport codes, each with its own traffic weight, base error rate and p95. Their health comes from a deterministic telemetry simulator, and the console can inject a regression into one version, one region or the whole fleet. Everything around the simulator is the actual code: validation, the one-rollout-at-a-time lock, the stage plan, the statistics, the approval gate and the rollback.

## Quickstart

Needs Node 22 or newer and pnpm.

```
pnpm install
pnpm dev                     # local D1 + wrangler dev on :8787
curl -XPOST localhost:8787/api/seed
open http://localhost:8787
```

`pnpm test` runs the suite inside workerd with the real Durable Object, D1, KV and Workflows runtimes. `pnpm deploy` applies the D1 migrations and deploys; put your database and KV ids in `wrangler.jsonc` first.

`TIME_SCALE` in `wrangler.jsonc` speeds the clock up. At the default of 60 a 10 minute bake takes 10 seconds, so the whole default plan runs in about a minute.

## How it works

```
propose → validate → canary (1 colo, 15m) → 5% → 25% → 50% → [approval] → everywhere → stable
                         each stage: bake, check every 2-3 minutes, fail fast or pass at the end
                         any fail, or no pass after 2 extra bakes → roll back to stable
```

**A version that doesn't validate doesn't exist.** Each kind of config has a zod schema plus lint rules: a WAF rule that blocks every request, two cache rules for the same path, a duplicate rule id. Errors block the save; warnings (a site-wide rate limit low enough to throttle browsing, cached API paths with no bypass cookie) are shown and stored with the version. A version's id is a hash of the canonical document, so saving the same config twice gives the same id.

**One Durable Object per config key owns the truth.** It holds the versions, which one is stable, and the one rollout allowed at a time. Every change is made in its SQLite before any await, so two people can't both start a rollout, and a stage can't be assigned to a rollout that was just aborted. Starting the same rollout id again returns the one already running, so a retried workflow step is safe. After each change it writes KV (what the edge reads) and D1 (what the console reads), in order.

**The edge reads one KV value per key.** `GET /cfg/:key?colo=SIN` looks up the assignment `{stable, rollout: {version, colos}}` and serves the version that colo is on. Colos only get added as stages advance: a colo that got the new version at 5% keeps it at 25%. Which colos go first comes from a hash of the rollout id, so different rollouts canary in different places.

**Each rollout is a Workflow.** Bakes are `step.sleep`, so a rollout halfway through a 15 minute canary survives a restart. Every step first checks the rollout is still the one in progress; if someone aborted it, the workflow ends instead of acting on state it never saw.

**A check compares two things.** The colos on the new version, now, against the same colos in the window before the rollout started; and the colos still on the old version over the same two windows, as a control. A stage fails when the new version's error rate rose by at least 0.2 points beyond whatever the control rose, with a one-sided two-proportion z of at least 3, or its p95 rose 15ms beyond the control's. If the control got worse too, the verdict is "hold": something fleet-wide is going on and the version can't be blamed or cleared. Fewer than 20,000 requests is "insufficient", which never passes a stage but can still fail one that is clearly broken.

**Waiting doesn't pass a stage.** Mid-bake checks can only fail or watch. At the end of the bake a pass moves on; anything else (hold, insufficient) extends the bake, up to two extra bakes, then rolls back.

**Going everywhere needs a yes.** By default the plan stops before the last stage and waits for an approval. No answer in 4 hours counts as a no. Aborting from the console rolls back at once, from any stage, and wakes a rollout that is waiting for approval so it ends now.

## API

| | |
|---|---|
| `GET /cfg/:key?colo=` | the config document that colo serves, with `x-config-version` |
| `GET /api/state` | per key: stable version, rollout in progress, each colo's version and last 5 minutes of health |
| `GET /api/events?limit=` | rollout events, newest first |
| `GET /api/keys/:key` | versions and recent rollouts |
| `POST /api/keys/:key/versions` | `{doc, author, note}`: validate and save; 422 with the errors if it doesn't validate |
| `POST /api/keys/:key/rollouts` | `{version, author, plan?}`: start a rollout; 409 if one is in progress |
| `GET /api/rollouts/:id` | one rollout with every check and event |
| `POST /api/rollouts/:id/approval` | `{approved, by}` |
| `POST /api/rollouts/:id/abort` | `{by}`: roll back now |
| `POST /api/seed` | a stable version and one candidate for each kind |
| `POST /api/faults` | demo: `{key, version?, region?, errorRate, latencyMs}` makes matching colos look worse |
| `POST /api/faults/:id/clear` | demo |

There's no auth. Put Cloudflare Access in front of it before giving it a public URL.

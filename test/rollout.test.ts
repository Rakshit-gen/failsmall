import { introspectWorkflow, introspectWorkflowInstance, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { assignmentKey, type Assignment } from "../src/config";
import { COLO, coloSet } from "../src/fleet";
import { startRollout } from "../src/index";
import { Plan } from "../src/plan";
import type { Outcome } from "../src/rollout";

let n = 0;
const doc = (ttl: number) => ({ rules: [{ path: "/static/*", ttlSeconds: ttl }] });

// A config key of its own for each test, with a stable version and a candidate.
async function fresh() {
  const key = `cache-rules.t${++n}`;
  const cfg = env.CONFIG.getByName(key);
  const s = (await cfg.propose(key, doc(60), "test", "")) as { id: string; stable: boolean };
  const c = (await cfg.propose(key, doc(120), "test", "")) as { id: string; stable: boolean };
  expect([s.stable, c.stable]).toEqual([true, false]);
  return { key, cfg, stable: s.id, candidate: c.id };
}

const PLAN = (extra: Record<string, unknown> = {}) =>
  Plan.parse({
    stages: [
      { name: "canary", percent: 0, bakeMs: 15 * 60_000 },
      { name: "25%", percent: 25, bakeMs: 10 * 60_000 },
      { name: "everywhere", percent: 100, bakeMs: 10 * 60_000 },
    ],
    checks: 3,
    ...extra,
  });

type Mod = Parameters<Parameters<Awaited<ReturnType<typeof introspectWorkflowInstance>>["modify"]>[0]>[0];

async function run(key: string, version: string, plan: Plan, setup?: (m: Mod) => Promise<void>) {
  const id = `ro-${key.replace(".", "_")}-${++n}`;
  await using wf = await introspectWorkflowInstance(env.ROLLOUT, id);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await setup?.(m);
  });
  await startRollout(env, key, { version, author: "test", plan }, id);
  await wf.waitForStatus("complete");
  return { id, out: (await wf.getOutput()) as Outcome };
}

const assignment = (key: string) => env.EDGE.get<Assignment>(assignmentKey(key), "json");
const checks = async (id: string) =>
  (await env.DB.prepare("SELECT stage, n, verdict, reasons FROM checks WHERE rollout_id = ? ORDER BY stage, n").bind(id).all<{ stage: number; n: number; verdict: string; reasons: string }>()).results;
// Faults start an hour back unless told otherwise, so every window of the
// rollout sees them.
const fault = (key: string, f: { version?: string | null; region?: string | null; errorRate?: number; latencyMs?: number; since?: number }) =>
  env.DB.prepare("INSERT INTO faults (key, version, region, error_rate, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(key, f.version ?? null, f.region ?? null, f.errorRate ?? 0, f.latencyMs ?? 0, f.since ?? Date.now() - 3_600_000)
    .run();
const served = async (key: string, colo: string) => (await SELF.fetch(`http://x/cfg/${key}?colo=${colo}`)).headers.get("x-config-version");

describe("a healthy rollout", () => {
  it("takes the new version everywhere, stage by stage, and makes it stable", async () => {
    const { key, stable, candidate } = await fresh();
    const { id, out } = await run(key, candidate, PLAN());
    expect(out).toEqual({ status: "completed" });
    expect(await assignment(key)).toEqual({ stable: candidate });

    const cs = await checks(id);
    expect(cs.some((c) => c.verdict === "fail")).toBe(false);
    for (const stage of [0, 1, 2]) expect(cs.filter((c) => c.stage === stage).at(-1)!.verdict).toBe("pass");

    const kinds = (await env.DB.prepare("SELECT kind FROM events WHERE rollout_id = ? ORDER BY id").bind(id).all<{ kind: string }>()).results.map((e) => e.kind);
    expect(kinds).toEqual(["started", "requested", "stage", "stage", "stage", "completed"]);
    const row = await env.DB.prepare("SELECT status, from_version FROM rollouts WHERE id = ?").bind(id).first();
    expect(row).toEqual({ status: "completed", from_version: stable });
  });
});

describe("rolling back", () => {
  it("stops at the first failing check and puts every colo back on the old version", async () => {
    const { key, stable, candidate } = await fresh();
    await fault(key, { version: candidate, errorRate: 0.03 });
    const { id, out } = await run(key, candidate, PLAN());
    expect(out.status).toBe("rolled_back");
    expect((out as { reason: string }).reason).toMatch(/^canary: error rate \d\.\d\d% against 0\.\d\d% before/);
    // It didn't wait for the bake to end.
    expect(await checks(id)).toHaveLength(1);
    expect(await assignment(key)).toEqual({ stable });
    expect(await served(key, coloSet(id, 0)[0])).toBe(stable);
  });

  it("catches a regional regression at the first stage that reaches the region", async () => {
    const { key, candidate } = await fresh();
    await fault(key, { version: candidate, region: "apac", errorRate: 0.04 });
    const id = `ro-${key.replace(".", "_")}-${n + 1}`;
    const plan = PLAN();
    const first = plan.stages.find((s) => coloSet(id, s.percent).some((c) => COLO.get(c)!.region === "apac"))!;
    const { out } = await run(key, candidate, plan);
    expect((out as { reason: string }).reason.startsWith(`${first.name}: error rate`)).toBe(true);
  });

  it("fails on latency", async () => {
    const { key, candidate } = await fresh();
    await fault(key, { version: candidate, latencyMs: 40 });
    const { out } = await run(key, candidate, PLAN());
    expect((out as { reason: string }).reason).toMatch(/^canary: p95 up (3[5-9]|4[0-5])\.\dms on the new version/);
  });

  it("won't blame or promote a version while the whole fleet is unhealthy", async () => {
    const { key, stable, candidate } = await fresh();
    // Starts now, so the windows before the rollout are healthy.
    await fault(key, { errorRate: 0.03, since: Date.now() });
    const { id, out } = await run(key, candidate, PLAN());
    expect((out as { reason: string }).reason).toBe("canary: colos on the old version got worse too, so this can't be judged, still after 2 extra bakes");
    expect((await checks(id)).map((c) => c.verdict)).toEqual(Array(9).fill("hold"));
    expect(await assignment(key)).toEqual({ stable });
  });

  it("never passes a stage that didn't see enough traffic", async () => {
    const { key, candidate } = await fresh();
    const { id, out } = await run(key, candidate, PLAN({ thresholds: { minRequests: 1e9 } }));
    expect((out as { reason: string }).reason).toMatch(/^canary: \d+ requests so far, 1000000000 needed, still after 2 extra bakes$/);
    expect((await checks(id)).map((c) => c.verdict)).toEqual(Array(9).fill("insufficient"));
  });
});

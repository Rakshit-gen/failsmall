import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, RolloutParams } from "./env";
import { COLOS, coloSet } from "./fleet";
import type { Plan } from "./plan";
import { judge, type Judgment } from "./stats";
import { loadFaults, windowTotals } from "./telemetry";

// A rollout is a Workflow, so a stage that bakes for an hour, or waits a
// day for an approval, survives restarts and deploys. Steps never trust
// that the rollout is still in progress: someone may have aborted it, so
// each one asks the config's Durable Object first.

export interface Decision {
  approved: boolean;
  by: string;
}

export type Outcome = { status: "completed" } | { status: "rolled_back"; reason: string } | { status: "gone" };

export const scaled = (env: Env, ms: number) => Math.max(1, Math.round(ms / Number(env.TIME_SCALE)));

// One health check: the colos on the new version since the stage began,
// against the same colos before the rollout, with the rest as control.
export async function check(
  env: Env,
  p: { rolloutId: string; key: string; version: string; from: string; stage: number; n: number; plan: Plan; colos: string[] },
  windows: { stageStart: number; end: number; baselineEnd: number },
  endOfBake: boolean,
): Promise<Judgment> {
  const scale = Number(env.TIME_SCALE);
  const faults = await loadFaults(env.DB, p.key);
  const len = windows.end - windows.stageStart;
  const on = new Set(p.colos);
  const treated = COLOS.filter((c) => on.has(c.code)).map((c) => c.code);
  const control = COLOS.filter((c) => !on.has(c.code)).map((c) => c.code);
  const as = (codes: string[], version: string) => codes.map((code) => ({ code, version }));
  const j = judge(
    {
      treatedNow: windowTotals(as(treated, p.version), windows.stageStart, windows.end, scale, p.key, faults),
      treatedBase: windowTotals(as(treated, p.from), windows.baselineEnd - len, windows.baselineEnd, scale, p.key, faults),
      controlNow: windowTotals(as(control, p.from), windows.stageStart, windows.end, scale, p.key, faults),
      controlBase: windowTotals(as(control, p.from), windows.baselineEnd - len, windows.baselineEnd, scale, p.key, faults),
    },
    p.plan.thresholds,
    endOfBake,
  );
  await env.DB.prepare("INSERT OR REPLACE INTO checks (rollout_id, stage, n, verdict, reasons, stats, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(p.rolloutId, p.stage, p.n, j.verdict, JSON.stringify(j.reasons), JSON.stringify(j.stats), Date.now())
    .run();
  return j;
}

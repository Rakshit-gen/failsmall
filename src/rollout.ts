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

export class RolloutWorkflow extends WorkflowEntrypoint<Env, RolloutParams> {
  async run(event: WorkflowEvent<RolloutParams>, step: WorkflowStep): Promise<Outcome> {
    const { rolloutId, key, version, plan } = event.payload;
    const cfg = this.env.CONFIG.getByName(key);
    const stillOn = async () => (await cfg.active())?.id === rolloutId;

    const begun = await step.do<{ startedAt: number; from: string }>("begin", async () => {
      const a = await cfg.begin(rolloutId, version, plan);
      return { startedAt: a.started_at, from: a.from_version };
    });
    const rollBack = async (reason: string): Promise<Outcome> => {
      await step.do<boolean>("roll back", async () => (await cfg.rollback(rolloutId, reason)).rolledBack);
      return { status: "rolled_back", reason };
    };

    for (let i = 0; i < plan.stages.length; i++) {
      const stage = plan.stages[i];
      if (plan.approveBefore === i) {
        if (!(await step.do<boolean>(`ask before ${stage.name}`, async () => (await stillOn()) && (await cfg.waiting(rolloutId, stage.name), true)))) {
          return { status: "gone" };
        }
        let decision: Decision;
        try {
          decision = (await step.waitForEvent<Decision>(`approval before ${stage.name}`, { type: "approval", timeout: scaled(this.env, plan.approvalTimeoutMs) })).payload;
        } catch {
          return rollBack(`nobody approved ${stage.name} in time`);
        }
        if (!decision.approved) return rollBack(`${decision.by} declined ${stage.name}`);
      }

      const colos = coloSet(rolloutId, stage.percent);
      const stageStart = await step.do<number | null>(`start ${stage.name}`, async () => {
        if (!(await stillOn())) return null;
        await cfg.assign(rolloutId, i, colos, stage.name);
        return Date.now();
      });
      if (stageStart === null) return { status: "gone" };

      const interval = scaled(this.env, stage.bakeMs / plan.checks);
      let extensions = 0;
      for (let n = 0; ; n++) {
        await step.sleep(`bake ${stage.name} ${n}`, interval);
        const endOfBake = (n + 1) % plan.checks === 0;
        const j = await step.do<Judgment | null>(`check ${stage.name} ${n}`, async () => {
          if (!(await stillOn())) return null;
          return check(
            this.env,
            { rolloutId, key, version, from: begun.from, stage: i, n, plan, colos },
            { stageStart, end: stageStart + interval * (n + 1), baselineEnd: begun.startedAt },
            endOfBake,
          );
        });
        if (j === null) return { status: "gone" };
        if (j.verdict === "fail") return rollBack(`${stage.name}: ${j.reasons.join("; ")}`);
        if (!endOfBake) continue;
        if (j.verdict === "pass") break;
        if (extensions === plan.maxExtensions) {
          return rollBack(`${stage.name}: ${j.reasons.join("; ")}, still after ${extensions} extra bake${extensions === 1 ? "" : "s"}`);
        }
        extensions++;
      }
    }

    const done = await step.do<boolean>("finish", async () => (await stillOn()) && (await cfg.finish(rolloutId), true));
    return done ? { status: "completed" } : { status: "gone" };
  }
}

import type { Plan } from "./plan";
import type { Totals } from "./telemetry";

// The canary judgment. Colos on the new version are compared with
// themselves before the rollout started, so a colo that is always a bit
// slower doesn't look like a regression. Colos still on the old version
// over the same windows are the control: if they got worse too, the
// problem isn't the config.

export type Verdict = "pass" | "watching" | "fail" | "insufficient" | "hold";

export interface Windows {
  treatedNow: Totals;
  treatedBase: Totals;
  controlNow: Totals;
  controlBase: Totals;
}

export interface Judgment {
  verdict: Verdict;
  reasons: string[];
  stats: {
    requests: number;
    errorRate: number;
    baseErrorRate: number;
    controlErrorRate: number | null;
    z: number;
    p95: number;
    baseP95: number;
    latencyRise: number;
    controlLatencyRise: number | null;
  };
}

const rate = (t: Totals) => (t.requests ? t.errors / t.requests : 0);

// One-sided two-proportion z score: how sure we are that a's error rate is above b's.
export function zScore(a: Totals, b: Totals): number {
  if (!a.requests || !b.requests) return 0;
  const p = (a.errors + b.errors) / (a.requests + b.requests);
  const se = Math.sqrt(p * (1 - p) * (1 / a.requests + 1 / b.requests));
  return se ? (rate(a) - rate(b)) / se : 0;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

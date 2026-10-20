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

export function judge(w: Windows, t: Plan["thresholds"], endOfBake: boolean): Judgment {
  const hasControl = w.controlNow.requests > 0 && w.controlBase.requests > 0;
  const errRise = rate(w.treatedNow) - rate(w.treatedBase);
  const z = zScore(w.treatedNow, w.treatedBase);
  const latRise = w.treatedNow.p95 - w.treatedBase.p95;
  const cErrRise = hasControl ? rate(w.controlNow) - rate(w.controlBase) : 0;
  const cZ = hasControl ? zScore(w.controlNow, w.controlBase) : 0;
  const cLatRise = hasControl ? w.controlNow.p95 - w.controlBase.p95 : 0;

  const stats: Judgment["stats"] = {
    requests: w.treatedNow.requests,
    errorRate: rate(w.treatedNow),
    baseErrorRate: rate(w.treatedBase),
    controlErrorRate: hasControl ? rate(w.controlNow) : null,
    z,
    p95: w.treatedNow.p95,
    baseP95: w.treatedBase.p95,
    latencyRise: latRise,
    controlLatencyRise: hasControl ? cLatRise : null,
  };
  const reasons: string[] = [];

  // What the new version is to blame for: its rise beyond the control's.
  const blamedErr = errRise - Math.max(0, cErrRise);
  const blamedLat = latRise - Math.max(0, cLatRise);
  if (blamedErr >= t.errorRateDelta && z >= t.z) {
    reasons.push(`error rate ${pct(rate(w.treatedNow))} against ${pct(rate(w.treatedBase))} before (z ${z.toFixed(1)})`);
  }
  if (w.treatedNow.requests > 0 && blamedLat >= t.latencyDeltaMs) {
    reasons.push(`p95 up ${latRise.toFixed(1)}ms on the new version${hasControl ? `, ${cLatRise.toFixed(1)}ms on the old` : ""}`);
  }
  if (reasons.length) return { verdict: "fail", reasons, stats };

  const fleetWide = hasControl && ((cErrRise >= t.errorRateDelta && cZ >= t.z) || cLatRise >= t.latencyDeltaMs);
  if (fleetWide) {
    return { verdict: "hold", reasons: ["colos on the old version got worse too, so this can't be judged"], stats };
  }
  if (w.treatedNow.requests < t.minRequests) {
    return { verdict: "insufficient", reasons: [`${w.treatedNow.requests} requests so far, ${t.minRequests} needed`], stats };
  }
  return { verdict: endOfBake ? "pass" : "watching", reasons: [], stats };
}

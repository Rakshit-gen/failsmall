import { describe, expect, it } from "vitest";
import { COLO, COLOS, coloSet, trafficShare } from "../src/fleet";
import { DEFAULT_PLAN, Plan } from "../src/plan";
import { canonical, kindOf, validate, versionId } from "../src/schemas";
import { judge, zScore } from "../src/stats";
import { windowTotals, type Fault, type Totals } from "../src/telemetry";

const SCALE = 60;
const MIN = 60_000 / SCALE; // one simulated minute in real ms
const T0 = 1_800_000_000_000;
const totals = (requests: number, errors: number, p95 = 50): Totals => ({ requests, errors, p95, minutes: 1 });
const fault = (f: Partial<Fault>): Fault => ({ key: "k", version: null, region: null, error_rate: 0, latency_ms: 0, created_at: 0, cleared_at: null, ...f });

describe("colo selection", () => {
  it("starts with one canary colo and only ever adds colos", () => {
    const stages = DEFAULT_PLAN.stages.map((s) => coloSet("ro-1", s.percent));
    expect(stages[0]).toHaveLength(1);
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].slice(0, stages[i - 1].length)).toEqual(stages[i - 1]);
      expect(trafficShare(stages[i])).toBeGreaterThanOrEqual(DEFAULT_PLAN.stages[i].percent / 100);
    }
    expect(stages.at(-1)!.sort()).toEqual(COLOS.map((c) => c.code).sort());
  });

  it("picks a different canary for different rollouts", () => {
    const canaries = new Set(Array.from({ length: 50 }, (_, i) => coloSet(`ro-${i}`, 0)[0]));
    expect(canaries.size).toBeGreaterThan(10);
  });
});

describe("judgment", () => {
  const t = DEFAULT_PLAN.thresholds;

  it("scores a rise in error rate", () => {
    expect(zScore(totals(100_000, 400), totals(100_000, 150))).toBeGreaterThan(10);
    expect(zScore(totals(100_000, 150), totals(100_000, 150))).toBe(0);
    expect(zScore(totals(0, 0), totals(100_000, 150))).toBe(0);
  });

  it("fails a version whose colos got worse while the control didn't", () => {
    const j = judge({ treatedNow: totals(50_000, 600), treatedBase: totals(50_000, 80), controlNow: totals(500_000, 700), controlBase: totals(500_000, 690) }, t, false);
    expect(j.verdict).toBe("fail");
    expect(j.reasons[0]).toMatch(/error rate 1\.20% against 0\.16% before/);
  });

  it("holds instead of blaming the version when everything got worse", () => {
    const j = judge({ treatedNow: totals(50_000, 600), treatedBase: totals(50_000, 80), controlNow: totals(500_000, 6000), controlBase: totals(500_000, 700) }, t, true);
    expect(j.verdict).toBe("hold");
  });

  it("fails on latency alone", () => {
    const j = judge({ treatedNow: totals(50_000, 80, 90), treatedBase: totals(50_000, 80, 50), controlNow: totals(500_000, 700, 51), controlBase: totals(500_000, 700, 50) }, t, true);
    expect(j.verdict).toBe("fail");
    expect(j.reasons[0]).toMatch(/p95 up 40\.0ms/);
  });

  it("never passes a stage on too little traffic, but still fails one that is clearly broken", () => {
    expect(judge({ treatedNow: totals(5000, 8), treatedBase: totals(5000, 8), controlNow: totals(1e6, 1500), controlBase: totals(1e6, 1500) }, t, true).verdict).toBe("insufficient");
    expect(judge({ treatedNow: totals(5000, 400), treatedBase: totals(5000, 8), controlNow: totals(1e6, 1500), controlBase: totals(1e6, 1500) }, t, true).verdict).toBe("fail");
  });

  it("passes only at the end of a bake", () => {
    const w = { treatedNow: totals(50_000, 80), treatedBase: totals(50_000, 80), controlNow: totals(1e6, 1500), controlBase: totals(1e6, 1500) };
    expect(judge(w, t, false).verdict).toBe("watching");
    expect(judge(w, t, true).verdict).toBe("pass");
  });
});

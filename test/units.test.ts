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

describe("telemetry", () => {
  it("gives the same numbers for the same window", () => {
    const colos = [{ code: "SIN", version: "a" }, { code: "FRA", version: "a" }];
    expect(windowTotals(colos, T0, T0 + 10 * MIN, SCALE, "k", [])).toEqual(windowTotals(colos, T0, T0 + 10 * MIN, SCALE, "k", []));
    expect(windowTotals(colos, T0, T0 + 10 * MIN, SCALE, "k", []).minutes).toBe(10);
  });

  it("applies a fault only to its version, region, key and time", () => {
    const f = [fault({ version: "bad", region: "apac", error_rate: 0.05, created_at: T0 + 5 * MIN })];
    const rate = (code: string, version: string, from: number, key = "k") => {
      const x = windowTotals([{ code, version }], from, from + 5 * MIN, SCALE, key, f);
      return x.errors / x.requests;
    };
    expect(rate("SIN", "bad", T0 + 5 * MIN)).toBeGreaterThan(0.04);
    expect(rate("SIN", "bad", T0)).toBeLessThan(0.01);
    expect(rate("SIN", "good", T0 + 5 * MIN)).toBeLessThan(0.01);
    expect(rate("FRA", "bad", T0 + 5 * MIN)).toBeLessThan(0.01);
    expect(rate("SIN", "bad", T0 + 5 * MIN, "other")).toBeLessThan(0.01);
  });

  // The gate is only useful if healthy versions get through and broken
  // ones don't. This runs the default plan's checks on simulated traffic.
  it("doesn't roll back healthy versions, and catches a 2% error regression at every stage", () => {
    const f = [fault({ version: "bad", error_rate: 0.02 })];
    let falseAlarms = 0, missed = 0, checks = 0;
    for (let r = 0; r < 200; r++) {
      const start = T0 + r * 997 * MIN;
      for (const s of DEFAULT_PLAN.stages) {
        const on = new Set(coloSet(`ro-${r}`, s.percent));
        const len = (s.bakeMs / 60_000) * MIN;
        const pick = (inside: boolean, v: string) => COLOS.filter((c) => on.has(c.code) === inside).map((c) => ({ code: c.code, version: v }));
        for (const version of ["good", "bad"]) {
          const j = judge(
            {
              treatedNow: windowTotals(pick(true, version), start, start + len, SCALE, "k", f),
              treatedBase: windowTotals(pick(true, "stable"), start - len, start, SCALE, "k", f),
              controlNow: windowTotals(pick(false, "stable"), start, start + len, SCALE, "k", f),
              controlBase: windowTotals(pick(false, "stable"), start - len, start, SCALE, "k", f),
            },
            DEFAULT_PLAN.thresholds,
            true,
          );
          if (version === "good" && j.verdict === "fail") falseAlarms++;
          if (version === "bad" && j.verdict !== "fail") missed++;
          checks++;
        }
      }
    }
    expect(checks).toBe(2000);
    expect(falseAlarms).toBe(0);
    expect(missed).toBe(0);
  });
});

describe("validation", () => {
  it("knows kinds and zone-scoped keys", () => {
    expect(kindOf("cache-rules")).toBe("cache-rules");
    expect(kindOf("cache-rules.shop")).toBe("cache-rules");
    expect(kindOf("dns-records")).toBeNull();
    expect(kindOf("cache-rules.")).toBeNull();
  });

  it("rejects documents that don't match the schema", () => {
    expect(validate("cache-rules", { rules: [{ path: "static", ttlSeconds: -1 }] }).errors).toEqual([
      "rules.0.path: must be a path starting with /",
      "rules.0.ttlSeconds: Too small: expected number to be >=0",
    ]);
  });

  it("blocks a WAF rule that blocks everything and warns on one that only matches everything", () => {
    expect(validate("waf-rules", { rules: [{ id: "oops", expression: "true", action: "block" }] }).errors).toEqual(["oops blocks every request"]);
    const v = validate("waf-rules", { rules: [{ id: "watch", expression: " 1 == 1 ", action: "log" }] });
    expect(v).toEqual({ errors: [], warnings: ["watch matches every request"] });
  });

  it("gives a document the same id whatever its key order", async () => {
    const a = { rules: [{ path: "/a", ttlSeconds: 1 }] };
    const b = { rules: [{ ttlSeconds: 1, path: "/a" }] };
    expect(canonical(a)).toBe(canonical(b));
    expect(await versionId(a)).toBe(await versionId(b));
    expect(await versionId(a)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("plans", () => {
  it("must end at 100% and grow every stage", () => {
    const stage = (percent: number) => ({ name: `${percent}`, percent, bakeMs: 60_000 });
    expect(Plan.safeParse({ stages: [stage(0), stage(50)] }).success).toBe(false);
    expect(Plan.safeParse({ stages: [stage(0), stage(50), stage(50), stage(100)] }).success).toBe(false);
    expect(Plan.safeParse({ stages: [stage(0), stage(100)], approveBefore: 2 }).success).toBe(false);
    expect(Plan.parse({ stages: [stage(0), stage(100)] }).thresholds.minRequests).toBe(20_000);
  });

  it("covers every colo it names", () => {
    for (const c of COLOS) expect(COLO.get(c.code)).toBe(c);
  });
});

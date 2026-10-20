import { z } from "zod";

const MINUTE = 60_000;

export const Stage = z.object({
  name: z.string().min(1).max(40),
  // Share of traffic, by colo weight. 0 means a single canary colo.
  percent: z.number().min(0).max(100),
  bakeMs: z.number().int().min(MINUTE).max(24 * 60 * MINUTE),
});

export const Plan = z
  .object({
    stages: z.array(Stage).min(1).max(10),
    // Health checks per bake. A failing check rolls back at once; the stage
    // only passes when its last check does.
    checks: z.number().int().min(1).max(30).default(5),
    // A bake that ends without enough traffic to judge, or while the whole
    // fleet is unhealthy, runs this many more times before giving up.
    maxExtensions: z.number().int().min(0).max(5).default(2),
    // Index of the stage that needs a person's yes before it starts.
    // -1 means no approval.
    approveBefore: z.number().int().min(-1).default(-1),
    approvalTimeoutMs: z.number().int().min(MINUTE).default(4 * 60 * MINUTE),
    thresholds: z
      .object({
        // Requests the colos on the new version must serve before a check can pass.
        minRequests: z.number().int().min(100).default(20_000),
        // A rise in error rate counts when it is this large in absolute
        // terms and significant at this z score.
        errorRateDelta: z.number().min(0).default(0.002),
        z: z.number().min(1).default(3),
        // Request-weighted rise in p95 latency, in ms.
        latencyDeltaMs: z.number().min(0).default(15),
      })
      .prefault({}),
  })
  .refine((p) => p.stages.at(-1)!.percent === 100, { message: "the last stage must reach 100%" })
  .refine((p) => p.stages.every((s, i) => i === 0 || s.percent > p.stages[i - 1].percent), { message: "each stage must reach more traffic than the one before" })
  .refine((p) => p.approveBefore < p.stages.length, { message: "approveBefore must name a stage" });

export type Plan = z.output<typeof Plan>;

export const DEFAULT_PLAN: Plan = Plan.parse({
  stages: [
    { name: "canary", percent: 0, bakeMs: 15 * MINUTE },
    { name: "5%", percent: 5, bakeMs: 10 * MINUTE },
    { name: "25%", percent: 25, bakeMs: 10 * MINUTE },
    { name: "50%", percent: 50, bakeMs: 10 * MINUTE },
    { name: "everywhere", percent: 100, bakeMs: 10 * MINUTE },
  ],
  approveBefore: 4,
});

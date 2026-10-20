import { z } from "zod";
import { assignmentKey, CONFLICT, docKey, NOT_FOUND, type Assignment } from "./config";
import type { Env } from "./env";
import { COLO, COLOS, REGIONS } from "./fleet";
import { DEFAULT_PLAN, Plan } from "./plan";
import { kindOf, KINDS, SEED } from "./schemas";
import { loadFaults, windowTotals } from "./telemetry";

export { ConfigObject } from "./config";
export { RolloutWorkflow } from "./rollout";

const json = (data: unknown, status = 200) => Response.json(data, { status });

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

const NewVersion = z.object({ doc: z.unknown(), author: z.string().min(1).max(60), note: z.string().max(500).default("") });
const NewRollout = z.object({ version: z.string().regex(/^[0-9a-f]{12}$/), author: z.string().min(1).max(60), plan: Plan.optional() });
const Decision = z.object({ approved: z.boolean(), by: z.string().min(1).max(60) });
const Abort = z.object({ by: z.string().min(1).max(60) });
const NewFault = z.object({
  key: z.string(),
  version: z.string().nullable().default(null),
  region: z.enum(REGIONS).nullable().default(null),
  errorRate: z.number().min(0).max(1).default(0),
  latencyMs: z.number().min(0).max(5000).default(0),
});

const config = (env: Env, key: string) => {
  if (!kindOf(key)) throw new HttpError(404, `unknown config key ${key}`);
  return env.CONFIG.getByName(key);
};

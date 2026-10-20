import type { ConfigObject } from "./config";
import type { Plan } from "./plan";

export interface Env {
  DB: D1Database;
  EDGE: KVNamespace;
  CONFIG: DurableObjectNamespace<ConfigObject>;
  ROLLOUT: Workflow<RolloutParams>;
  TIME_SCALE: string;
}

export interface RolloutParams {
  rolloutId: string;
  key: string;
  version: string;
  plan: Plan;
}

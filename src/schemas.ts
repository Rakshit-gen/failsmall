import { z } from "zod";

// The kinds of config this deployment serves, each with a schema and lint
// rules. A key is a kind, optionally scoped to a zone: "cache-rules" or
// "cache-rules.shop". A version that fails validation never gets an id,
// so it can't be rolled out. Warnings are shown but don't block.

const path = z.string().regex(/^\/[\w\-./*]*$/, "must be a path starting with /");

const SCHEMAS = {
  "cache-rules": z.object({
    rules: z
      .array(z.object({ path, ttlSeconds: z.number().int().min(0).max(31_536_000), bypassOnCookie: z.string().min(1).optional() }))
      .max(200),
  }),
  "waf-rules": z.object({
    rules: z
      .array(z.object({ id: z.string().regex(/^[a-z0-9-]{3,40}$/), expression: z.string().min(1).max(2000), action: z.enum(["block", "challenge", "log"]) }))
      .max(500),
  }),
  "rate-limits": z.object({
    limits: z.array(z.object({ path, requestsPerMinute: z.number().int().min(1).max(1_000_000) })).max(100),
  }),
};

export type ConfigKind = keyof typeof SCHEMAS;
export const KINDS = Object.keys(SCHEMAS) as ConfigKind[];

export function kindOf(key: string): ConfigKind | null {
  const m = key.match(/^([a-z-]+)(?:\.[a-z0-9-]{1,40})?$/);
  return m && m[1] in SCHEMAS ? (m[1] as ConfigKind) : null;
}

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

export interface Validation {
  errors: string[];
  warnings: string[];
}

type Lint = (doc: any) => Validation;

const LINT: Record<ConfigKind, Lint> = {
  "cache-rules": (doc) => {
    const v: Validation = { errors: [], warnings: [] };
    const seen = new Set<string>();
    for (const r of doc.rules) {
      if (seen.has(r.path)) v.errors.push(`${r.path} has two rules; only the first would ever match`);
      seen.add(r.path);
      if (r.path === "/*" && r.ttlSeconds === 0) v.warnings.push("/* with ttl 0 turns caching off for the whole site");
      if (r.path.startsWith("/api") && r.ttlSeconds > 0 && !r.bypassOnCookie) v.warnings.push(`${r.path} caches API responses with no bypass cookie`);
    }
    return v;
  },
  "waf-rules": (doc) => {
    const v: Validation = { errors: [], warnings: [] };
    const ids = new Set<string>();
    for (const r of doc.rules) {
      if (ids.has(r.id)) v.errors.push(`rule id ${r.id} is used twice`);
      ids.add(r.id);
      const always = /^\s*(true|1\s*==\s*1)\s*$/i.test(r.expression);
      if (always && r.action === "block") v.errors.push(`${r.id} blocks every request`);
      else if (always) v.warnings.push(`${r.id} matches every request`);
    }
    return v;
  },
  "rate-limits": (doc) => {
    const v: Validation = { errors: [], warnings: [] };
    for (const l of doc.limits) {
      if (l.path === "/*" && l.requestsPerMinute < 60) v.warnings.push(`a site-wide limit of ${l.requestsPerMinute}/min will throttle normal browsing`);
    }
    return v;
  },
};

export function validate(kind: ConfigKind, doc: unknown): Validation {
  const parsed = SCHEMAS[kind].safeParse(doc);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".") || "document"}: ${i.message}`), warnings: [] };
  }
  return LINT[kind](parsed.data);
}

// Key order doesn't change a version's id.
export function canonical(doc: unknown): string {
  if (Array.isArray(doc)) return `[${doc.map(canonical).join(",")}]`;
  if (doc && typeof doc === "object") {
    return `{${Object.keys(doc).sort().map((k) => `${JSON.stringify(k)}:${canonical((doc as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(doc);
}

export async function versionId(doc: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(doc)));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const SEED: Record<ConfigKind, unknown> = {
  "cache-rules": { rules: [{ path: "/static/*", ttlSeconds: 86400 }, { path: "/*", ttlSeconds: 300 }] },
  "waf-rules": { rules: [{ id: "block-wp-login", expression: 'http.request.uri.path eq "/wp-login.php"', action: "block" }] },
  "rate-limits": { limits: [{ path: "/api/*", requestsPerMinute: 600 }] },
};

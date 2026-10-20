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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      let m: RegExpMatchArray | null;

      // What a colo's edge workers read. Each colo gets the version its
      // rollout stage says, and the stable version otherwise.
      if ((m = path.match(/^\/cfg\/([\w.-]+)$/)) && req.method === "GET") {
        const colo = (url.searchParams.get("colo") ?? "").toUpperCase();
        if (!COLO.has(colo)) throw new HttpError(400, "colo must be one of the fleet's airport codes");
        const a = await env.EDGE.get<Assignment>(assignmentKey(m[1]), "json");
        if (!a) throw new HttpError(404, `no config for ${m[1]}`);
        const version = a.rollout?.colos.includes(colo) ? a.rollout.version : a.stable;
        const doc = await env.EDGE.get(docKey(m[1], version));
        return new Response(doc, { headers: { "content-type": "application/json", "x-config-version": version, "x-config-colo": colo } });
      }

      if (path === "/api/state" && req.method === "GET") return json(await state(env));
      if (path === "/api/seed" && req.method === "POST") return json(await seed(env));
      if (path === "/api/events" && req.method === "GET") {
        const r = await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(Math.min(Number(url.searchParams.get("limit") ?? 50), 200)).all();
        return json(r.results);
      }

      if ((m = path.match(/^\/api\/keys\/([\w.-]+)$/)) && req.method === "GET") {
        config(env, m[1]);
        const [versions, rollouts] = await env.DB.batch([
          env.DB.prepare("SELECT * FROM versions WHERE key = ? ORDER BY created_at DESC").bind(m[1]),
          env.DB.prepare("SELECT * FROM rollouts WHERE key = ? ORDER BY started_at DESC LIMIT 20").bind(m[1]),
        ]);
        return json({ versions: versions.results, rollouts: rollouts.results });
      }
      if ((m = path.match(/^\/api\/keys\/([\w.-]+)\/versions$/)) && req.method === "POST") {
        const b = await body(req, NewVersion);
        const r = await config(env, m[1]).propose(m[1], b.doc, b.author, b.note);
        return json(r, r.ok ? 200 : 422);
      }
      if ((m = path.match(/^\/api\/keys\/([\w.-]+)\/rollouts$/)) && req.method === "POST") {
        return json(await startRollout(env, m[1], await body(req, NewRollout)), 201);
      }

      if ((m = path.match(/^\/api\/rollouts\/([\w-]+)$/)) && req.method === "GET") return json(await rollout(env, m[1]));
      if ((m = path.match(/^\/api\/rollouts\/([\w-]+)\/abort$/)) && req.method === "POST") {
        const b = await body(req, Abort);
        const r = await rolloutRow(env, m[1]);
        const out = await env.CONFIG.getByName(r.key).rollback(r.id, `aborted by ${b.by}`);
        if (!out.rolledBack) throw new HttpError(409, `rollout ${r.id} is ${r.status}`);
        // Wake the workflow if it's waiting for an approval, so it ends now.
        if (r.status === "waiting_for_approval") await (await env.ROLLOUT.get(r.id)).sendEvent({ type: "approval", payload: { approved: false, by: b.by } }).catch(() => {});
        return json({ id: r.id, status: "rolled_back" });
      }
      if ((m = path.match(/^\/api\/rollouts\/([\w-]+)\/approval$/)) && req.method === "POST") {
        const b = await body(req, Decision);
        const r = await rolloutRow(env, m[1]);
        if (r.status !== "waiting_for_approval") throw new HttpError(409, `rollout ${r.id} isn't waiting for approval`);
        await (await env.ROLLOUT.get(r.id)).sendEvent({ type: "approval", payload: b });
        return json({ id: r.id, approved: b.approved });
      }

      // Demo controls: make a version, or the whole fleet, look broken.
      if (path === "/api/faults" && req.method === "POST") {
        const b = await body(req, NewFault);
        config(env, b.key);
        const r = await env.DB.prepare("INSERT INTO faults (key, version, region, error_rate, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
          .bind(b.key, b.version, b.region, b.errorRate, b.latencyMs, Date.now())
          .first<{ id: number }>();
        return json({ id: r!.id }, 201);
      }
      if ((m = path.match(/^\/api\/faults\/(\d+)\/clear$/)) && req.method === "POST") {
        await env.DB.prepare("UPDATE faults SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL").bind(Date.now(), Number(m[1])).run();
        return json({ id: Number(m[1]) });
      }

      if (path.startsWith("/api/")) throw new HttpError(404, "no such route");
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith(CONFLICT)) return json({ error: msg.slice(CONFLICT.length + 2) }, 409);
      if (msg.startsWith(NOT_FOUND)) return json({ error: msg.slice(NOT_FOUND.length + 2) }, 404);
      console.error(JSON.stringify({ msg: "request failed", path, error: msg }));
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

interface RolloutRow {
  id: string;
  key: string;
  version: string;
  from_version: string;
  plan: string;
  status: string;
  stage: number;
  colos: string;
  reason: string | null;
  started_at: number;
  ended_at: number | null;
}

async function rolloutRow(env: Env, id: string): Promise<RolloutRow> {
  const r = await env.DB.prepare("SELECT * FROM rollouts WHERE id = ?").bind(id).first<RolloutRow>();
  if (!r) throw new HttpError(404, `no rollout ${id}`);
  return r;
}

// The Durable Object takes the rollout first, so a second start fails with
// a 409 here instead of inside a workflow nobody is watching.
export async function startRollout(env: Env, key: string, b: z.infer<typeof NewRollout>, id = `ro-${key.replaceAll(".", "_")}-${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`) {
  const plan = b.plan ?? DEFAULT_PLAN;
  await config(env, key).begin(id, b.version, plan);
  await env.ROLLOUT.create({ id, params: { rolloutId: id, key, version: b.version, plan } });
  await env.DB.prepare("INSERT INTO events (key, rollout_id, kind, detail, at) VALUES (?, ?, 'requested', ?, ?)").bind(key, id, `${b.author} asked for ${b.version}`, Date.now()).run();
  return { id, key, version: b.version, plan };
}

async function rollout(env: Env, id: string) {
  const r = await rolloutRow(env, id);
  const [checks, events] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM checks WHERE rollout_id = ? ORDER BY stage, n").bind(id),
    env.DB.prepare("SELECT * FROM events WHERE rollout_id = ? ORDER BY id").bind(id),
  ]);
  return {
    ...r,
    plan: JSON.parse(r.plan),
    colos: JSON.parse(r.colos),
    checks: (checks.results as Record<string, string>[]).map((c) => ({ ...c, reasons: JSON.parse(c.reasons), stats: JSON.parse(c.stats) })),
    events: events.results,
  };
}

// Per key: the stable version, the rollout in progress, and each colo's
// version and last five simulated minutes of health.
async function state(env: Env) {
  const scale = Number(env.TIME_SCALE);
  const now = Date.now();
  const recent = now - (5 * 60_000) / scale;
  const [keys, active, faults] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM keys ORDER BY key"),
    env.DB.prepare("SELECT * FROM rollouts WHERE status IN ('running', 'waiting_for_approval')"),
    env.DB.prepare("SELECT * FROM faults WHERE cleared_at IS NULL ORDER BY id"),
  ]);
  const byKey = new Map((active.results as unknown as RolloutRow[]).map((r) => [r.key, r]));
  const out = [];
  for (const k of keys.results as { key: string; stable: string }[]) {
    const r = byKey.get(k.key);
    const on = new Set<string>(r ? JSON.parse(r.colos) : []);
    const kf = await loadFaults(env.DB, k.key);
    out.push({
      key: k.key,
      stable: k.stable,
      rollout: r ? { ...r, plan: JSON.parse(r.plan), colos: [...on] } : null,
      colos: COLOS.map((c) => {
        const version = on.has(c.code) ? r!.version : k.stable;
        const t = windowTotals([{ code: c.code, version }], recent, now, scale, k.key, kf);
        return { code: c.code, region: c.region, weight: c.weight, version, errorRate: t.requests ? t.errors / t.requests : 0, p95: t.p95 };
      }),
    });
  }
  return { keys: out, faults: faults.results, timeScale: scale, kinds: KINDS };
}

// Stable versions for every key, plus one candidate each to roll out.
async function seed(env: Env) {
  const CANDIDATES: Record<string, unknown> = {
    "cache-rules": { rules: [{ path: "/static/*", ttlSeconds: 604800 }, { path: "/*", ttlSeconds: 600 }] },
    "waf-rules": {
      rules: [
        { id: "block-wp-login", expression: 'http.request.uri.path eq "/wp-login.php"', action: "block" },
        { id: "challenge-bad-asn", expression: "ip.geoip.asnum in {64496 64511}", action: "challenge" },
      ],
    },
    "rate-limits": { limits: [{ path: "/api/*", requestsPerMinute: 900 }, { path: "/login", requestsPerMinute: 20 }] },
  };
  const out: Record<string, { stable: string; candidate: string }> = {};
  for (const key of KINDS) {
    const cfg = env.CONFIG.getByName(key);
    const s = await cfg.propose(key, SEED[key], "seed", "initial version");
    const c = await cfg.propose(key, CANDIDATES[key], "seed", "candidate to roll out");
    if (s.ok && c.ok) out[key] = { stable: (await cfg.stable())!, candidate: c.id };
  }
  return out;
}

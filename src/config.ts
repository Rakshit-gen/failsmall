import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { Plan } from "./plan";
import { canonical, kindOf, validate, versionId } from "./schemas";

// One Durable Object per config key. It owns the key's versions, which
// version is stable, and the one rollout that may be in progress. Every
// change is made in its SQLite before any await, so two requests can't
// both start a rollout or both act on one that just ended. KV (what the
// edge reads) and D1 (what the console reads) are written after, in order.

export interface Assignment {
  stable: string;
  rollout?: { id: string; version: string; colos: string[] };
}

export interface ActiveRollout {
  id: string;
  version: string;
  from_version: string;
  plan: string;
  status: "running" | "waiting_for_approval";
  stage: number;
  colos: string;
  started_at: number;
}

export type Proposed = { ok: true; id: string; created: boolean; warnings: string[]; stable: boolean } | { ok: false; errors: string[] };

export const CONFLICT = "CONFLICT";
export const NOT_FOUND = "NOT_FOUND";

export const assignmentKey = (key: string) => `assign:${key}`;
export const docKey = (key: string, id: string) => `doc:${key}:${id}`;

export class ConfigObject extends DurableObject<Env> {
  private sql: SqlStorage;
  private out: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS active (
        id TEXT PRIMARY KEY, version TEXT NOT NULL, from_version TEXT NOT NULL, plan TEXT NOT NULL,
        status TEXT NOT NULL, stage INTEGER NOT NULL, colos TEXT NOT NULL, started_at INTEGER NOT NULL
      );
    `);
  }

  private meta(k: string): string | null {
    return (this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v as string) ?? null;
  }

  private key(): string {
    return this.meta("key")!;
  }

  active(): ActiveRollout | null {
    return (this.sql.exec("SELECT * FROM active").toArray()[0] as unknown as ActiveRollout) ?? null;
  }

  stable(): string | null {
    return this.meta("stable");
  }

  private assignment(): Assignment {
    const a = this.active();
    return {
      stable: this.stable()!,
      ...(a && a.stage >= 0 ? { rollout: { id: a.id, version: a.version, colos: JSON.parse(a.colos) } } : {}),
    };
  }

  // Writes are queued so they land in the order the changes were made. Each
  // write reads the state when it runs, so KV ends on the latest assignment
  // even if two changes are made back to back.
  private publish(event: { kind: string; detail: string; rollout?: string }, rolloutRow?: () => D1PreparedStatement | null): Promise<void> {
    const key = this.key();
    const run = async () => {
      const a = this.assignment();
      await this.env.EDGE.put(assignmentKey(key), JSON.stringify(a));
      const stmts = [
        this.env.DB.prepare("INSERT INTO keys (key, stable, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET stable = excluded.stable, updated_at = excluded.updated_at").bind(key, a.stable, Date.now()),
        this.env.DB.prepare("INSERT INTO events (key, rollout_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)").bind(key, event.rollout ?? null, event.kind, event.detail, Date.now()),
      ];
      const row = rolloutRow?.();
      if (row) stmts.push(row);
      await this.env.DB.batch(stmts);
    };
    const p = this.out.then(run);
    this.out = p.catch(() => {});
    return p;
  }

  private projectActive(): D1PreparedStatement | null {
    const a = this.active();
    if (!a) return null;
    return this.env.DB.prepare(
      `INSERT INTO rollouts (id, key, version, from_version, plan, status, stage, colos, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, stage = excluded.stage, colos = excluded.colos`,
    ).bind(a.id, this.key(), a.version, a.from_version, a.plan, a.status, a.stage, a.colos, a.started_at);
  }

  async propose(key: string, doc: unknown, author: string, note: string): Promise<Proposed> {
    const kind = kindOf(key);
    if (!kind) return { ok: false, errors: [`unknown config key ${key}`] };
    const v = validate(kind, doc);
    if (v.errors.length) return { ok: false, errors: v.errors };
    const id = await versionId(doc);
    const text = canonical(doc);

    if (!this.meta("key")) this.sql.exec("INSERT INTO meta (k, v) VALUES ('key', ?)", key);
    const created = this.sql.exec("INSERT OR IGNORE INTO versions (id, doc, created_at) VALUES (?, ?, ?)", id, text, Date.now()).rowsWritten > 0;
    // The first version of a key has nothing to protect, so it is stable at once.
    const bootstrap = !this.stable();
    if (bootstrap) this.sql.exec("INSERT INTO meta (k, v) VALUES ('stable', ?)", id);

    if (created) {
      await this.env.EDGE.put(docKey(key, id), text);
      await this.env.DB.prepare("INSERT OR IGNORE INTO versions (key, id, doc, author, note, warnings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(key, id, text, author, note, JSON.stringify(v.warnings), Date.now())
        .run();
    }
    if (bootstrap) await this.publish({ kind: "stable", detail: `${id} is the first version, so it is stable` });
    return { ok: true, id, created, warnings: v.warnings, stable: bootstrap };
  }

  // Starting again with the same rollout id returns the rollout already
  // running, so a retried workflow step is safe.
  async begin(rolloutId: string, version: string, plan: Plan): Promise<ActiveRollout> {
    const a = this.active();
    if (a?.id === rolloutId) return a;
    if (a) throw new Error(`${CONFLICT}: rollout ${a.id} of ${a.version} is still in progress`);
    if (!this.sql.exec("SELECT 1 FROM versions WHERE id = ?", version).toArray().length) throw new Error(`${NOT_FOUND}: no version ${version}`);
    const stable = this.stable();
    if (version === stable) throw new Error(`${CONFLICT}: ${version} is already stable`);
    this.sql.exec(
      "INSERT INTO active (id, version, from_version, plan, status, stage, colos, started_at) VALUES (?, ?, ?, ?, 'running', -1, '[]', ?)",
      rolloutId, version, stable!, JSON.stringify(plan), Date.now(),
    );
    await this.publish({ kind: "started", detail: `rolling out ${version} over ${stable}`, rollout: rolloutId }, () => this.projectActive());
    return this.active()!;
  }

  private require(rolloutId: string): ActiveRollout {
    const a = this.active();
    if (a?.id !== rolloutId) throw new Error(`${CONFLICT}: rollout ${rolloutId} is no longer in progress`);
    return a;
  }

  async assign(rolloutId: string, stage: number, colos: string[], label: string): Promise<void> {
    const a = this.require(rolloutId);
    if (a.stage === stage) return;
    this.sql.exec("UPDATE active SET stage = ?, colos = ?, status = 'running' WHERE id = ?", stage, JSON.stringify(colos), rolloutId);
    await this.publish({ kind: "stage", detail: `${label}: ${a.version} on ${colos.length} colos`, rollout: rolloutId }, () => this.projectActive());
  }

  async waiting(rolloutId: string, label: string): Promise<void> {
    this.require(rolloutId);
    this.sql.exec("UPDATE active SET status = 'waiting_for_approval' WHERE id = ?", rolloutId);
    await this.publish({ kind: "approval", detail: `waiting for a yes before ${label}`, rollout: rolloutId }, () => this.projectActive());
  }

  async finish(rolloutId: string): Promise<void> {
    const a = this.require(rolloutId);
    this.sql.exec("UPDATE meta SET v = ? WHERE k = 'stable'", a.version);
    this.sql.exec("DELETE FROM active");
    await this.publish({ kind: "completed", detail: `${a.version} is stable everywhere`, rollout: rolloutId }, () =>
      this.env.DB.prepare("UPDATE rollouts SET status = 'completed', ended_at = ? WHERE id = ?").bind(Date.now(), rolloutId),
    );
  }
}

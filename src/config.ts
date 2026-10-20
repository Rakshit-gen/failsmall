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
}

-- D1 is the read model for the console and the API. Each config key's
-- Durable Object owns its versions and its active rollout and writes
-- here after every change.

CREATE TABLE versions (
  key TEXT NOT NULL,
  id TEXT NOT NULL,             -- content hash of the canonical document
  doc TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, id)
);

CREATE TABLE keys (
  key TEXT PRIMARY KEY,
  stable TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rollouts (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  from_version TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_for_approval', 'completed', 'rolled_back')),
  stage INTEGER NOT NULL DEFAULT -1,
  colos TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX rollouts_by_key ON rollouts (key, started_at DESC);

-- One row per health check during a stage's bake.
CREATE TABLE checks (
  rollout_id TEXT NOT NULL,
  stage INTEGER NOT NULL,
  n INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'insufficient', 'hold', 'watching')),
  reasons TEXT NOT NULL,
  stats TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (rollout_id, stage, n)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  rollout_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX events_at ON events (at DESC);

-- Demo only: regressions the telemetry simulator adds to colos running a
-- version (or every colo, when version is null).
CREATE TABLE faults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  version TEXT,
  region TEXT,
  error_rate REAL NOT NULL DEFAULT 0,
  latency_ms REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);

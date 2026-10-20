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

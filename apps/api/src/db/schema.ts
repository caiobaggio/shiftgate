export const SCHEMA = `
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  aws_region TEXT NOT NULL,
  aws_instance_id TEXT NOT NULL UNIQUE,
  has_elastic_ip INTEGER NOT NULL,
  origin_host TEXT,
  power TEXT NOT NULL,
  phase TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  idle_minutes INTEGER NOT NULL,
  automation TEXT NOT NULL DEFAULT 'observe'
    CHECK (automation IN ('observe', 'enforce')),
  override_hold TEXT,
  block_instance_stop INTEGER NOT NULL DEFAULT 1,
  block_reason TEXT,
  instance_stop_enabled INTEGER NOT NULL DEFAULT 0,
  start_timeout_sec INTEGER NOT NULL DEFAULT 180,
  health_interval_sec INTEGER NOT NULL DEFAULT 5,
  min_runtime_sec INTEGER NOT NULL DEFAULT 900,
  min_off_sec INTEGER NOT NULL DEFAULT 120,
  quiesce_sec INTEGER NOT NULL DEFAULT 60,
  phase_changed_at TEXT NOT NULL,
  power_changed_at TEXT NOT NULL,
  healthy_at TEXT,
  last_user_request_at TEXT,
  became_healthy_at TEXT,
  last_off_at TEXT,
  last_discover_at TEXT,
  ssm_online_at TEXT,
  start_attempts INTEGER NOT NULL DEFAULT 0,
  flap_window_started_at TEXT,
  flap_count INTEGER NOT NULL DEFAULT 0,
  holiday_calendar_id TEXT,
  created_at TEXT NOT NULL,
  deactivated_at TEXT,
  wake_deadline_at TEXT,
  drain_started_at TEXT,
  wake_started_at TEXT,
  last_discover_json TEXT,
  last_intention TEXT,
  ssm_nudged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE hostnames (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  hostname TEXT NOT NULL UNIQUE,
  health_url TEXT NOT NULL,
  wake_paths_json TEXT NOT NULL,
  idle_ignore_paths_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_health_at TEXT,
  last_health_ok INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workloads (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('pm2', 'systemd', 'docker', 'node')),
  unit_name TEXT NOT NULL,
  port INTEGER,
  hostname_id TEXT REFERENCES hostnames(id),
  created_at TEXT NOT NULL
);

CREATE TABLE schedule_windows (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  include_holidays INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE overrides (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  hold TEXT NOT NULL CHECK (hold IN ('on', 'off')),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cleared_at TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  instance_id TEXT,
  hostname TEXT,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_phase TEXT,
  to_phase TEXT,
  reason TEXT,
  idempotency_key TEXT,
  aws_request_id TEXT,
  detail_json TEXT
);

CREATE UNIQUE INDEX events_idem
  ON events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX events_instance_at ON events(instance_id, at DESC);

CREATE TABLE instance_locks (
  instance_id TEXT PRIMARY KEY REFERENCES instances(id),
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'auditor')),
  disabled_at TEXT
);

CREATE TABLE edge_reports (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_id TEXT,
  path TEXT,
  method TEXT
);

CREATE INDEX edge_reports_instance_at ON edge_reports(instance_id, at);

CREATE TABLE holidays (
  calendar_id TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (calendar_id, day)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE idempotency (
  actor_id TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, key)
);

CREATE TABLE mutations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE infra_allow (
  instance_id TEXT NOT NULL REFERENCES instances(id),
  name TEXT NOT NULL,
  PRIMARY KEY (instance_id, name)
);

CREATE TABLE alarm_sent (
  instance_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, name)
);
`;

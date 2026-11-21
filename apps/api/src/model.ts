import type { InstanceDetail, InstanceSummary, Phase, Power } from "../../../packages/contracts/src/index.ts";
import { HEALTH_FRESH_MS, LOCK_TTL_MS, type Snapshot } from "./domain/types.ts";
import { summarizeWindows } from "./domain/schedule.ts";
import { evaluateStop } from "./domain/stop-gate.ts";
import { reconcile } from "./domain/reconcile.ts";
import type { DB, SqlRow } from "./db/index.ts";
import { asBool, iso, parseIso, ulid } from "./util.ts";
import { DEFAULT_IDLE_IGNORE } from "./domain/paths.ts";

export interface InstanceRow extends SqlRow {
  id: string;
  slug: string;
  display_name: string;
  aws_region: string;
  aws_instance_id: string;
  has_elastic_ip: number;
  origin_host: string | null;
  power: Power;
  phase: Phase;
  timezone: string;
  idle_minutes: number;
  automation: "observe" | "enforce";
  override_hold: string | null;
  block_instance_stop: number;
  block_reason: string | null;
  instance_stop_enabled: number;
  start_timeout_sec: number;
  health_interval_sec: number;
  min_runtime_sec: number;
  min_off_sec: number;
  quiesce_sec: number;
  phase_changed_at: string;
  power_changed_at: string;
  healthy_at: string | null;
  last_user_request_at: string | null;
  became_healthy_at: string | null;
  last_off_at: string | null;
  last_discover_at: string | null;
  ssm_online_at: string | null;
  start_attempts: number;
  flap_window_started_at: string | null;
  flap_count: number;
  created_at: string;
  deactivated_at: string | null;
  wake_deadline_at: string | null;
  drain_started_at: string | null;
  wake_started_at: string | null;
  last_discover_json: string | null;
  last_intention: "start" | "stop" | null;
  ssm_nudged: number;
}

export interface HostRow extends SqlRow {
  id: string;
  instance_id: string;
  hostname: string;
  health_url: string;
  wake_paths_json: string;
  idle_ignore_paths_json: string;
  created_at: string;
  last_health_at: string | null;
  last_health_ok: number;
}

export interface WorkloadRow extends SqlRow {
  id: string;
  instance_id: string;
  slug: string;
  display_name: string;
  runtime: "pm2" | "systemd" | "docker" | "node";
  unit_name: string;
  port: number | null;
  hostname_id: string | null;
  created_at: string;
}

export interface WindowRow extends SqlRow {
  id: string;
  instance_id: string;
  weekday: number;
  start_local: string;
  end_local: string;
}

export interface OverrideRow extends SqlRow {
  id: string;
  instance_id: string;
  hold: "on" | "off";
  reason: string;
  actor_id: string;
  starts_at: string;
  expires_at: string;
  cleared_at: string | null;
}

export interface Bundle {
  row: InstanceRow;
  hosts: HostRow[];
  workloads: WorkloadRow[];
  windows: WindowRow[];
  infra: string[];
  override: OverrideRow | null;
}

export function jsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function findInstance(db: DB, slug: string): InstanceRow | undefined {
  return db.get<InstanceRow>("SELECT * FROM instances WHERE slug = ?", slug);
}

export function findInstanceByAws(db: DB, instanceId: string): InstanceRow | undefined {
  return db.get<InstanceRow>("SELECT * FROM instances WHERE aws_instance_id = ?", instanceId);
}

export function loadBundle(db: DB, slugOrId: string): Bundle | null {
  const row =
    db.get<InstanceRow>("SELECT * FROM instances WHERE slug = ?", slugOrId) ??
    db.get<InstanceRow>("SELECT * FROM instances WHERE id = ?", slugOrId);
  if (!row) return null;
  const hosts = db.all<HostRow>("SELECT * FROM hostnames WHERE instance_id = ? ORDER BY hostname", row.id);
  const workloads = db.all<WorkloadRow>("SELECT * FROM workloads WHERE instance_id = ? ORDER BY slug", row.id);
  const windows = db.all<WindowRow>(
    "SELECT * FROM schedule_windows WHERE instance_id = ? ORDER BY weekday, start_local",
    row.id,
  );
  const infra = db
    .all<SqlRow>("SELECT name FROM infra_allow WHERE instance_id = ? ORDER BY name", row.id)
    .map((item) => String(item.name));
  const override =
    db.get<OverrideRow>(
      "SELECT * FROM overrides WHERE instance_id = ? AND cleared_at IS NULL ORDER BY expires_at DESC LIMIT 1",
      row.id,
    ) ?? null;
  return { row, hosts, workloads, windows, infra, override };
}

export function findHost(db: DB, hostname: string): { host: HostRow; bundle: Bundle } | null {
  const host = db.get<HostRow>("SELECT * FROM hostnames WHERE hostname = ?", hostname.toLowerCase());
  if (!host) return null;
  const bundle = loadBundle(db, host.instance_id);
  if (!bundle) return null;
  return { host, bundle };
}

export function toSnapshot(bundle: Bundle, now: Date): Snapshot {
  const { row, hosts, windows, override } = bundle;
  const active =
    override && !override.cleared_at && (parseIso(override.expires_at)?.getTime() ?? 0) > now.getTime()
      ? override
      : null;
  const anyHealthy = hosts.some((host) => {
    if (!asBool(host.last_health_ok)) return false;
    const at = parseIso(host.last_health_at);
    return at !== null && now.getTime() - at.getTime() < HEALTH_FRESH_MS;
  });
  return {
    id: row.id,
    slug: row.slug,
    awsInstanceId: row.aws_instance_id,
    timezone: row.timezone,
    idleMinutes: row.idle_minutes,
    automation: row.automation,
    blockInstanceStop: asBool(row.block_instance_stop),
    instanceStopEnabled: asBool(row.instance_stop_enabled),
    startTimeoutSec: row.start_timeout_sec,
    minRuntimeSec: row.min_runtime_sec,
    minOffSec: row.min_off_sec,
    quiesceSec: row.quiesce_sec,
    deactivated: row.deactivated_at !== null,
    windows: windows.map((window) => ({
      weekday: window.weekday,
      startLocal: window.start_local,
      endLocal: window.end_local,
    })),
    phase: row.phase,
    power: row.power,
    phaseChangedAt: parseIso(row.phase_changed_at) ?? now,
    powerChangedAt: parseIso(row.power_changed_at) ?? now,
    healthyAt: parseIso(row.healthy_at),
    becameHealthyAt: parseIso(row.became_healthy_at),
    lastUserRequestAt: parseIso(row.last_user_request_at),
    lastOffAt: parseIso(row.last_off_at),
    startAttempts: row.start_attempts,
    flapWindowStartedAt: parseIso(row.flap_window_started_at),
    flapCount: row.flap_count,
    override: active
      ? { id: active.id, hold: active.hold, expiresAt: parseIso(active.expires_at) ?? now }
      : null,
    drainStartedAt: parseIso(row.drain_started_at),
    wakeStartedAt: parseIso(row.wake_started_at),
    hasElasticIp: asBool(row.has_elastic_ip),
    anyHealthy,
    hostnameCount: hosts.length,
    ssmNudged: asBool(row.ssm_nudged),
  };
}

export function recordEvent(
  db: DB,
  event: {
    instanceId?: string | null;
    hostname?: string | null;
    at: Date;
    actorType: string;
    actorId: string;
    action: string;
    fromPhase?: string | null;
    toPhase?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
    awsRequestId?: string | null;
    detail?: Record<string, unknown> | null;
    zone?: string;
  },
): string {
  const id = ulid(event.at.getTime());
  db.run(
    `INSERT INTO events (
      id, instance_id, hostname, at, actor_type, actor_id, action, from_phase, to_phase,
      reason, idempotency_key, aws_request_id, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    event.instanceId ?? null,
    event.hostname ?? null,
    iso(event.at, event.zone),
    event.actorType,
    event.actorId,
    event.action,
    event.fromPhase ?? null,
    event.toPhase ?? null,
    event.reason ?? null,
    event.idempotencyKey ?? null,
    event.awsRequestId ?? null,
    event.detail ? JSON.stringify(event.detail) : null,
  );
  return id;
}

const PATCHABLE = new Set([
  "display_name",
  "aws_region",
  "aws_instance_id",
  "has_elastic_ip",
  "origin_host",
  "power",
  "phase",
  "timezone",
  "idle_minutes",
  "automation",
  "override_hold",
  "block_instance_stop",
  "block_reason",
  "instance_stop_enabled",
  "start_timeout_sec",
  "health_interval_sec",
  "min_runtime_sec",
  "min_off_sec",
  "quiesce_sec",
  "phase_changed_at",
  "power_changed_at",
  "healthy_at",
  "last_user_request_at",
  "became_healthy_at",
  "last_off_at",
  "last_discover_at",
  "ssm_online_at",
  "start_attempts",
  "flap_window_started_at",
  "flap_count",
  "deactivated_at",
  "wake_deadline_at",
  "drain_started_at",
  "wake_started_at",
  "last_discover_json",
  "last_intention",
  "ssm_nudged",
]);

export function patchInstance(db: DB, id: string, patch: Record<string, string | number | null>): void {
  const keys = Object.keys(patch).filter((key) => PATCHABLE.has(key));
  if (keys.length === 0) return;
  db.run(
    `UPDATE instances SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`,
    ...keys.map((key) => patch[key]),
    id,
  );
}

export function tryLock(db: DB, instanceId: string, owner: string, now: Date, zone: string): boolean {
  const expires = iso(new Date(now.getTime() + LOCK_TTL_MS), zone);
  const stamp = iso(now, zone);
  const existing = db.get<SqlRow>("SELECT owner, expires_at FROM instance_locks WHERE instance_id = ?", instanceId);
  if (!existing) {
    db.run(
      "INSERT INTO instance_locks (instance_id, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
      instanceId,
      owner,
      stamp,
      expires,
    );
    return true;
  }
  if (existing.owner === owner) {
    db.run("UPDATE instance_locks SET expires_at = ? WHERE instance_id = ?", expires, instanceId);
    return true;
  }
  const expiry = parseIso(String(existing.expires_at));
  if (expiry && expiry.getTime() < now.getTime()) {
    const changes = db.run(
      "UPDATE instance_locks SET owner = ?, acquired_at = ?, expires_at = ? WHERE instance_id = ? AND expires_at = ?",
      owner,
      stamp,
      expires,
      instanceId,
      existing.expires_at,
    );
    if (changes > 0) {
      recordEvent(db, {
        instanceId,
        at: now,
        actorType: "system",
        actorId: owner,
        action: "lock_stolen",
        reason: String(existing.owner),
        zone,
      });
      return true;
    }
  }
  return false;
}

export function releaseLock(db: DB, instanceId: string, owner?: string): void {
  if (owner) db.run("DELETE FROM instance_locks WHERE instance_id = ? AND owner = ?", instanceId, owner);
  else db.run("DELETE FROM instance_locks WHERE instance_id = ?", instanceId);
}

export function renewLock(db: DB, instanceId: string, now: Date, zone: string): void {
  const existing = db.get<SqlRow>("SELECT expires_at FROM instance_locks WHERE instance_id = ?", instanceId);
  if (!existing) return;
  const expiry = parseIso(String(existing.expires_at));
  if (!expiry || expiry.getTime() < now.getTime()) return;
  db.run(
    "UPDATE instance_locks SET expires_at = ? WHERE instance_id = ?",
    iso(new Date(now.getTime() + LOCK_TTL_MS), zone),
    instanceId,
  );
}

export function countWakeStarts(db: DB, instanceId: string, since: Date, zone: string): number {
  const row = db.get<SqlRow>(
    "SELECT COUNT(*) AS n FROM events WHERE instance_id = ? AND action = 'aws_start_called' AND reason = 'wake' AND at >= ?",
    instanceId,
    iso(since, zone),
  );
  return Number(row?.n ?? 0);
}

export function present(bundle: Bundle, now: Date, skewMs: number, controlPlaneId: string | null): InstanceDetail {
  const snapshot = toSnapshot(bundle, now);
  const gate = evaluateStop(snapshot, now, skewMs, controlPlaneId);
  const live = reconcile(snapshot, {
    now,
    skewMs,
    controlPlaneInstanceId: controlPlaneId,
    describedPower: null,
    mode: "full",
  });
  const summary = summarizeWindows(snapshot.windows);
  const discover = parseDiscover(bundle.row.last_discover_json);
  const base: InstanceSummary = {
    slug: bundle.row.slug,
    display_name: bundle.row.display_name,
    aws_instance_id: bundle.row.aws_instance_id,
    aws_region: bundle.row.aws_region,
    power: shownPower(bundle.row.power, asBool(bundle.row.block_instance_stop)),
    phase: bundle.row.phase,
    schedule_summary: summary,
    idle_minutes: bundle.row.idle_minutes,
    has_elastic_ip: asBool(bundle.row.has_elastic_ip),
    active: bundle.row.deactivated_at === null,
    automation: bundle.row.automation,
    block_instance_stop: asBool(bundle.row.block_instance_stop),
    intention: live.intention,
  };
  const hostById = new Map(bundle.hosts.map((host) => [host.id, host.hostname]));
  return {
    ...base,
    id: bundle.row.id,
    origin_host: bundle.row.origin_host,
    timezone: bundle.row.timezone,
    block_reason: bundle.row.block_reason,
    instance_stop_enabled: asBool(bundle.row.instance_stop_enabled),
    start_timeout_sec: bundle.row.start_timeout_sec,
    health_interval_sec: bundle.row.health_interval_sec,
    min_runtime_sec: bundle.row.min_runtime_sec,
    min_off_sec: bundle.row.min_off_sec,
    quiesce_sec: bundle.row.quiesce_sec,
    windows: bundle.windows.map((window) => ({
      weekday: window.weekday,
      start_local: window.start_local,
      end_local: window.end_local,
    })),
    hostnames: bundle.hosts.map((host) => ({
      hostname: host.hostname,
      health_url: host.health_url,
      wake_paths: jsonList(host.wake_paths_json),
      idle_ignore_paths: jsonList(host.idle_ignore_paths_json),
      last_health_ok: asBool(host.last_health_ok),
      last_health_at: host.last_health_at,
    })),
    workloads: bundle.workloads.map((workload) => ({
      slug: workload.slug,
      display_name: workload.display_name,
      runtime: workload.runtime,
      unit_name: workload.unit_name,
      port: workload.port,
      hostname: workload.hostname_id ? (hostById.get(workload.hostname_id) ?? null) : null,
    })),
    override:
      snapshot.override && bundle.override
        ? {
            hold: bundle.override.hold,
            reason: bundle.override.reason,
            starts_at: bundle.override.starts_at,
            expires_at: bundle.override.expires_at,
          }
        : null,
    discover,
    stop_gate: { code: gate.call ? null : gate.code, message: gate.call ? "A política deixaria StopInstances sair." : gate.message },
    infra: bundle.infra,
    phase_changed_at: bundle.row.phase_changed_at,
    power_changed_at: bundle.row.power_changed_at,
    last_user_request_at: bundle.row.last_user_request_at,
    healthy_at: bundle.row.healthy_at,
    deactivated_at: bundle.row.deactivated_at,
  };
}

function shownPower(power: Power, blocked: boolean): Power {
  if (blocked && (power === "running" || power === "blocked")) return "blocked";
  if (!blocked && power === "blocked") return "running";
  return power;
}

function parseDiscover(raw: string | null): InstanceDetail["discover"] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as InstanceDetail["discover"];
    if (!parsed || typeof parsed !== "object" || !parsed.at) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function detailOf(db: DB, slug: string, now: Date, skewMs: number, controlPlaneId: string | null): InstanceDetail | null {
  const bundle = loadBundle(db, slug);
  if (!bundle) return null;
  return present(bundle, now, skewMs, controlPlaneId);
}

export { DEFAULT_IDLE_IGNORE };

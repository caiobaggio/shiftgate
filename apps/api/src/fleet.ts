import type { InstanceDetail, Phase, Power } from "../../../packages/contracts/src/index.ts";
import { MapHealth } from "./cloud/health.ts";
import { tagProblem, type AwsPower } from "./cloud/types.ts";
import type { Actor, Deps } from "./deps.ts";
import { classifyDiscover, type ObservedInventory } from "./domain/discover.ts";
import { DEFAULT_IDLE_IGNORE, DEFAULT_INFRA, DEFAULT_WAKE_PATHS, DEFAULT_WEEKDAY_SHIFT } from "./domain/paths.ts";
import { isInShift } from "./domain/schedule.ts";
import { SKEW_LIMIT_MS, type Window } from "./domain/types.ts";
import { publicCode, stopMessage } from "./domain/messages.ts";
import { httpError } from "./http/errors.ts";
import {
  detailOf,
  findInstance,
  findInstanceByAws,
  loadBundle,
  patchInstance,
  recordEvent,
  releaseLock,
  tryLock,
  type Bundle,
  type HostRow,
} from "./model.ts";
import { iso, ulid } from "./util.ts";

export interface HostnameInput {
  hostname: string;
  health_url: string;
  wake_paths: string[];
  idle_ignore_paths?: string[];
}

export interface WorkloadInput {
  slug: string;
  display_name: string;
  runtime: "pm2" | "systemd" | "docker" | "node";
  unit_name: string;
  port?: number | null;
  hostname?: string | null;
}

export interface CreateInput {
  display_name: string;
  slug: string;
  aws_region: string;
  aws_instance_id: string;
  has_elastic_ip: boolean;
  origin_host?: string | null;
  idle_minutes: number;
  timezone?: string;
  hostnames: HostnameInput[];
  schedules: Array<{ weekday: number; start_local: string; end_local: string }>;
}

function assertRole(actor: Actor, roles: Actor["role"][]): void {
  if (!roles.includes(actor.role)) throw httpError(403, "forbidden", "Papel sem permissão para esta ação.");
}

function mustBundle(deps: Deps, slug: string): Bundle {
  const bundle = loadBundle(deps.db, slug);
  if (!bundle) throw httpError(404, "not_found", "EC2 não encontrada.");
  return bundle;
}

function view(deps: Deps, slug: string): InstanceDetail {
  const detail = detailOf(deps.db, slug, deps.clock.now(), deps.clock.skewMs(), deps.config.controlPlaneInstanceId || null);
  if (!detail) throw httpError(404, "not_found", "EC2 não encontrada.");
  return detail;
}

function guardControl(deps: Deps, instanceId: string): void {
  if (deps.config.controlPlaneInstanceId && instanceId === deps.config.controlPlaneInstanceId) {
    throw httpError(409, "control_plane_protected", "Esta instância é o plano de controle.");
  }
}

async function requireDescribed(deps: Deps, region: string, instanceId: string) {
  let described;
  try {
    described = await deps.cloud.describeInstance(region, instanceId);
  } catch {
    throw httpError(409, "tag_mismatch", "O describe não respondeu.");
  }
  if (!described) throw httpError(409, "tag_mismatch", "O describe não devolveu essa instância.");
  return described;
}

function guardTags(described: { tags: Record<string, string>; instanceId: string; region: string; state: string; power: AwsPower; publicIp: string | null }, slug: string): void {
  const problem = tagProblem(described, slug);
  if (problem) throw httpError(409, "tag_mismatch", `Tag divergente (${problem}). Start e stop não saíram.`);
}

function windowsOf(schedules: CreateInput["schedules"]): Window[] {
  return schedules.map((item) => ({ weekday: item.weekday, startLocal: item.start_local, endLocal: item.end_local }));
}

export async function probeHost(
  deps: Deps,
  host: HostRow,
  power: AwsPower | null,
  originHost?: string | null,
  timeoutMs = 4000,
): Promise<boolean> {
  if (deps.health instanceof MapHealth && deps.health.urls.has(host.health_url)) {
    return deps.health.check(host.health_url);
  }
  if (deps.config.fakeHealthFollowsPower && power === "running") return true;
  const target = deps.config.awsAdapter === "ec2" && originHost && isIpv4(originHost)
    ? { address: originHost, timeoutMs }
    : { timeoutMs };
  return deps.health.check(host.health_url, target);
}

function isIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function initialPhase(power: AwsPower, healthy: boolean, inShift: boolean): Phase {
  if (power === "stopped") return "off";
  if (power === "stopping") return "stopping";
  if (power === "error") return "error";
  if (power === "starting" || !healthy) return "starting";
  return inShift ? "schedule_hold" : "on";
}

export async function createInstance(deps: Deps, actor: Actor, input: CreateInput): Promise<InstanceDetail> {
  assertRole(actor, ["admin"]);
  guardControl(deps, input.aws_instance_id);
  if (findInstance(deps.db, input.slug)) throw httpError(409, "validation", "Já existe EC2 com esse slug.");
  if (findInstanceByAws(deps.db, input.aws_instance_id)) {
    throw httpError(409, "validation", "Esse instance id já está no cadastro.");
  }
  const described = await requireDescribed(deps, input.aws_region, input.aws_instance_id);
  guardTags(described, input.slug);
  const now = deps.clock.now();
  const zone = input.timezone || "America/Sao_Paulo";
  const schedules = input.schedules.length ? input.schedules : DEFAULT_WEEKDAY_SHIFT;
  const inWindow = isInShift(now, windowsOf(schedules), zone);
  const id = ulid(now.getTime());
  const stamp = iso(now, zone);
  const hostIds: string[] = [];
  let anyHealthy = false;
  const prepared = input.hostnames.map((host) => {
    const hostname = host.hostname.toLowerCase();
    const existing = deps.db.get("SELECT instance_id FROM hostnames WHERE hostname = ?", hostname);
    if (existing) throw httpError(409, "validation", `O hostname ${hostname} já está em outra EC2.`);
    return { ...host, hostname, id: ulid() };
  });

  deps.db.transaction(() => {
    deps.db.run(
      `INSERT INTO instances (
        id, slug, display_name, aws_region, aws_instance_id, has_elastic_ip, origin_host,
        power, phase, timezone, idle_minutes, automation, block_instance_stop, instance_stop_enabled,
        phase_changed_at, power_changed_at, created_at, start_attempts, flap_count, ssm_nudged,
        healthy_at, became_healthy_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enforce', 1, 1, ?, ?, ?, 0, 0, 0, NULL, NULL)`,
      id,
      input.slug,
      input.display_name,
      input.aws_region,
      input.aws_instance_id,
      input.has_elastic_ip ? 1 : 0,
      input.origin_host ?? described.publicIp,
      described.power,
      "off",
      zone,
      input.idle_minutes,
      stamp,
      stamp,
      stamp,
    );
    for (const name of DEFAULT_INFRA) {
      deps.db.run("INSERT INTO infra_allow (instance_id, name) VALUES (?, ?)", id, name);
    }
    for (const host of prepared) {
      deps.db.run(
        `INSERT INTO hostnames (
          id, instance_id, hostname, health_url, wake_paths_json, idle_ignore_paths_json, created_at, last_health_ok
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        host.id,
        id,
        host.hostname,
        host.health_url,
        JSON.stringify(host.wake_paths.length ? host.wake_paths : DEFAULT_WAKE_PATHS),
        JSON.stringify(host.idle_ignore_paths?.length ? host.idle_ignore_paths : DEFAULT_IDLE_IGNORE),
        stamp,
      );
      hostIds.push(host.id);
    }
    for (const window of schedules) {
      deps.db.run(
        "INSERT INTO schedule_windows (id, instance_id, weekday, start_local, end_local, include_holidays) VALUES (?, ?, ?, ?, ?, 0)",
        ulid(),
        id,
        window.weekday,
        window.start_local,
        window.end_local,
      );
    }
    recordEvent(deps.db, {
      instanceId: id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "register_instance",
      toPhase: "off",
      reason: input.slug,
      zone,
      detail: { aws_instance_id: input.aws_instance_id, region: input.aws_region },
    });
  });

  for (const hostId of hostIds) {
    const host = deps.db.get<HostRow>("SELECT * FROM hostnames WHERE id = ?", hostId);
    if (!host) continue;
    const ok = await probeHost(deps, host, described.power, input.origin_host ?? described.publicIp);
    if (ok) anyHealthy = true;
    deps.db.run(
      "UPDATE hostnames SET last_health_ok = ?, last_health_at = ? WHERE id = ?",
      ok ? 1 : 0,
      stamp,
      hostId,
    );
  }
  const phase = initialPhase(described.power, anyHealthy, inWindow);
  patchInstance(deps.db, id, {
    phase,
    healthy_at: anyHealthy ? stamp : null,
    became_healthy_at: anyHealthy ? stamp : null,
    phase_changed_at: stamp,
  });
  return view(deps, input.slug);
}

export async function updateIdentity(
  deps: Deps,
  actor: Actor,
  slug: string,
  patch: { display_name?: string; aws_region?: string; has_elastic_ip?: boolean; origin_host?: string | null; aws_instance_id?: string },
): Promise<InstanceDetail> {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  const now = deps.clock.now();
  const region = patch.aws_region ?? bundle.row.aws_region;
  const instanceId = patch.aws_instance_id ?? bundle.row.aws_instance_id;
  if (patch.aws_instance_id && patch.aws_instance_id !== bundle.row.aws_instance_id) {
    guardControl(deps, patch.aws_instance_id);
    if (findInstanceByAws(deps.db, patch.aws_instance_id)) throw httpError(409, "validation", "Instance id já cadastrado.");
    const described = await requireDescribed(deps, region, patch.aws_instance_id);
    guardTags(described, slug);
  }
  patchInstance(deps.db, bundle.row.id, {
    display_name: patch.display_name ?? bundle.row.display_name,
    aws_region: region,
    aws_instance_id: instanceId,
    has_elastic_ip: patch.has_elastic_ip === undefined ? bundle.row.has_elastic_ip : patch.has_elastic_ip ? 1 : 0,
    origin_host: patch.origin_host === undefined ? bundle.row.origin_host : patch.origin_host,
  });
  recordEvent(deps.db, {
    instanceId: bundle.row.id,
    at: now,
    actorType: "operator",
    actorId: actor.id,
    action: "instance_updated",
    zone: bundle.row.timezone,
  });
  return view(deps, slug);
}

export function replaceSchedules(
  deps: Deps,
  actor: Actor,
  slug: string,
  input: { timezone?: string; windows: CreateInput["schedules"] },
): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  const now = deps.clock.now();
  deps.db.transaction(() => {
    deps.db.run("DELETE FROM schedule_windows WHERE instance_id = ?", bundle.row.id);
    for (const window of input.windows) {
      deps.db.run(
        "INSERT INTO schedule_windows (id, instance_id, weekday, start_local, end_local, include_holidays) VALUES (?, ?, ?, ?, ?, 0)",
        ulid(),
        bundle.row.id,
        window.weekday,
        window.start_local,
        window.end_local,
      );
    }
    if (input.timezone) patchInstance(deps.db, bundle.row.id, { timezone: input.timezone });
    const zone = input.timezone ?? bundle.row.timezone;
    const settled = bundle.row.phase === "on" || bundle.row.phase === "schedule_hold";
    const up = bundle.row.power === "running" || bundle.row.power === "blocked";
    if (settled && up) {
      const next = isInShift(now, windowsOf(input.windows), zone) ? "schedule_hold" : "on";
      if (next !== bundle.row.phase) {
        patchInstance(deps.db, bundle.row.id, { phase: next, phase_changed_at: iso(now, zone) });
        recordEvent(deps.db, {
          instanceId: bundle.row.id,
          at: now,
          actorType: "operator",
          actorId: actor.id,
          action: "phase_changed",
          fromPhase: bundle.row.phase,
          toPhase: next,
          reason: next === "schedule_hold" ? "entrou no turno" : "turno acabou",
          zone,
        });
      }
    }
    recordEvent(deps.db, {
      instanceId: bundle.row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "schedule_upsert",
      zone: input.timezone ?? bundle.row.timezone,
      detail: { windows: input.windows.length },
    });
  });
  return view(deps, slug);
}

export function updateIdle(deps: Deps, actor: Actor, slug: string, idleMinutes: number): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  patchInstance(deps.db, bundle.row.id, { idle_minutes: idleMinutes });
  recordEvent(deps.db, {
    instanceId: bundle.row.id,
    at: deps.clock.now(),
    actorType: "operator",
    actorId: actor.id,
    action: "idle_updated",
    reason: String(idleMinutes),
    zone: bundle.row.timezone,
  });
  return view(deps, slug);
}

export function replaceHostnames(deps: Deps, actor: Actor, slug: string, hosts: HostnameInput[]): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  const now = deps.clock.now();
  const stamp = iso(now, bundle.row.timezone);
  const previous = new Map(bundle.hosts.map((host) => [host.hostname, host]));
  deps.db.transaction(() => {
    const names = hosts.map((host) => host.hostname.toLowerCase());
    for (const name of names) {
      const other = deps.db.get<{ instance_id: string }>("SELECT instance_id FROM hostnames WHERE hostname = ?", name);
      if (other && other.instance_id !== bundle.row.id) {
        throw httpError(409, "validation", `O hostname ${name} já está em outra EC2.`);
      }
    }
    deps.db.run("UPDATE workloads SET hostname_id = NULL WHERE instance_id = ?", bundle.row.id);
    deps.db.run("DELETE FROM hostnames WHERE instance_id = ?", bundle.row.id);
    for (const host of hosts) {
      const hostname = host.hostname.toLowerCase();
      const kept = previous.get(hostname);
      deps.db.run(
        `INSERT INTO hostnames (
          id, instance_id, hostname, health_url, wake_paths_json, idle_ignore_paths_json, created_at, last_health_at, last_health_ok
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ulid(),
        bundle.row.id,
        hostname,
        host.health_url,
        JSON.stringify(host.wake_paths.length ? host.wake_paths : DEFAULT_WAKE_PATHS),
        JSON.stringify(host.idle_ignore_paths?.length ? host.idle_ignore_paths : DEFAULT_IDLE_IGNORE),
        stamp,
        kept?.last_health_at ?? null,
        kept?.last_health_ok ?? 0,
      );
    }
    recordEvent(deps.db, {
      instanceId: bundle.row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "hostnames_replaced",
      zone: bundle.row.timezone,
      detail: { count: hosts.length },
    });
  });
  return view(deps, slug);
}

export function replaceWorkloads(deps: Deps, actor: Actor, slug: string, workloads: WorkloadInput[]): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  const now = deps.clock.now();
  deps.db.transaction(() => {
    deps.db.run("DELETE FROM workloads WHERE instance_id = ?", bundle.row.id);
    for (const workload of workloads) {
      const taken = deps.db.get("SELECT id FROM workloads WHERE slug = ?", workload.slug);
      if (taken) throw httpError(409, "validation", `O workload ${workload.slug} já existe.`);
      const host = workload.hostname
        ? deps.db.get<{ id: string }>(
            "SELECT id FROM hostnames WHERE instance_id = ? AND hostname = ?",
            bundle.row.id,
            workload.hostname.toLowerCase(),
          )
        : undefined;
      deps.db.run(
        `INSERT INTO workloads (id, instance_id, slug, display_name, runtime, unit_name, port, hostname_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ulid(),
        bundle.row.id,
        workload.slug,
        workload.display_name,
        workload.runtime,
        workload.unit_name,
        workload.port ?? null,
        host?.id ?? null,
        iso(now, bundle.row.timezone),
      );
    }
    recordEvent(deps.db, {
      instanceId: bundle.row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "workloads_replaced",
      zone: bundle.row.timezone,
      detail: { count: workloads.length },
    });
  });
  return view(deps, slug);
}

export function replaceInfra(deps: Deps, actor: Actor, slug: string, names: string[]): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  deps.db.transaction(() => {
    deps.db.run("DELETE FROM infra_allow WHERE instance_id = ?", bundle.row.id);
    for (const name of names) {
      deps.db.run("INSERT INTO infra_allow (instance_id, name) VALUES (?, ?)", bundle.row.id, name.trim().toLowerCase());
    }
  });
  return view(deps, slug);
}

export function updatePolicy(
  deps: Deps,
  actor: Actor,
  slug: string,
  input: { automation?: "observe" | "enforce"; instance_stop_enabled?: boolean },
): InstanceDetail & { warning?: string } {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  const patch: Record<string, string | number | null> = {};
  if (input.automation) patch.automation = input.automation;
  if (input.instance_stop_enabled !== undefined) patch.instance_stop_enabled = input.instance_stop_enabled ? 1 : 0;
  patchInstance(deps.db, bundle.row.id, patch);
  recordEvent(deps.db, {
    instanceId: bundle.row.id,
    at: deps.clock.now(),
    actorType: "operator",
    actorId: actor.id,
    action: "instance_updated",
    reason: "policy",
    zone: bundle.row.timezone,
    detail: input,
  });
  const detail = view(deps, slug);
  const warning =
    input.instance_stop_enabled && detail.block_instance_stop
      ? "O discover ainda não está limpo. StopInstances continua bloqueado."
      : undefined;
  return warning ? { ...detail, warning } : detail;
}

export function updateTiming(
  deps: Deps,
  actor: Actor,
  slug: string,
  input: Partial<{
    start_timeout_sec: number;
    health_interval_sec: number;
    min_runtime_sec: number;
    min_off_sec: number;
    quiesce_sec: number;
  }>,
): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  patchInstance(deps.db, bundle.row.id, input);
  return view(deps, slug);
}

export function setActive(deps: Deps, actor: Actor, slug: string, active: boolean, reason: string): InstanceDetail {
  assertRole(actor, ["admin"]);
  const bundle = mustBundle(deps, slug);
  const now = deps.clock.now();
  const stamp = iso(now, bundle.row.timezone);
  patchInstance(deps.db, bundle.row.id, { deactivated_at: active ? null : stamp });
  recordEvent(deps.db, {
    instanceId: bundle.row.id,
    at: now,
    actorType: "operator",
    actorId: actor.id,
    action: active ? "instance_activated" : "instance_deactivated",
    reason,
    zone: bundle.row.timezone,
  });
  return view(deps, slug);
}

export async function requestStart(
  deps: Deps,
  actor: Actor,
  slug: string,
  input: { hold_minutes?: number; reason?: string; confirm_slug?: string },
): Promise<InstanceDetail> {
  assertRole(actor, ["admin", "operator"]);
  const bundle = mustBundle(deps, slug);
  const row = bundle.row;
  guardControl(deps, row.aws_instance_id);
  const now = deps.clock.now();
  if (input.hold_minutes) {
    if (input.confirm_slug !== slug) throw httpError(400, "validation", "Redigite o slug desta EC2.");
    if (!input.reason || input.reason.trim().length < 12) {
      throw httpError(400, "validation", "O motivo precisa de pelo menos 12 caracteres.");
    }
  }
  if (row.automation !== "enforce") {
    const eventId = recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "observe_skipped",
      reason: input.reason ?? "start",
      detail: { would: "aws_start" },
      zone: row.timezone,
    });
    throw httpError(409, "observe_only", "Automação em observação. StartInstances não saiu.", eventId);
  }
  const described = await requireDescribed(deps, row.aws_region, row.aws_instance_id);
  guardTags(described, slug);
  if (input.hold_minutes) {
    const expires = new Date(now.getTime() + input.hold_minutes * 60_000);
    deps.db.transaction(() => {
      deps.db.run("UPDATE overrides SET cleared_at = ? WHERE instance_id = ? AND cleared_at IS NULL", iso(now, row.timezone), row.id);
      deps.db.run(
        `INSERT INTO overrides (id, instance_id, hold, reason, actor_id, starts_at, expires_at) VALUES (?, ?, 'on', ?, ?, ?, ?)`,
        ulid(),
        row.id,
        input.reason!.trim(),
        actor.id,
        iso(now, row.timezone),
        iso(expires, row.timezone),
      );
      patchInstance(deps.db, row.id, {
        override_hold: "on",
        phase: "manual_override",
        phase_changed_at: iso(now, row.timezone),
      });
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "operator",
        actorId: actor.id,
        action: "override_set",
        reason: input.reason,
        toPhase: "manual_override",
        detail: { hold: "on", hold_minutes: input.hold_minutes },
        zone: row.timezone,
      });
    });
  }
  recordEvent(deps.db, {
    instanceId: row.id,
    at: now,
    actorType: "operator",
    actorId: actor.id,
    action: "start_requested",
    reason: input.reason ?? "manual",
    zone: row.timezone,
  });
  if (described.power === "stopped") {
    const owner = `manual:${actor.id}`;
    const locked = deps.db.transaction(() => tryLock(deps.db, row.id, owner, now, row.timezone));
    if (!locked) throw httpError(409, "lock_held", "Outra operação desta EC2 está com o lock.");
    patchInstance(deps.db, row.id, { phase: "waking", wake_started_at: iso(now, row.timezone), phase_changed_at: iso(now, row.timezone) });
    try {
      const started = await deps.cloud.startInstance(row.aws_region, row.aws_instance_id);
      const after = await deps.cloud.describeInstance(row.aws_region, row.aws_instance_id);
      patchInstance(deps.db, row.id, {
        phase: "starting",
        power: after?.power ?? "starting",
        power_changed_at: iso(now, row.timezone),
      });
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "operator",
        actorId: actor.id,
        action: "aws_start_called",
        reason: "manual",
        fromPhase: "waking",
        toPhase: "starting",
        awsRequestId: started.requestId,
        zone: row.timezone,
      });
    } catch (error) {
      patchInstance(deps.db, row.id, {
        phase: "error",
        start_attempts: row.start_attempts + 1,
        phase_changed_at: iso(now, row.timezone),
      });
      releaseLock(deps.db, row.id, owner);
      const eventId = recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "operator",
        actorId: actor.id,
        action: "phase_changed",
        toPhase: "error",
        reason: error instanceof Error ? error.message : "start",
        zone: row.timezone,
      });
      throw httpError(409, "conflict_phase", "StartInstances falhou.", eventId);
    }
  }
  return view(deps, slug);
}

export async function requestStop(
  deps: Deps,
  actor: Actor,
  slug: string,
  input: { hold_minutes?: number; reason: string; confirm_slug: string; emergency?: boolean },
): Promise<InstanceDetail> {
  assertRole(actor, ["admin", "operator"]);
  if (input.confirm_slug !== slug) throw httpError(400, "validation", "Redigite o slug desta EC2.");
  if (input.reason.trim().length < 12) throw httpError(400, "validation", "O motivo precisa de pelo menos 12 caracteres.");
  const bundle = mustBundle(deps, slug);
  const row = bundle.row;
  const now = deps.clock.now();
  if (row.automation !== "enforce") {
    const eventId = recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "observe_skipped",
      reason: input.reason,
      detail: { would: "aws_stop", emergency: Boolean(input.emergency) },
      zone: row.timezone,
    });
    throw httpError(409, "observe_only", "Automação em observação. StopInstances não saiu.", eventId);
  }
  const described = await requireDescribed(deps, row.aws_region, row.aws_instance_id);
  guardTags(described, slug);
  guardControl(deps, row.aws_instance_id);
  if (row.deactivated_at) throw httpError(409, "inactive", "O registro está desativado.");
  if (deps.clock.skewMs() > SKEW_LIMIT_MS) throw httpError(409, "clock_skew", stopMessage("clock_skew"));
  const windows = bundle.windows.map((window) => ({
    weekday: window.weekday,
    startLocal: window.start_local,
    endLocal: window.end_local,
  }));
  const inShift = isInShift(now, windows, row.timezone);
  const holdOff = row.override_hold === "off";
  if ((inShift || row.phase === "schedule_hold") && !input.hold_minutes && !holdOff) {
    const eventId = recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "stop_requested",
      reason: input.reason,
      detail: { refused: "in_shift" },
      zone: row.timezone,
    });
    throw httpError(409, "in_shift", "A EC2 está no turno. Informe a duração do override para furar a janela.", eventId);
  }
  if (row.block_instance_stop) {
    const eventId = recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "unregistered_service",
      reason: row.block_reason,
      zone: row.timezone,
    });
    throw httpError(409, "unregistered_service", stopMessage("unregistered_service"), eventId);
  }
  if (!row.instance_stop_enabled) {
    throw httpError(409, "conflict_phase", stopMessage("stop_disabled"));
  }
  if (input.hold_minutes) {
    const expires = new Date(now.getTime() + input.hold_minutes * 60_000);
    deps.db.transaction(() => {
      deps.db.run("UPDATE overrides SET cleared_at = ? WHERE instance_id = ? AND cleared_at IS NULL", iso(now, row.timezone), row.id);
      deps.db.run(
        "INSERT INTO overrides (id, instance_id, hold, reason, actor_id, starts_at, expires_at) VALUES (?, ?, 'off', ?, ?, ?, ?)",
        ulid(),
        row.id,
        input.reason.trim(),
        actor.id,
        iso(now, row.timezone),
        iso(expires, row.timezone),
      );
      patchInstance(deps.db, row.id, { override_hold: "off", phase: "manual_override", phase_changed_at: iso(now, row.timezone) });
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "operator",
        actorId: actor.id,
        action: "override_set",
        reason: input.reason,
        detail: { hold: "off", hold_minutes: input.hold_minutes },
        zone: row.timezone,
      });
    });
  }
  if (input.emergency && actor.role !== "admin") {
    throw httpError(403, "forbidden", "Stop de emergência é de admin.");
  }
  recordEvent(deps.db, {
    instanceId: row.id,
    at: now,
    actorType: "operator",
    actorId: actor.id,
    action: "stop_requested",
    reason: input.reason,
    detail: { emergency: Boolean(input.emergency) },
    zone: row.timezone,
  });
  if (input.emergency) {
    const owner = `manual:${actor.id}`;
    if (!deps.db.transaction(() => tryLock(deps.db, row.id, owner, now, row.timezone))) {
      throw httpError(409, "lock_held", "Outra operação desta EC2 está com o lock.");
    }
    patchInstance(deps.db, row.id, { phase: "stopping", phase_changed_at: iso(now, row.timezone), drain_started_at: iso(now, row.timezone) });
    try {
      const stopped = await deps.cloud.stopInstance(row.aws_region, row.aws_instance_id);
      patchInstance(deps.db, row.id, { power: "stopping", power_changed_at: iso(now, row.timezone) });
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "operator",
        actorId: actor.id,
        action: "aws_stop_called",
        reason: "emergency",
        awsRequestId: stopped.requestId,
        detail: { emergency: true },
        zone: row.timezone,
      });
    } catch (error) {
      patchInstance(deps.db, row.id, { phase: "error", phase_changed_at: iso(now, row.timezone) });
      releaseLock(deps.db, row.id, owner);
      throw httpError(409, "conflict_phase", error instanceof Error ? error.message : "StopInstances falhou.");
    }
  } else if (described.power === "running") {
    patchInstance(deps.db, row.id, {
      phase: "draining",
      drain_started_at: iso(now, row.timezone),
      phase_changed_at: iso(now, row.timezone),
    });
    recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "operator",
      actorId: actor.id,
      action: "drain_started",
      reason: input.reason,
      toPhase: "draining",
      zone: row.timezone,
    });
    await quiesce(deps, bundle, actor.id);
  }
  return view(deps, slug);
}

export async function discoverInstance(deps: Deps, actor: Actor, slug: string): Promise<InstanceDetail> {
  assertRole(actor, ["admin", "operator"]);
  const bundle = mustBundle(deps, slug);
  await applyDiscover(deps, bundle, actor.id);
  return view(deps, slug);
}

export async function applyDiscover(deps: Deps, bundle: Bundle, actorId: string): Promise<void> {
  const row = bundle.row;
  const now = deps.clock.now();
  const wasClean = !row.block_instance_stop;
  const fail = (reason: string) => {
    const payload = {
      at: iso(now, row.timezone),
      clean: false,
      unknown: { systemd: [], pm2: [], docker: [] },
      error: reason,
    };
    patchInstance(deps.db, row.id, {
      block_instance_stop: 1,
      block_reason: reason,
      last_discover_at: iso(now, row.timezone),
      last_discover_json: JSON.stringify(payload),
      power: row.power === "running" ? "blocked" : row.power,
    });
    recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: actorId === "reconciler" ? "system" : "operator",
      actorId,
      action: "unregistered_service",
      reason,
      zone: row.timezone,
    });
    if (wasClean) void notify(deps, row.slug, row.aws_instance_id, "unregistered_service", reason);
  };
  try {
    const online = await deps.cloud.ssmOnline(row.aws_region, row.aws_instance_id);
    if (!online) {
      fail("SSM offline. Sem inventário, a EC2 não para.");
      return;
    }
    const command = await deps.cloud.sendCommand({
      region: row.aws_region,
      instanceId: row.aws_instance_id,
      action: "status",
      slug: "",
    });
    const result = await deps.cloud.getCommandResult(row.aws_region, command.commandId, row.aws_instance_id);
    recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: actorId === "reconciler" ? "system" : "operator",
      actorId,
      action: "ssm_called",
      reason: "status",
      awsRequestId: command.commandId,
      zone: row.timezone,
    });
    if (result.status !== "Success") {
      fail("O status SSM não completou.");
      return;
    }
    const observed = JSON.parse(result.stdout) as ObservedInventory;
    const inventory: ObservedInventory = {
      systemd: observed.systemd ?? [],
      pm2: observed.pm2 ?? [],
      docker: observed.docker ?? [],
    };
    const infra =
      bundle.infra.length > 0
        ? bundle.infra
        : deps.db.all<{ name: string }>("SELECT name FROM infra_allow WHERE instance_id = ?", row.id).map((item) => item.name);
    const diff = classifyDiscover(
      inventory,
      bundle.workloads.map((workload) => workload.unit_name),
      infra,
    );
    const reason = diff.clean
      ? null
      : `Fora do cadastro: ${[...diff.unknown.systemd, ...diff.unknown.pm2, ...diff.unknown.docker].join(", ")}`;
    patchInstance(deps.db, row.id, {
      block_instance_stop: diff.clean ? 0 : 1,
      block_reason: reason,
      last_discover_at: iso(now, row.timezone),
      last_discover_json: JSON.stringify({ at: iso(now, row.timezone), clean: diff.clean, unknown: diff.unknown }),
      ssm_online_at: iso(now, row.timezone),
      power: !diff.clean && row.power === "running" ? "blocked" : diff.clean && row.power === "blocked" ? "running" : row.power,
    });
    if (!diff.clean) {
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: actorId === "reconciler" ? "system" : "operator",
        actorId,
        action: "unregistered_service",
        reason,
        zone: row.timezone,
        detail: diff.unknown,
      });
      if (wasClean) void notify(deps, row.slug, row.aws_instance_id, "unregistered_service", reason ?? "");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "discover falhou");
  }
}

export async function quiesce(deps: Deps, bundle: Bundle, actorId: string): Promise<void> {
  for (const workload of bundle.workloads) {
    try {
      const command = await deps.cloud.sendCommand({
        region: bundle.row.aws_region,
        instanceId: bundle.row.aws_instance_id,
        action: "stop",
        slug: workload.slug,
      });
      recordEvent(deps.db, {
        instanceId: bundle.row.id,
        at: deps.clock.now(),
        actorType: actorId === "reconciler" ? "system" : "operator",
        actorId,
        action: "ssm_called",
        reason: "stop",
        awsRequestId: command.commandId,
        detail: { slug: workload.slug },
        zone: bundle.row.timezone,
      });
    } catch {
      /* quiesce é melhor esforço; o stop da instância continua no tick se o discover estiver limpo */
    }
  }
}

export async function nudge(deps: Deps, bundle: Bundle): Promise<void> {
  for (const workload of bundle.workloads) {
    try {
      const command = await deps.cloud.sendCommand({
        region: bundle.row.aws_region,
        instanceId: bundle.row.aws_instance_id,
        action: "start",
        slug: workload.slug,
      });
      recordEvent(deps.db, {
        instanceId: bundle.row.id,
        at: deps.clock.now(),
        actorType: "system",
        actorId: "reconciler",
        action: "ssm_called",
        reason: "start",
        awsRequestId: command.commandId,
        detail: { slug: workload.slug },
        zone: bundle.row.timezone,
      });
    } catch {
      /* o health é quem decide se o login libera */
    }
  }
}

const ALARM_GAP_MS = 15 * 60_000;

export async function notify(
  deps: Deps,
  slug: string,
  instanceId: string,
  name: string,
  detail: string,
): Promise<void> {
  const key = name === "clock_skew" ? "clock" : instanceId || slug || name;
  const now = deps.clock.now();
  const previous = deps.db.get<{ sent_at: string }>("SELECT sent_at FROM alarm_sent WHERE instance_id = ? AND name = ?", key, name);
  if (previous) {
    const sent = new Date(previous.sent_at).getTime();
    if (Number.isFinite(sent) && now.getTime() - sent < ALARM_GAP_MS) return;
  }
  deps.db.run(
    `INSERT INTO alarm_sent (instance_id, name, sent_at) VALUES (?, ?, ?)
     ON CONFLICT(instance_id, name) DO UPDATE SET sent_at = excluded.sent_at`,
    key,
    name,
    now.toISOString(),
  );
  if (!deps.config.webhookUrl) return;
  await fetch(deps.config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alarm: name, instance_slug: slug, aws_instance_id: instanceId, at: now.toISOString(), detail }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}

export function listEvents(deps: Deps, slug: string, cursor: string | null, limit: number) {
  const bundle = mustBundle(deps, slug);
  const rows = cursor
    ? deps.db.all(
        `SELECT * FROM events WHERE instance_id = ? AND (at < ? OR (at = ? AND id < ?))
         ORDER BY at DESC, id DESC LIMIT ?`,
        bundle.row.id,
        cursor.split("|")[0],
        cursor.split("|")[0],
        cursor.split("|")[1] ?? "",
        limit,
      )
    : deps.db.all("SELECT * FROM events WHERE instance_id = ? ORDER BY at DESC, id DESC LIMIT ?", bundle.row.id, limit);
  const last = rows[rows.length - 1] as { at?: string; id?: string } | undefined;
  return {
    events: rows.map((row) => ({
      id: row.id,
      at: row.at,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      from_phase: row.from_phase,
      to_phase: row.to_phase,
      reason: row.reason,
      hostname: row.hostname,
      aws_request_id: row.aws_request_id,
      detail: row.detail_json ? safeJson(String(row.detail_json)) : null,
    })),
    next_cursor: rows.length === limit && last?.at && last.id ? `${last.at}|${last.id}` : null,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export { publicCode };

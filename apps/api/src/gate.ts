import type { GateBody } from "../../../packages/contracts/src/index.ts";
import type { Deps } from "./deps.ts";
import { decideAdmit } from "./domain/admit.ts";
import { applyUserTraffic } from "./domain/reconcile.ts";
import { idleIgnored, wakePathAllowed } from "./domain/paths.ts";
import { HEALTH_FRESH_MS } from "./domain/types.ts";
import { findHost, jsonList, loadBundle, patchInstance, recordEvent, releaseLock, toSnapshot, tryLock } from "./model.ts";
import { probeHost } from "./fleet.ts";
import { tickInstance } from "./runner.ts";
import { asBool, iso, parseIso, ulid } from "./util.ts";
import { tagProblem } from "./cloud/types.ts";

export async function admit(deps: Deps, input: { host: string; method: string; path: string; request_id: string }, allowStart = true): Promise<GateBody> {
  const located = findHost(deps.db, input.host);
  const now = deps.clock.now();
  if (!located) {
    const eventId = recordEvent(deps.db, {
      at: now,
      hostname: input.host,
      actorType: "edge",
      actorId: "edge",
      action: "wake_ignored",
      reason: "not_found",
      detail: { path: input.path, method: input.method, request_id: input.request_id },
    });
    return { decision: "closed", phase: null, instance_slug: null, message: "Este endereço não está no cadastro.", code: "not_found", event_id: eventId };
  }

  if (["waking", "starting", "on", "schedule_hold", "draining"].includes(located.bundle.row.phase)) {
    await tickInstance(deps, located.bundle.row.id, "wake");
  }
  const bundle = loadBundle(deps.db, located.bundle.row.id) ?? located.bundle;
  const host = bundle.hosts.find((item) => item.hostname === input.host.toLowerCase()) ?? located.host;
  const described = await deps.cloud.describeInstance(bundle.row.aws_region, bundle.row.aws_instance_id).catch(() => null);
  const power = described?.power ?? null;
  let ok = false;
  if (power === "running") {
    ok = await probeHost(deps, host, power, bundle.row.origin_host, 1500);
    deps.db.run(
      "UPDATE hostnames SET last_health_ok = ?, last_health_at = ? WHERE id = ?",
      ok ? 1 : 0,
      iso(now, bundle.row.timezone),
      host.id,
    );
  }
  const freshBundle = loadBundle(deps.db, bundle.row.id) ?? bundle;
  const snapshot = toSnapshot(freshBundle, now);
  const rules = jsonList(host.wake_paths_json);
  const ignore = jsonList(host.idle_ignore_paths_json);
  const healthAt = parseIso(ok ? iso(now, bundle.row.timezone) : host.last_health_at);
  const healthFresh = ok || (asBool(host.last_health_ok) && healthAt !== null && now.getTime() - healthAt.getTime() < HEALTH_FRESH_MS);
  const decision = decideAdmit({
    snapshot,
    method: input.method,
    path: input.path,
    wakeAllowed: wakePathAllowed(input.method, input.path, rules),
    healthFresh,
    now,
    automaticStartsInLastHour: count(deps, freshBundle.row.id, now, freshBundle.row.timezone),
    allowStart,
  });

  const counts = decision.countsAsUse && !idleIgnored(input.path, ignore);
  if (decision.cancelDrain || counts) {
    const traffic = applyUserTraffic(snapshot, now, counts);
    patchInstance(deps.db, freshBundle.row.id, {
      phase: traffic.phase,
      drain_started_at: traffic.drainStartedAt ? iso(traffic.drainStartedAt, freshBundle.row.timezone) : null,
      last_user_request_at: traffic.lastUserRequestAt ? iso(traffic.lastUserRequestAt, freshBundle.row.timezone) : freshBundle.row.last_user_request_at,
      phase_changed_at: iso(traffic.phaseChangedAt, freshBundle.row.timezone),
    });
    for (const event of traffic.events) {
      recordEvent(deps.db, {
        instanceId: freshBundle.row.id,
        hostname: input.host,
        at: now,
        actorType: "edge",
        actorId: "edge",
        action: event.action,
        fromPhase: event.fromPhase,
        toPhase: event.toPhase,
        reason: event.reason,
        zone: freshBundle.row.timezone,
      });
    }
  }

  if (decision.decision === "proxy") {
    deps.db.run(
      "INSERT INTO edge_reports (id, instance_id, hostname, at, kind, request_id, path, method) VALUES (?, ?, ?, ?, 'proxy_open', ?, ?, ?)",
      ulid(now.getTime()),
      freshBundle.row.id,
      input.host,
      iso(now, freshBundle.row.timezone),
      input.request_id,
      input.path,
      input.method,
    );
  }

  if (decision.beginWake) {
    const owner = `admit:${input.request_id}`;
    const locked = deps.db.transaction(() => tryLock(deps.db, freshBundle.row.id, owner, now, freshBundle.row.timezone));
    if (!locked) {
      return waitBody(decision, freshBundle.row.phase, freshBundle.row.slug);
    }
    patchInstance(deps.db, freshBundle.row.id, {
      phase: "waking",
      wake_started_at: iso(now, freshBundle.row.timezone),
      wake_deadline_at: decision.deadlineAt ?? null,
      phase_changed_at: iso(now, freshBundle.row.timezone),
    });
    const eventId = recordEvent(deps.db, {
      instanceId: freshBundle.row.id,
      hostname: input.host,
      at: now,
      actorType: "edge",
      actorId: "edge",
      action: "wake_admitted",
      toPhase: "waking",
      reason: decision.consumesBudget ? "wake" : "schedule",
      detail: { request_id: input.request_id, path: input.path },
      zone: freshBundle.row.timezone,
    });
    try {
      const live = described ?? (await deps.cloud.describeInstance(freshBundle.row.aws_region, freshBundle.row.aws_instance_id));
      if (!live || tagProblem(live, freshBundle.row.slug)) {
        patchInstance(deps.db, freshBundle.row.id, { phase: freshBundle.row.phase, wake_started_at: null, phase_changed_at: freshBundle.row.phase_changed_at });
        releaseLock(deps.db, freshBundle.row.id, owner);
        recordEvent(deps.db, {
          instanceId: freshBundle.row.id,
          hostname: input.host,
          at: now,
          actorType: "edge",
          actorId: "edge",
          action: "tag_mismatch",
          zone: freshBundle.row.timezone,
        });
        return {
          decision: "failed",
          phase: freshBundle.row.phase,
          instance_slug: freshBundle.row.slug,
          message: "As tags da instância não fecham com o cadastro.",
          code: "tag_mismatch",
          event_id: eventId,
        };
      }
      if (live.power === "stopped") {
        const started = await deps.cloud.startInstance(freshBundle.row.aws_region, freshBundle.row.aws_instance_id);
        recordEvent(deps.db, {
          instanceId: freshBundle.row.id,
          hostname: input.host,
          at: now,
          actorType: "edge",
          actorId: "edge",
          action: "aws_start_called",
          reason: decision.consumesBudget ? "wake" : "schedule",
          awsRequestId: started.requestId,
          zone: freshBundle.row.timezone,
        });
      }
      const after = await deps.cloud.describeInstance(freshBundle.row.aws_region, freshBundle.row.aws_instance_id);
      patchInstance(deps.db, freshBundle.row.id, { phase: "starting", power: after?.power ?? "starting", power_changed_at: iso(now, freshBundle.row.timezone) });
    } catch (error) {
      patchInstance(deps.db, freshBundle.row.id, {
        phase: "error",
        start_attempts: freshBundle.row.start_attempts + 1,
        phase_changed_at: iso(now, freshBundle.row.timezone),
      });
      releaseLock(deps.db, freshBundle.row.id, owner);
      return {
        decision: "failed",
        phase: "error",
        instance_slug: freshBundle.row.slug,
        message: "Não foi possível ligar.",
        code: "conflict_phase",
        event_id: eventId,
        ...(error instanceof Error ? {} : {}),
      };
    }
  } else if (decision.decision === "closed" || decision.decision === "failed") {
    recordEvent(deps.db, {
      instanceId: freshBundle.row.id,
      hostname: input.host,
      at: now,
      actorType: "edge",
      actorId: "edge",
      action: decision.code === "wake_budget" ? "wake_budget" : "wake_ignored",
      reason: decision.code,
      detail: { path: input.path, method: input.method },
      zone: freshBundle.row.timezone,
    });
  }

  const origin = freshBundle.row.origin_host ? `https://${freshBundle.row.origin_host}` : undefined;
  return {
    decision: decision.decision,
    phase: decision.beginWake ? "starting" : decision.phase,
    instance_slug: decision.instanceSlug,
    wait_kind: decision.waitKind,
    retry_after_sec: decision.retryAfterSec,
    deadline_at: decision.deadlineAt,
    message: decision.message,
    code: decision.code,
    origin: decision.decision === "proxy" ? origin : undefined,
  };
}

function count(deps: Deps, instanceId: string, now: Date, zone: string): number {
  const since = iso(new Date(now.getTime() - 60 * 60_000), zone);
  const row = deps.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE instance_id = ? AND action = 'aws_start_called' AND reason = 'wake' AND at >= ?",
    instanceId,
    since,
  );
  return Number(row?.n ?? 0);
}

function waitBody(decision: ReturnType<typeof decideAdmit>, phase: GateBody["phase"], slug: string | null): GateBody {
  return {
    decision: "wait",
    phase,
    instance_slug: slug,
    wait_kind: decision.waitKind ?? "instance",
    retry_after_sec: 5,
    deadline_at: decision.deadlineAt,
    message: decision.message,
  };
}

export function finishGate(
  deps: Deps,
  input: { host: string; method: string; path: string; request_id: string },
): void {
  const located = findHost(deps.db, input.host);
  if (!located) return;
  const now = deps.clock.now();
  const ignore = idleIgnored(input.path, jsonList(located.host.idle_ignore_paths_json));
  const snapshot = toSnapshot(located.bundle, now);
  if (!ignore || snapshot.phase === "draining") {
    const traffic = applyUserTraffic(snapshot, now, !ignore);
    patchInstance(deps.db, located.bundle.row.id, {
      phase: traffic.phase,
      drain_started_at: traffic.drainStartedAt ? iso(traffic.drainStartedAt, located.bundle.row.timezone) : null,
      last_user_request_at: traffic.lastUserRequestAt
        ? iso(traffic.lastUserRequestAt, located.bundle.row.timezone)
        : located.bundle.row.last_user_request_at,
      phase_changed_at: iso(traffic.phaseChangedAt, located.bundle.row.timezone),
    });
  }
  deps.db.run(
    "INSERT INTO edge_reports (id, instance_id, hostname, at, kind, request_id, path, method) VALUES (?, ?, ?, ?, 'proxy_finish', ?, ?, ?)",
    ulid(now.getTime()),
    located.bundle.row.id,
    input.host,
    iso(now, located.bundle.row.timezone),
    input.request_id,
    input.path,
    input.method,
  );
}

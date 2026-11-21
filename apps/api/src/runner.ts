import type { Deps } from "./deps.ts";
import { reconcile } from "./domain/reconcile.ts";
import { tagProblem } from "./cloud/types.ts";
import { applyDiscover, notify, nudge, probeHost, quiesce } from "./fleet.ts";
import { loadBundle, patchInstance, recordEvent, releaseLock, renewLock, toSnapshot, tryLock, type Bundle } from "./model.ts";
import type { TickResult } from "./domain/types.ts";
import { iso, parseIso } from "./util.ts";

let ticking = false;

export async function runTick(deps: Deps): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const rows = deps.db.all<{ id: string; deactivated_at: string | null }>(
      "SELECT id, deactivated_at FROM instances",
    );
    for (const row of rows) {
      try {
        await tickInstance(deps, row.id, "full");
      } catch (error) {
        console.error("tick", row.id, error);
      }
    }
    const cutoff = iso(new Date(deps.clock.now().getTime() - 7 * 24 * 60 * 60_000));
    deps.db.run("DELETE FROM edge_reports WHERE at < ?", cutoff);
  } finally {
    ticking = false;
  }
}

export async function tickInstance(deps: Deps, id: string, mode: "full" | "wake"): Promise<void> {
  const initial = loadBundle(deps.db, id);
  if (!initial) return;
  const now = deps.clock.now();
  const zone = initial.row.timezone;
  if (deps.config.controlPlaneInstanceId && initial.row.aws_instance_id === deps.config.controlPlaneInstanceId) return;

  const described = await deps.cloud.describeInstance(initial.row.aws_region, initial.row.aws_instance_id).catch(() => null);
  if (initial.row.deactivated_at) {
    if (described && described.power !== initial.row.power) {
      patchInstance(deps.db, initial.row.id, { power: described.power, power_changed_at: iso(now, zone) });
    }
    return;
  }

  const lastDiscover = parseIso(initial.row.last_discover_at);
  const discoverDue = !lastDiscover || now.getTime() - lastDiscover.getTime() >= 5 * 60_000;
  const moving = ["waking", "starting", "draining"].includes(initial.row.phase);
  if (mode === "full" && (discoverDue || (initial.row.automation === "enforce" && moving))) {
    await applyDiscover(deps, initial, "reconciler");
  }

  let bundle = loadBundle(deps.db, id);
  if (!bundle) return;
  if (["waking", "starting", "on", "schedule_hold", "draining", "manual_override", "error"].includes(bundle.row.phase) || mode === "wake") {
    let any = false;
    for (const host of bundle.hosts) {
      const ok = await probeHost(deps, host, described?.power ?? null, bundle.row.origin_host);
      deps.db.run(
        "UPDATE hostnames SET last_health_ok = ?, last_health_at = ? WHERE id = ?",
        ok ? 1 : 0,
        iso(now, zone),
        host.id,
      );
      if (ok) any = true;
    }
    if (any && !bundle.row.became_healthy_at) {
      patchInstance(deps.db, bundle.row.id, { became_healthy_at: iso(now, zone), healthy_at: iso(now, zone) });
    } else if (any) {
      patchInstance(deps.db, bundle.row.id, { healthy_at: iso(now, zone) });
    }
    bundle = loadBundle(deps.db, id) ?? bundle;
  }

  if (["waking", "starting", "stopping", "draining"].includes(bundle.row.phase)) renewLock(deps.db, bundle.row.id, now, zone);
  const snapshot = toSnapshot(bundle, now);
  const plan = reconcile(snapshot, {
    now,
    skewMs: deps.clock.skewMs(),
    controlPlaneInstanceId: deps.config.controlPlaneInstanceId || null,
    describedPower: described?.power ?? null,
    mode,
  });

  if ((plan.callStart || plan.callStop) && !deps.db.transaction(() => tryLock(deps.db, bundle!.row.id, "reconciler", now, zone))) {
    if (described) patchInstance(deps.db, bundle.row.id, { power: plan.power, power_changed_at: iso(plan.powerChangedAt, zone) });
    return;
  }

  savePlan(deps, bundle, plan, now);
  if (plan.callStart) await performStart(deps, bundle, plan, described?.power ?? null);
  if (plan.callStop) await performStop(deps, bundle, described?.power ?? null);
  if (plan.callQuiesce) await quiesce(deps, loadBundle(deps.db, id) ?? bundle, "reconciler");
  if (plan.callNudge) await nudge(deps, loadBundle(deps.db, id) ?? bundle);
  if (plan.releaseLock) releaseLock(deps.db, bundle.row.id);
  for (const alarm of plan.alarms) {
    const reason = alarm;
    recordEvent(deps.db, {
      instanceId: bundle.row.id,
      at: now,
      actorType: "system",
      actorId: "reconciler",
      action: alarm,
      reason,
      zone,
    });
    await notify(deps, bundle.row.slug, bundle.row.aws_instance_id, alarm, reason);
  }
}

function savePlan(deps: Deps, bundle: Bundle, plan: TickResult, now: Date): void {
  const zone = bundle.row.timezone;
  patchInstance(deps.db, bundle.row.id, {
    phase: plan.phase,
    power: plan.power,
    phase_changed_at: iso(plan.phaseChangedAt, zone),
    power_changed_at: iso(plan.powerChangedAt, zone),
    start_attempts: plan.startAttempts,
    flap_count: plan.flapCount,
    flap_window_started_at: plan.flapWindowStartedAt ? iso(plan.flapWindowStartedAt, zone) : null,
    became_healthy_at: plan.becameHealthyAt ? iso(plan.becameHealthyAt, zone) : null,
    last_off_at: plan.lastOffAt ? iso(plan.lastOffAt, zone) : null,
    healthy_at: plan.healthyAt ? iso(plan.healthyAt, zone) : null,
    drain_started_at: plan.drainStartedAt ? iso(plan.drainStartedAt, zone) : null,
    wake_started_at: plan.wakeStartedAt ? iso(plan.wakeStartedAt, zone) : null,
    ssm_nudged: plan.ssmNudged ? 1 : 0,
    last_intention: plan.intention,
  });
  if (plan.clearOverride) {
    deps.db.run(
      "UPDATE overrides SET cleared_at = ? WHERE instance_id = ? AND cleared_at IS NULL",
      iso(now, zone),
      bundle.row.id,
    );
    patchInstance(deps.db, bundle.row.id, { override_hold: null });
  }
  for (const event of plan.events) {
    if (event.action === "observe_skipped" && event.detail?.would === `aws_${bundle.row.last_intention}`) {
      continue;
    }
    recordEvent(deps.db, {
      instanceId: bundle.row.id,
      at: now,
      actorType: "system",
      actorId: "reconciler",
      action: event.action,
      fromPhase: event.fromPhase ?? null,
      toPhase: event.toPhase ?? null,
      reason: event.reason ?? null,
      detail: event.detail ?? null,
      zone,
    });
  }
}

async function performStart(
  deps: Deps,
  bundle: Bundle,
  plan: TickResult,
  describedPower: string | null,
): Promise<void> {
  const row = bundle.row;
  const now = deps.clock.now();
  const revert = () => {
    patchInstance(deps.db, row.id, {
      phase: row.phase,
      wake_started_at: row.wake_started_at,
      phase_changed_at: row.phase_changed_at,
    });
    releaseLock(deps.db, row.id, "reconciler");
  };
  try {
    const described = await deps.cloud.describeInstance(row.aws_region, row.aws_instance_id);
    if (!described || tagProblem(described, row.slug)) {
      revert();
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "system",
        actorId: "reconciler",
        action: "tag_mismatch",
        reason: described ? tagProblem(described, row.slug) : "describe vazio",
        zone: row.timezone,
      });
      return;
    }
    if (described.power === "stopped") {
      const started = await deps.cloud.startInstance(row.aws_region, row.aws_instance_id);
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "system",
        actorId: "reconciler",
        action: "aws_start_called",
        reason: plan.phaseReason || "schedule",
        awsRequestId: started.requestId,
        zone: row.timezone,
      });
    }
    const after = await deps.cloud.describeInstance(row.aws_region, row.aws_instance_id);
    patchInstance(deps.db, row.id, {
      phase: "starting",
      power: after?.power ?? describedPower ?? "starting",
      power_changed_at: iso(now, row.timezone),
    });
  } catch (error) {
    patchInstance(deps.db, row.id, {
      phase: "error",
      start_attempts: row.start_attempts + 1,
      phase_changed_at: iso(now, row.timezone),
      wake_started_at: null,
    });
    releaseLock(deps.db, row.id, "reconciler");
    recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "system",
      actorId: "reconciler",
      action: "phase_changed",
      toPhase: "error",
      reason: error instanceof Error ? error.message : "start",
      zone: row.timezone,
    });
  }
}

async function performStop(deps: Deps, bundle: Bundle, describedPower: string | null): Promise<void> {
  const row = bundle.row;
  const now = deps.clock.now();
  try {
    const described = await deps.cloud.describeInstance(row.aws_region, row.aws_instance_id);
    if (!described || tagProblem(described, row.slug)) {
      patchInstance(deps.db, row.id, { phase: row.phase, phase_changed_at: row.phase_changed_at, drain_started_at: row.drain_started_at });
      releaseLock(deps.db, row.id, "reconciler");
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "system",
        actorId: "reconciler",
        action: "tag_mismatch",
        reason: described ? tagProblem(described, row.slug) : "describe vazio",
        zone: row.timezone,
      });
      return;
    }
    if (described.power === "running" || described.power === "starting") {
      const stopped = await deps.cloud.stopInstance(row.aws_region, row.aws_instance_id);
      recordEvent(deps.db, {
        instanceId: row.id,
        at: now,
        actorType: "system",
        actorId: "reconciler",
        action: "aws_stop_called",
        reason: "schedule",
        awsRequestId: stopped.requestId,
        zone: row.timezone,
      });
    }
    const after = await deps.cloud.describeInstance(row.aws_region, row.aws_instance_id);
    patchInstance(deps.db, row.id, {
      phase: "stopping",
      power: after?.power ?? describedPower ?? "stopping",
      power_changed_at: iso(now, row.timezone),
    });
  } catch (error) {
    patchInstance(deps.db, row.id, { phase: "error", phase_changed_at: iso(now, row.timezone) });
    releaseLock(deps.db, row.id, "reconciler");
    recordEvent(deps.db, {
      instanceId: row.id,
      at: now,
      actorType: "system",
      actorId: "reconciler",
      action: "phase_changed",
      toPhase: "error",
      reason: error instanceof Error ? error.message : "stop",
      zone: row.timezone,
    });
  }
}

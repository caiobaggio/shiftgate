import { isInShift } from "./schedule.ts";
import { activeOverride, evaluateStop } from "./stop-gate.ts";
import {
  awsUp,
  backoffOpen,
  FLAP_LIMIT,
  FLAP_WINDOW_MS,
  mergePower,
  PHASE_ERROR_ALARM_MS,
  SCHEDULE_MISS_MS,
  SKEW_LIMIT_MS,
  type DomainEvent,
  type Phase,
  type Snapshot,
  type TickContext,
  type TickResult,
} from "./types.ts";

interface Draft {
  phase: Phase;
  power: Snapshot["power"];
  startAttempts: number;
  flapCount: number;
  flapWindowStartedAt: Date | null;
  becameHealthyAt: Date | null;
  lastOffAt: Date | null;
  healthyAt: Date | null;
  drainStartedAt: Date | null;
  wakeStartedAt: Date | null;
  ssmNudged: boolean;
  callStart: boolean;
  callStop: boolean;
  callQuiesce: boolean;
  callNudge: boolean;
  releaseLock: boolean;
  intention: "start" | "stop" | null;
  clearOverride: boolean;
  alarms: TickResult["alarms"];
  events: DomainEvent[];
  phaseReason: string;
}

function blank(snapshot: Snapshot, power: Snapshot["power"]): Draft {
  return {
    phase: snapshot.phase,
    power,
    startAttempts: snapshot.startAttempts,
    flapCount: snapshot.flapCount,
    flapWindowStartedAt: snapshot.flapWindowStartedAt,
    becameHealthyAt: snapshot.becameHealthyAt,
    lastOffAt: snapshot.lastOffAt,
    healthyAt: snapshot.healthyAt,
    drainStartedAt: snapshot.drainStartedAt,
    wakeStartedAt: snapshot.wakeStartedAt,
    ssmNudged: snapshot.ssmNudged,
    callStart: false,
    callStop: false,
    callQuiesce: false,
    callNudge: false,
    releaseLock: false,
    intention: null,
    clearOverride: false,
    alarms: [],
    events: [],
    phaseReason: "",
  };
}

function setPhase(draft: Draft, phase: Phase, reason: string) {
  if (draft.phase === phase) return;
  draft.phase = phase;
  draft.phaseReason = reason;
}

function timedOut(from: Date | null, now: Date, timeoutSec: number): boolean {
  if (!from) return false;
  return now.getTime() - from.getTime() >= timeoutSec * 1000;
}

function minOffOpen(snapshot: Snapshot, now: Date): boolean {
  if (!snapshot.lastOffAt) return true;
  return now.getTime() - snapshot.lastOffAt.getTime() >= snapshot.minOffSec * 1000;
}

function noDoor(snapshot: Snapshot): boolean {
  return snapshot.hostnameCount === 0;
}

function acceptUp(draft: Draft, snapshot: Snapshot, now: Date, inShift: boolean, reason: string, hostless: boolean) {
  if (hostless && !draft.becameHealthyAt) draft.becameHealthyAt = snapshot.powerChangedAt;
  else draft.becameHealthyAt = draft.becameHealthyAt ?? now;
  draft.healthyAt = now;
  draft.startAttempts = 0;
  draft.wakeStartedAt = null;
  draft.ssmNudged = false;
  draft.releaseLock = true;
  const override = activeOverride(snapshot, now);
  if (override) setPhase(draft, "manual_override", hostless ? reason : "health ok sob override");
  else setPhase(draft, inShift ? "schedule_hold" : "on", reason);
  if (!hostless) draft.events.push({ action: "health_passed", toPhase: draft.phase });
}

function recordFlap(draft: Draft, now: Date) {
  const windowStart = draft.flapWindowStartedAt;
  if (!windowStart || now.getTime() - windowStart.getTime() > FLAP_WINDOW_MS) {
    draft.flapWindowStartedAt = now;
    draft.flapCount = 1;
    return;
  }
  draft.flapCount += 1;
}

function finishStopping(draft: Draft, now: Date) {
  recordFlap(draft, now);
  draft.drainStartedAt = null;
  draft.wakeStartedAt = null;
  draft.lastOffAt = now;
  draft.releaseLock = true;
  if (draft.flapCount >= FLAP_LIMIT) {
    setPhase(draft, "error", "flap");
    draft.alarms.push("flap");
    draft.events.push({ action: "phase_changed", reason: "flap", toPhase: "error" });
    return;
  }
  setPhase(draft, "off", "instância parada");
}

function failBoot(draft: Draft, reason: string) {
  draft.startAttempts += 1;
  draft.releaseLock = true;
  draft.wakeStartedAt = null;
  setPhase(draft, "error", reason);
  draft.events.push({
    action: reason === "health" ? "health_failed" : "phase_changed",
    reason,
    toPhase: "error",
    detail: { start_attempts: draft.startAttempts },
  });
}

function armStart(draft: Draft, snapshot: Snapshot, now: Date, reason: string, enforce: boolean) {
  if (!enforce) {
    draft.intention = "start";
    draft.events.push({ action: "observe_skipped", reason, detail: { would: "aws_start" } });
    return;
  }
  draft.wakeStartedAt = now;
  draft.releaseLock = false;
  setPhase(draft, "waking", reason);
  draft.callStart = true;
}

function considerStop(draft: Draft, snapshot: Snapshot, now: Date, ctx: TickContext) {
  const view: Snapshot = { ...snapshot, ...draft, windows: snapshot.windows, override: snapshot.override };
  const decision = evaluateStop(view, now, ctx.skewMs, ctx.controlPlaneInstanceId);
  if (!decision.desired && decision.code !== "observe_only" && decision.code !== "quiesce_open") return;
  if (decision.code === "observe_only" && decision.desired) {
    draft.intention = "stop";
    draft.events.push({ action: "observe_skipped", reason: "stop", detail: { would: "aws_stop" } });
    return;
  }
  if (!decision.desired) return;
  if (decision.code && decision.code !== "quiesce_open") return;
  if (draft.phase !== "draining") {
    draft.drainStartedAt = now;
    draft.callQuiesce = true;
    setPhase(draft, "draining", "silêncio");
    draft.events.push({ action: "drain_started", reason: "idle", toPhase: "draining" });
  }
  const armed: Snapshot = { ...view, phase: draft.phase, drainStartedAt: draft.drainStartedAt };
  const again = evaluateStop(armed, now, ctx.skewMs, ctx.controlPlaneInstanceId);
  if (again.call) {
    setPhase(draft, "stopping", "quiesce fechou");
    draft.callStop = true;
  }
}

function progressBoot(draft: Draft, snapshot: Snapshot, now: Date, inShift: boolean, enforce: boolean) {
  if (draft.phase === "waking") {
    if (awsUp(draft.power) || draft.power === "starting") {
      setPhase(draft, "starting", "start aceito ou já no ar");
      return;
    }
    if (timedOut(draft.wakeStartedAt ?? snapshot.phaseChangedAt, now, snapshot.startTimeoutSec)) {
      failBoot(draft, "timeout");
    }
    return;
  }

  if (draft.phase === "starting") {
    const hostless = noDoor(snapshot);
    if (awsUp(draft.power) && (snapshot.anyHealthy || hostless)) {
      acceptUp(draft, snapshot, now, inShift, hostless ? "no ar sem hostname" : "health ok", hostless);
      return;
    }
    if (timedOut(draft.wakeStartedAt ?? snapshot.phaseChangedAt, now, snapshot.startTimeoutSec)) {
      failBoot(draft, "health");
      return;
    }
    if (awsUp(draft.power) && !snapshot.anyHealthy && !hostless && enforce && !draft.ssmNudged) {
      draft.callNudge = true;
      draft.ssmNudged = true;
    }
  }
}

function progressStop(draft: Draft, snapshot: Snapshot, now: Date) {
  if (draft.phase !== "stopping") return;
  if (draft.power === "stopped") {
    finishStopping(draft, now);
    return;
  }
  if (timedOut(snapshot.phaseChangedAt, now, snapshot.startTimeoutSec) && draft.power !== "stopping") {
    failBoot(draft, "stop");
  }
}

export function reconcile(snapshot: Snapshot, ctx: TickContext): TickResult {
  const now = ctx.now;
  const power = mergePower(snapshot.power, ctx.describedPower, snapshot.blockInstanceStop);
  const draft = blank(snapshot, power);
  const enforce = snapshot.automation === "enforce";
  let override = snapshot.override;
  if (snapshot.override && snapshot.override.expiresAt.getTime() <= now.getTime()) {
    draft.clearOverride = true;
    override = null;
    draft.events.push({ action: "override_expired", reason: snapshot.override.id });
    if (draft.phase === "manual_override") {
      setPhase(draft, power === "stopped" || power === "stopping" ? "off" : "on", "override expirou");
    }
  }
  const view = (): Snapshot => ({ ...snapshot, ...draft, override, windows: snapshot.windows });
  const inShift = () => isInShift(now, snapshot.windows, snapshot.timezone);

  if (power !== snapshot.power) {
    draft.events.push({
      action: "host_power_changed",
      reason: power,
      detail: { from: snapshot.power, to: power },
    });
  }

  if (ctx.mode === "wake") {
    progressBoot(draft, view(), now, inShift(), enforce);
    progressStop(draft, snapshot, now);
    return pack(snapshot, draft, now);
  }

  if (ctx.skewMs > SKEW_LIMIT_MS) {
    draft.alarms.push("clock_skew");
    draft.events.push({ action: "clock_skew", reason: String(ctx.skewMs) });
    if (draft.phase === "stopping" && power === "stopped") finishStopping(draft, now);
    return pack(snapshot, draft, now);
  }

  if (snapshot.deactivated) return pack(snapshot, draft, now);

  if (draft.phase === "error" && awsUp(power) && snapshot.anyHealthy) {
    setPhase(draft, inShift() ? "schedule_hold" : "on", "health voltou");
    draft.startAttempts = 0;
    draft.releaseLock = true;
  }

  if (draft.phase === "error" && awsUp(power) && noDoor(snapshot)) {
    const retry = backoffOpen(draft.startAttempts, snapshot.phaseChangedAt, now);
    if (inShift() || retry) {
      acceptUp(draft, snapshot, now, inShift(), "no ar sem hostname", true);
    }
  }

  if ((draft.phase === "on" || draft.phase === "schedule_hold" || draft.phase === "draining") && power === "stopped") {
    draft.drainStartedAt = null;
    draft.lastOffAt = now;
    setPhase(draft, "off", "power parado");
  }

  if (draft.phase === "off" && awsUp(power)) {
    if (noDoor(snapshot)) {
      acceptUp(draft, snapshot, now, inShift(), "no ar sem hostname", true);
    } else {
      setPhase(draft, snapshot.anyHealthy ? (inShift() ? "schedule_hold" : "on") : "starting", "power no ar");
      if (snapshot.anyHealthy) {
        draft.becameHealthyAt = draft.becameHealthyAt ?? now;
        draft.healthyAt = now;
      }
    }
  }

  progressBoot(draft, view(), now, inShift(), enforce);
  progressStop(draft, snapshot, now);

  if (draft.phase === "draining") {
    const decision = evaluateStop(view(), now, ctx.skewMs, ctx.controlPlaneInstanceId);
    if (decision.call) {
      setPhase(draft, "stopping", "quiesce fechou");
      draft.callStop = true;
    } else if (!decision.desired || (decision.code !== null && decision.code !== "quiesce_open")) {
      draft.drainStartedAt = null;
      setPhase(draft, inShift() ? "schedule_hold" : "on", decision.code ?? "drain interrompido");
      draft.events.push({
        action: "drain_cancelled",
        toPhase: draft.phase,
        reason: decision.code ?? "idle",
      });
    }
  }

  if (draft.phase === "error" && snapshot.phase === "error") {
    if (now.getTime() - snapshot.phaseChangedAt.getTime() >= PHASE_ERROR_ALARM_MS) draft.alarms.push("phase_error");
    const retry = backoffOpen(draft.startAttempts, snapshot.phaseChangedAt, now);
    if (retry && inShift() && power === "stopped" && minOffOpen(snapshot, now)) {
      armStart(draft, snapshot, now, "retry do turno", enforce);
    } else if (retry && inShift() && awsUp(power) && snapshot.hostnameCount > 0) {
      draft.wakeStartedAt = now;
      draft.releaseLock = false;
      setPhase(draft, "starting", "turno retoma o health");
    }
  }

  const hold = activeOverride(view(), now);

  if (draft.phase === "manual_override" && hold) {
    if (hold.hold === "on" && power === "stopped") armStart(draft, snapshot, now, "override hold on", enforce);
    if (hold.hold === "off" && awsUp(power)) considerStop(draft, view(), now, ctx);
  }

  if (draft.phase === "off" && power === "stopped") {
    if ((inShift() || hold?.hold === "on") && minOffOpen(snapshot, now)) {
      armStart(draft, snapshot, now, hold?.hold === "on" ? "override hold on" : "turno", enforce);
    } else if (inShift() && !minOffOpen(snapshot, now)) {
      draft.events.push({ action: "wake_ignored", reason: "min_off" });
    }
  }

  if (draft.phase === "schedule_hold") {
    if (!inShift()) {
      const idleLeft =
        snapshot.lastUserRequestAt !== null &&
        now.getTime() - snapshot.lastUserRequestAt.getTime() < snapshot.idleMinutes * 60_000;
      setPhase(draft, "on", idleLeft ? "turno acabou com uso recente" : "turno acabou");
      if (!idleLeft) considerStop(draft, view(), now, ctx);
    } else if (power === "stopped") {
      armStart(draft, snapshot, now, "turno", enforce);
    }
  }

  if (draft.phase === "on") {
    if (inShift() || hold?.hold === "on") setPhase(draft, hold?.hold === "on" ? "manual_override" : "schedule_hold", "entrou no turno");
    else considerStop(draft, view(), now, ctx);
  }

  if (
    inShift() &&
    power === "stopped" &&
    hold?.hold !== "off" &&
    now.getTime() - snapshot.powerChangedAt.getTime() >= SCHEDULE_MISS_MS
  ) {
    draft.alarms.push("schedule_miss");
  }

  return pack(snapshot, draft, now);
}

function pack(snapshot: Snapshot, draft: Draft, now: Date): TickResult {
  const phaseChanged = draft.phase !== snapshot.phase;
  const events = [...draft.events];
  if (phaseChanged && !events.some((event) => event.action === "phase_changed" && event.toPhase === draft.phase)) {
    events.push({
      action: "phase_changed",
      reason: draft.phaseReason,
      fromPhase: snapshot.phase,
      toPhase: draft.phase,
    });
  }
  return {
    phase: draft.phase,
    power: draft.power,
    startAttempts: draft.startAttempts,
    flapCount: draft.flapCount,
    flapWindowStartedAt: draft.flapWindowStartedAt,
    becameHealthyAt: draft.becameHealthyAt,
    lastOffAt: draft.lastOffAt,
    healthyAt: draft.healthyAt,
    drainStartedAt: draft.drainStartedAt,
    wakeStartedAt: draft.wakeStartedAt,
    phaseChangedAt: phaseChanged ? now : snapshot.phaseChangedAt,
    powerChangedAt: draft.power !== snapshot.power ? now : snapshot.powerChangedAt,
    clearOverride: draft.clearOverride,
    ssmNudged: draft.ssmNudged,
    callStart: draft.callStart,
    callStop: draft.callStop,
    callQuiesce: draft.callQuiesce,
    callNudge: draft.callNudge,
    releaseLock: draft.releaseLock,
    intention: draft.intention,
    alarms: draft.alarms,
    events,
    phaseReason: draft.phaseReason,
  };
}

export function applyUserTraffic(snapshot: Snapshot, now: Date, countsForIdle: boolean): {
  phase: Phase;
  drainStartedAt: Date | null;
  lastUserRequestAt: Date | null;
  phaseChangedAt: Date;
  events: DomainEvent[];
} {
  let phase = snapshot.phase;
  let drainStartedAt = snapshot.drainStartedAt;
  const events: DomainEvent[] = [];
  if (phase === "draining") {
    const inShift = isInShift(now, snapshot.windows, snapshot.timezone);
    phase = inShift ? "schedule_hold" : "on";
    drainStartedAt = null;
    events.push({ action: "drain_cancelled", fromPhase: "draining", toPhase: phase, reason: "request" });
  }
  return {
    phase,
    drainStartedAt,
    lastUserRequestAt: countsForIdle ? now : snapshot.lastUserRequestAt,
    phaseChangedAt: phase === snapshot.phase ? snapshot.phaseChangedAt : now,
    events,
  };
}

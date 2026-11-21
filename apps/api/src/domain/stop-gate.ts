import { isInShift } from "./schedule.ts";
import { stopMessage } from "./messages.ts";
import { awsUp, SKEW_LIMIT_MS, type Snapshot } from "./types.ts";

export interface StopDecision {
  /** Turno, idle e runtime dizem que esta EC2 não deveria seguir no ar. */
  desired: boolean;
  quiesceDone: boolean;
  /** Todos os guards da seção 5 fecharam, inclusive a quiesce. */
  call: boolean;
  code: string | null;
  message: string;
}

export function activeOverride(snapshot: Snapshot, now: Date) {
  if (!snapshot.override) return null;
  if (snapshot.override.expiresAt.getTime() <= now.getTime()) return null;
  return snapshot.override;
}

function silenceMet(snapshot: Snapshot, now: Date): boolean {
  if (!snapshot.lastUserRequestAt) return true;
  return now.getTime() - snapshot.lastUserRequestAt.getTime() >= snapshot.idleMinutes * 60_000;
}

function runtimeMet(snapshot: Snapshot, now: Date): boolean {
  if (!snapshot.becameHealthyAt) return false;
  return now.getTime() - snapshot.becameHealthyAt.getTime() >= snapshot.minRuntimeSec * 1000;
}

export function evaluateStop(
  snapshot: Snapshot,
  now: Date,
  skewMs: number,
  controlPlaneInstanceId: string | null,
  opts?: { emergency?: boolean },
): StopDecision {
  const override = activeOverride(snapshot, now);
  const inShift = isInShift(now, snapshot.windows, snapshot.timezone);
  const holdOff = override?.hold === "off";
  const holdOn = override?.hold === "on";
  const shiftBlocks = inShift && !holdOff;
  const idleOk = silenceMet(snapshot, now);
  const runtimeOk = runtimeMet(snapshot, now);
  const quiesceDone =
    Boolean(opts?.emergency) ||
    (snapshot.drainStartedAt !== null &&
      now.getTime() - snapshot.drainStartedAt.getTime() >= snapshot.quiesceSec * 1000);

  const transitional = snapshot.phase === "waking" || snapshot.phase === "starting" || snapshot.phase === "stopping";
  const desired =
    !snapshot.deactivated &&
    !holdOn &&
    !shiftBlocks &&
    idleOk &&
    runtimeOk &&
    awsUp(snapshot.power) &&
    !transitional;

  let code: string | null = null;
  if (snapshot.deactivated) code = "inactive";
  else if (controlPlaneInstanceId && snapshot.awsInstanceId === controlPlaneInstanceId) code = "control_plane_protected";
  else if (skewMs > SKEW_LIMIT_MS) code = "clock_skew";
  else if (holdOn) code = "hold_on";
  else if (shiftBlocks) code = "in_shift";
  else if (snapshot.automation !== "enforce") code = "observe_only";
  else if (!snapshot.instanceStopEnabled) code = "stop_disabled";
  else if (snapshot.blockInstanceStop) code = "unregistered_service";
  else if (transitional || snapshot.phase === "schedule_hold" || snapshot.phase === "off" || snapshot.phase === "error") {
    code = "conflict_phase";
  } else if (!idleOk) code = "idle_not_met";
  else if (!runtimeOk) code = "min_runtime";
  else if (!awsUp(snapshot.power)) code = "conflict_phase";
  else if (!quiesceDone) code = "quiesce_open";

  const call = desired && code === null && snapshot.automation === "enforce";
  return {
    desired,
    quiesceDone,
    call,
    code: call ? null : code,
    message: stopMessage(code ?? (call ? "" : "conflict_phase")),
  };
}

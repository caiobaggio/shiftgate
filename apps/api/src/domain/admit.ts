import type { GateDecision, Phase, WaitKind } from "../../../../packages/contracts/src/index.ts";
import { isInShift } from "./schedule.ts";
import { activeOverride } from "./stop-gate.ts";
import { awsUp, backoffOpen, WAKE_BUDGET_PER_HOUR, type Snapshot } from "./types.ts";

export interface AdmitInput {
  snapshot: Snapshot | null;
  method: string;
  path: string;
  wakeAllowed: boolean;
  healthFresh: boolean;
  now: Date;
  automaticStartsInLastHour: number;
  /** Status e poll não disparam outra partida. */
  allowStart: boolean;
}

export interface AdmitResult {
  decision: GateDecision;
  waitKind?: WaitKind;
  beginWake: boolean;
  cancelDrain: boolean;
  countsAsUse: boolean;
  code?: string;
  message: string;
  retryAfterSec?: number;
  deadlineAt?: string;
  phase: Phase | null;
  instanceSlug: string | null;
  consumesBudget: boolean;
}

function deadline(from: Date, timeoutSec: number): string {
  return new Date(from.getTime() + timeoutSec * 1000).toISOString();
}

export function decideAdmit(input: AdmitInput): AdmitResult {
  const snapshot = input.snapshot;
  const base = {
    beginWake: false,
    cancelDrain: false,
    countsAsUse: false,
    phase: snapshot?.phase ?? null,
    instanceSlug: snapshot?.slug ?? null,
    consumesBudget: false,
  } satisfies Partial<AdmitResult>;

  if (!snapshot) {
    return { ...base, decision: "closed", message: "Este endereço não está no cadastro.", code: "not_found", phase: null };
  }

  if (snapshot.deactivated) {
    return { ...base, decision: "closed", message: "Este serviço está fechado.", code: "inactive" };
  }

  const now = input.now;
  const override = activeOverride(snapshot, now);
  const inShift = isInShift(now, snapshot.windows, snapshot.timezone);
  const retryAfter = 5;

  if (override?.hold === "off" || snapshot.phase === "stopping") {
    return {
      ...base,
      decision: "closed",
      code: override?.hold === "off" ? "conflict_phase" : "conflict_phase",
      message: override?.hold === "off" ? "Uma pausa manual está valendo neste horário." : "A instância está desligando.",
    };
  }

  if (snapshot.phase === "error") {
    const open = backoffOpen(snapshot.startAttempts, snapshot.phaseChangedAt, now);
    if (!open) {
      return {
        ...base,
        decision: "failed",
        code: "cooldown",
        message:
          snapshot.startAttempts >= 4
            ? "Não foi possível ligar. A quarta falha espera uma pessoa."
            : "Não foi possível ligar agora. A espera da falha anterior ainda vale.",
      };
    }
  }

  const up = awsUp(snapshot.power) || snapshot.power === "starting";

  if (
    input.healthFresh &&
    awsUp(snapshot.power) &&
    (snapshot.phase === "schedule_hold" || snapshot.phase === "on" || snapshot.phase === "manual_override")
  ) {
    return {
      ...base,
      decision: "proxy",
      countsAsUse: true,
      message: "Acesso liberado.",
    };
  }

  if (snapshot.phase === "draining") {
    if (input.healthFresh) {
      return { ...base, decision: "proxy", cancelDrain: true, countsAsUse: true, message: "Acesso liberado." };
    }
    return {
      ...base,
      decision: "wait",
      waitKind: "health",
      cancelDrain: true,
      retryAfterSec: retryAfter,
      deadlineAt: deadline(now, snapshot.startTimeoutSec),
      message: "A instância já está no ar. Esperando o serviço responder.",
    };
  }

  if (snapshot.phase === "waking" || snapshot.phase === "starting") {
    const waitKind: WaitKind = awsUp(snapshot.power) ? "health" : "instance";
    const started = snapshot.wakeStartedAt ?? snapshot.phaseChangedAt;
    return {
      ...base,
      decision: "wait",
      waitKind,
      retryAfterSec: retryAfter,
      deadlineAt: deadline(started, snapshot.startTimeoutSec),
      message:
        waitKind === "instance"
          ? "Ligando a instância. Isso pode levar até três minutos."
          : "A instância já está no ar. Esperando o serviço responder.",
    };
  }

  if (
    (snapshot.phase === "on" || snapshot.phase === "schedule_hold" || snapshot.phase === "manual_override") &&
    up &&
    !input.healthFresh
  ) {
    return {
      ...base,
      decision: "wait",
      waitKind: "health",
      retryAfterSec: retryAfter,
      deadlineAt: deadline(now, snapshot.startTimeoutSec),
      message: "A instância já está no ar. Esperando o serviço responder.",
    };
  }

  const visitorWake = input.wakeAllowed && !inShift && override?.hold !== "on";
  const shiftRecovery = inShift || override?.hold === "on";
  const mayEnter = visitorWake || shiftRecovery;

  if (!mayEnter) {
    return { ...base, decision: "closed", message: "Fora do expediente.", code: "conflict_phase" };
  }

  if (!snapshot.hasElasticIp) {
    return {
      ...base,
      decision: "closed",
      code: "validation",
      message: "Sem Elastic IP o wake não usa este endereço.",
    };
  }

  if (snapshot.automation !== "enforce") {
    return {
      ...base,
      decision: "closed",
      code: "observe_only",
      message: "O acesso automático ainda está em observação.",
    };
  }

  if (visitorWake && input.automaticStartsInLastHour >= WAKE_BUDGET_PER_HOUR) {
    return {
      ...base,
      decision: "closed",
      code: "wake_budget",
      message: "Muitas partidas nesta hora. Tente de novo mais tarde.",
    };
  }

  if (!input.allowStart) {
    return { ...base, decision: "closed", message: "A instância está desligada.", code: "conflict_phase" };
  }

  return {
    ...base,
    decision: "wait",
    waitKind: "instance",
    beginWake: true,
    consumesBudget: visitorWake,
    retryAfterSec: retryAfter,
    deadlineAt: deadline(now, snapshot.startTimeoutSec),
    message: "Ligando a instância. Isso pode levar até três minutos.",
  };
}

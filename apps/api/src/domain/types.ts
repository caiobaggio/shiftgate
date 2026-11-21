import type { Automation, Phase, Power } from "../../../../packages/contracts/src/index.ts";

export type { Automation, Phase, Power };

export interface Window {
  weekday: number;
  startLocal: string;
  endLocal: string;
}

export interface OverrideSnap {
  id: string;
  hold: "on" | "off";
  expiresAt: Date;
}

export interface Snapshot {
  id: string;
  slug: string;
  awsInstanceId: string;
  timezone: string;
  idleMinutes: number;
  automation: Automation;
  blockInstanceStop: boolean;
  instanceStopEnabled: boolean;
  startTimeoutSec: number;
  minRuntimeSec: number;
  minOffSec: number;
  quiesceSec: number;
  deactivated: boolean;
  windows: Window[];
  phase: Phase;
  power: Power;
  phaseChangedAt: Date;
  powerChangedAt: Date;
  healthyAt: Date | null;
  becameHealthyAt: Date | null;
  lastUserRequestAt: Date | null;
  lastOffAt: Date | null;
  startAttempts: number;
  flapWindowStartedAt: Date | null;
  flapCount: number;
  override: OverrideSnap | null;
  drainStartedAt: Date | null;
  wakeStartedAt: Date | null;
  hasElasticIp: boolean;
  anyHealthy: boolean;
  /** Zero quer dizer que não há health para esperar. A EC2 no ar já pode entrar no turno. */
  hostnameCount: number;
  ssmNudged: boolean;
}

export interface TickContext {
  now: Date;
  skewMs: number;
  controlPlaneInstanceId: string | null;
  describedPower: Exclude<Power, "blocked"> | null;
  /** `wake` só avança boot e health. O turno e o stop ficam no `full`. */
  mode: "full" | "wake";
}

export interface DomainEvent {
  action: string;
  reason?: string;
  fromPhase?: Phase;
  toPhase?: Phase;
  detail?: Record<string, unknown>;
}

export type AlarmName = "schedule_miss" | "phase_error" | "flap" | "clock_skew";

export interface TickResult {
  phase: Phase;
  power: Power;
  startAttempts: number;
  flapCount: number;
  flapWindowStartedAt: Date | null;
  becameHealthyAt: Date | null;
  lastOffAt: Date | null;
  healthyAt: Date | null;
  drainStartedAt: Date | null;
  wakeStartedAt: Date | null;
  phaseChangedAt: Date;
  powerChangedAt: Date;
  clearOverride: boolean;
  ssmNudged: boolean;
  callStart: boolean;
  callStop: boolean;
  callQuiesce: boolean;
  callNudge: boolean;
  releaseLock: boolean;
  intention: "start" | "stop" | null;
  alarms: AlarmName[];
  events: DomainEvent[];
  phaseReason: string;
}

export const SKEW_LIMIT_MS = 30_000;
export const FLAP_WINDOW_MS = 30 * 60_000;
export const FLAP_LIMIT = 3;
export const WAKE_BUDGET_PER_HOUR = 3;
export const HEALTH_FRESH_MS = 15_000;
export const SCHEDULE_MISS_MS = 5 * 60_000;
export const PHASE_ERROR_ALARM_MS = 10 * 60_000;
export const LOCK_TTL_MS = 60_000;
export const SESSION_TTL_MS = 8 * 60 * 60_000;
export const MUTATIONS_PER_HOUR = 30;

export function retryDelayMs(attempts: number): number | null {
  if (attempts >= 4) return null;
  if (attempts <= 0) return 0;
  if (attempts === 1) return 60_000;
  if (attempts === 2) return 180_000;
  return 600_000;
}

export function backoffOpen(attempts: number, since: Date, now: Date): boolean {
  const delay = retryDelayMs(attempts);
  if (delay === null) return false;
  return now.getTime() - since.getTime() >= delay;
}

export function awsUp(power: Power): boolean {
  return power === "running" || power === "blocked";
}

export function mergePower(
  stored: Power,
  described: Exclude<Power, "blocked"> | null,
  blocked: boolean,
): Power {
  const base = described ?? (stored === "blocked" ? "running" : stored);
  if (base === "running" && blocked) return "blocked";
  return base;
}

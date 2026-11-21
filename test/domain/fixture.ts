import type { Snapshot } from "../../apps/api/src/domain/types.ts";
import type { TickContext } from "../../apps/api/src/domain/types.ts";

export const NOW = new Date("2026-10-19T15:00:00.000Z");

export function snap(over: Partial<Snapshot> = {}): Snapshot {
  const ago = new Date(NOW.getTime() - 3_600_000);
  return {
    id: "01INSTANCE",
    slug: "ensaio-a",
    awsInstanceId: "i-0aaaaaaa000000001",
    timezone: "America/Sao_Paulo",
    idleMinutes: 20,
    automation: "enforce",
    blockInstanceStop: false,
    instanceStopEnabled: true,
    startTimeoutSec: 180,
    minRuntimeSec: 900,
    minOffSec: 120,
    quiesceSec: 60,
    deactivated: false,
    windows: [],
    phase: "on",
    power: "running",
    phaseChangedAt: ago,
    powerChangedAt: ago,
    healthyAt: ago,
    becameHealthyAt: ago,
    lastUserRequestAt: new Date(NOW.getTime() - 21 * 60_000),
    lastOffAt: null,
    startAttempts: 0,
    flapWindowStartedAt: null,
    flapCount: 0,
    override: null,
    drainStartedAt: null,
    wakeStartedAt: null,
    hasElasticIp: true,
    anyHealthy: true,
    hostnameCount: 1,
    ssmNudged: false,
    ...over,
  };
}

export function tick(over: Partial<TickContext> = {}): TickContext {
  return {
    now: NOW,
    skewMs: 0,
    controlPlaneInstanceId: "i-0cccccccc0000000c",
    describedPower: null,
    mode: "full",
    ...over,
  };
}

export const office = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startLocal: "05:00",
  endLocal: "18:00",
}));

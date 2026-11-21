import type { Role } from "../../../packages/contracts/src/index.ts";
import type { Config } from "./config.ts";
import type { Cloud } from "./cloud/types.ts";
import type { HealthProbe } from "./cloud/health.ts";
import type { DB } from "./db/index.ts";

export interface Actor {
  id: string;
  subject: string;
  email: string;
  role: Role;
}

export interface Clock {
  now(): Date;
  skewMs(): number;
}

export interface Deps {
  config: Config;
  db: DB;
  cloud: Cloud;
  health: HealthProbe;
  clock: Clock;
}

export function systemClock(config: Config): Clock {
  return {
    now: () => new Date(),
    skewMs: () => config.simulatedSkewMs,
  };
}

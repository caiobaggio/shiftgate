export const PHASES = [
  "off",
  "waking",
  "starting",
  "schedule_hold",
  "on",
  "draining",
  "stopping",
  "manual_override",
  "error",
] as const;

export type Phase = (typeof PHASES)[number];

export const POWERS = ["stopped", "starting", "running", "stopping", "blocked", "error"] as const;

export type Power = (typeof POWERS)[number];

export type Automation = "observe" | "enforce";

export type Role = "admin" | "operator" | "auditor";

export type GateDecision = "proxy" | "wait" | "closed" | "failed";

export type WaitKind = "instance" | "health";

export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation",
  "conflict_phase",
  "tag_mismatch",
  "control_plane_protected",
  "lock_held",
  "idempotency_replay",
  "cooldown",
  "wake_budget",
  "in_shift",
  "unregistered_service",
  "inactive",
  "clock_skew",
  "observe_only",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    event_id?: string;
  };
}

export const PHASE_LABEL: Record<Phase, string> = {
  off: "Desligada",
  waking: "Acordando",
  starting: "Ligando",
  schedule_hold: "No turno",
  on: "Ligada fora do turno",
  draining: "Esfriando",
  stopping: "Desligando",
  manual_override: "Override",
  error: "Erro",
};

export const POWER_LABEL: Record<Power, string> = {
  stopped: "Parada",
  starting: "Iniciando",
  running: "No ar",
  stopping: "Parando",
  blocked: "Bloqueada",
  error: "Erro",
};

export interface StopGate {
  code: string | null;
  message: string;
}

export interface HostnameWire {
  hostname: string;
  health_url: string;
  wake_paths: string[];
  idle_ignore_paths: string[];
  last_health_ok: boolean;
  last_health_at: string | null;
}

export interface WorkloadWire {
  slug: string;
  display_name: string;
  runtime: "pm2" | "systemd" | "docker" | "node";
  unit_name: string;
  port: number | null;
  hostname: string | null;
}

export interface WindowWire {
  weekday: number;
  start_local: string;
  end_local: string;
}

export interface OverrideWire {
  hold: "on" | "off";
  reason: string;
  starts_at: string;
  expires_at: string;
}

export interface InstanceSummary {
  slug: string;
  display_name: string;
  aws_instance_id: string;
  aws_region: string;
  power: Power;
  phase: Phase;
  schedule_summary: string;
  idle_minutes: number;
  has_elastic_ip: boolean;
  active: boolean;
  automation: Automation;
  block_instance_stop: boolean;
  intention: "start" | "stop" | null;
}

export interface InstanceDetail extends InstanceSummary {
  id: string;
  origin_host: string | null;
  timezone: string;
  block_reason: string | null;
  instance_stop_enabled: boolean;
  start_timeout_sec: number;
  health_interval_sec: number;
  min_runtime_sec: number;
  min_off_sec: number;
  quiesce_sec: number;
  windows: WindowWire[];
  hostnames: HostnameWire[];
  workloads: WorkloadWire[];
  override: OverrideWire | null;
  discover: {
    at: string;
    clean: boolean;
    unknown: { systemd: string[]; pm2: string[]; docker: string[] };
    error?: string;
  } | null;
  stop_gate: StopGate;
  infra: string[];
  phase_changed_at: string;
  power_changed_at: string;
  last_user_request_at: string | null;
  healthy_at: string | null;
  deactivated_at: string | null;
}

export interface GateBody {
  decision: GateDecision;
  phase: Phase | null;
  instance_slug: string | null;
  wait_kind?: WaitKind;
  retry_after_sec?: number;
  deadline_at?: string;
  event_id?: string;
  origin?: string;
  message: string;
  code?: string;
}

export const DAY_LABEL = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"] as const;

export const DAY_SHORT = ["", "seg", "ter", "qua", "qui", "sex", "sáb", "dom"] as const;

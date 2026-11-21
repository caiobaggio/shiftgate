import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const instanceId = z.string().regex(/^i-[0-9a-f]{17}$/);
const region = z.string().regex(/^[a-z]{2}-[a-z]+-\d$/);

export const hostnameSchema = z.object({
  hostname: z.string().min(1).max(253),
  health_url: z.string().url(),
  wake_paths: z.array(z.string()).default([]),
  idle_ignore_paths: z.array(z.string()).optional(),
});

export const windowSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    start_local: time,
    end_local: time,
  })
  .refine((window) => window.end_local !== "24:00" || window.start_local === "00:00", "24:00 só fecha o dia inteiro");

export const createSchema = z.object({
  display_name: z.string().min(1).max(120),
  slug,
  aws_region: region,
  aws_instance_id: instanceId,
  has_elastic_ip: z.boolean(),
  origin_host: z.string().min(1).max(253).nullable().optional(),
  idle_minutes: z.number().int().min(1).max(24 * 60),
  timezone: z.string().min(1).optional(),
  hostnames: z.array(hostnameSchema).default([]),
  schedules: z.array(windowSchema).default([]),
});

export const identitySchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  aws_region: region.optional(),
  has_elastic_ip: z.boolean().optional(),
  origin_host: z.string().min(1).max(253).nullable().optional(),
  aws_instance_id: instanceId.optional(),
});

export const schedulesSchema = z.object({
  timezone: z.string().min(1).optional(),
  windows: z.array(windowSchema),
});

export const idleSchema = z.object({ idle_minutes: z.number().int().min(1).max(24 * 60) });

export const hostnamesSchema = z.object({ hostnames: z.array(hostnameSchema) });

export const workloadSchema = z.object({
  slug,
  display_name: z.string().min(1),
  runtime: z.enum(["pm2", "systemd", "docker", "node"]),
  unit_name: z.string().min(1).max(128),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  hostname: z.string().min(1).max(253).nullable().optional(),
});

export const workloadsSchema = z.object({ workloads: z.array(workloadSchema) });
export const infraSchema = z.object({ names: z.array(z.string().min(1).max(80)).min(1) });
export const policySchema = z.object({
  automation: z.enum(["observe", "enforce"]).optional(),
  instance_stop_enabled: z.boolean().optional(),
});
export const timingSchema = z.object({
  start_timeout_sec: z.number().int().min(30).max(900).optional(),
  health_interval_sec: z.number().int().min(1).max(120).optional(),
  min_runtime_sec: z.number().int().min(0).max(24 * 3600).optional(),
  min_off_sec: z.number().int().min(0).max(3600).optional(),
  quiesce_sec: z.number().int().min(0).max(3600).optional(),
});
export const reasonSchema = z.object({ reason: z.string().min(12).max(500) });
export const startSchema = z.object({
  hold_minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  reason: z.string().max(500).optional(),
  confirm_slug: z.string().optional(),
});
export const stopSchema = z.object({
  hold_minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  reason: z.string().min(12).max(500),
  confirm_slug: z.string().min(1),
  emergency: z.boolean().optional(),
});
export const operatorSchema = z.object({
  email: z.string().email(),
  subject: z.string().min(1).optional(),
  role: z.enum(["admin", "operator", "auditor"]),
});
export const sessionSchema = z.object({ email: z.string().email() });
export const admitSchema = z.object({
  host: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  request_id: z.string().min(1),
});
export const finishSchema = admitSchema.extend({ status: z.number().int().optional() });
export const plantSchema = z.object({
  instance_id: instanceId,
  region,
  slug,
  power: z.enum(["stopped", "starting", "running", "stopping"]).optional(),
  public_ip: z.string().nullable().optional(),
  systemd: z.array(z.string()).optional(),
  pm2: z.array(z.string()).optional(),
  docker: z.array(z.string()).optional(),
  ssm_online: z.boolean().optional(),
});

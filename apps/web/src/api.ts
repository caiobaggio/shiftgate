import type { InstanceDetail, InstanceSummary } from "../../../packages/contracts/src/index.ts";

export type { InstanceDetail, InstanceSummary };

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
    if ((init.method ?? "GET") !== "GET") headers.set("idempotency-key", crypto.randomUUID());
  }
  const response = await fetch(path, { ...init, headers, body, credentials: "include" });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as { error?: { message?: string } }) : null;
  if (!response.ok) throw new ApiError(data?.error?.message ?? "A API recusou o pedido.");
  return data as T;
}

export interface Health {
  ok: boolean;
  adapter: "fake" | "ec2";
  dev_auth: boolean;
  skew_ok: boolean;
  skew_ms: number;
}

export interface Me {
  email: string;
  role: "admin" | "operator" | "auditor";
}

export interface SeedCandidate {
  slug: string;
  display_name: string;
  aws_instance_id: string | null;
  aws_region: string | null;
  region_hint?: string;
  region_proven?: boolean;
  has_elastic_ip: boolean | null;
  origin_host: string | null;
  address_in_file: string | null;
  proof: string;
  registered?: boolean;
  hostnames: Array<{ hostname: string; health_url: string; wake_paths: string[]; note?: string }>;
  workloads: Array<{
    slug: string;
    display_name: string;
    runtime: "pm2" | "systemd" | "docker" | "node";
    unit_name: string;
    port: number | null;
    hostname: string | null;
  }>;
}

export interface FakeInstance {
  instance_id: string;
  region: string;
  power: string;
  public_ip: string | null;
  slug: string | null;
}

export function reasonHeader(reason: string): HeadersInit {
  return { "x-shiftgate-reason": reason };
}

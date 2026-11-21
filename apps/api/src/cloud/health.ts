import http from "node:http";
import https from "node:https";

export interface HealthTarget {
  address?: string;
  timeoutMs?: number;
}

export interface HealthProbe {
  check(url: string, target?: HealthTarget): Promise<boolean>;
}

export class MapHealth implements HealthProbe {
  readonly urls = new Map<string, boolean>();

  set(url: string, ok: boolean): void {
    this.urls.set(url, ok);
  }

  async check(url: string): Promise<boolean> {
    if (this.urls.has(url)) return this.urls.get(url) === true;
    return false;
  }
}

export function httpHealth(): HealthProbe {
  return {
    async check(url: string, target?: HealthTarget): Promise<boolean> {
      try {
        const timeoutMs = target?.timeoutMs ?? 4000;
        const direct = target?.address ? originHealthRequest(url, target.address) : null;
        if (direct) return await requestOrigin(direct, timeoutMs);
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
        return response.status >= 200 && response.status < 300;
      } catch {
        return false;
      }
    },
  };
}

export interface OriginHealthRequest {
  protocol: "https:" | "http:";
  host: string;
  servername: string;
  port: number;
  path: string;
  headers: { host: string };
}

export function originHealthRequest(url: string, address: string): OriginHealthRequest | null {
  if (!isIpv4(address)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port)) return null;
  return {
    protocol: parsed.protocol,
    host: address,
    servername: parsed.hostname,
    port,
    path: `${parsed.pathname}${parsed.search}`,
    headers: { host: parsed.host },
  };
}

function requestOrigin(spec: OriginHealthRequest, timeoutMs: number): Promise<boolean> {
  const transport = spec.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = transport.request(
      {
        host: spec.host,
        servername: spec.servername,
        port: spec.port,
        path: spec.path,
        method: "GET",
        headers: spec.headers,
        timeout: timeoutMs,
        rejectUnauthorized: true,
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        finish(status >= 200 && status < 300);
      },
    );
    req.on("error", () => finish(false));
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.end();
  });
}

function isIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

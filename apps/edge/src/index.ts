import { renderClosed, renderFailed, renderRetry, renderWait } from "./pages.ts";

export interface EdgeEnv {
  SHIFTGATE_API_BASE: string;
  EDGE_SHARED_SECRET: string;
}

interface AdmitResponse {
  decision: "proxy" | "wait" | "closed" | "failed";
  message?: string;
  origin?: string;
  retry_after_sec?: number;
  deadline_at?: string;
  event_id?: string;
  code?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: EdgeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
    if (!host || !env.SHIFTGATE_API_BASE) return text("controle indisponível", 503);

    if (url.pathname === "/__shiftgate/status") {
      const requestId = url.searchParams.get("request_id") ?? "";
      const status = await callApi(env, `/internal/gate/status?host=${encodeURIComponent(host)}&request_id=${encodeURIComponent(requestId)}`);
      if (!status) {
        return Response.json(
          { decision: "wait", retry_after_sec: 5, message: "Ligando a instância." },
          { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } },
        );
      }
      return Response.json(status, { headers: retry(status) });
    }

    const requestId = crypto.randomUUID();
    const admit = await callApi(env, "/internal/gate/admit", {
      method: "POST",
      body: JSON.stringify({ host, method: request.method, path: url.pathname, request_id: requestId }),
    });
    if (!admit) return html(renderRetry("Ligando a instância. A página abre o aplicativo sozinha."), 503);

    if (admit.decision === "proxy" && admit.origin) {
      const response = await proxyToOrigin(request, admit.origin, host);
      ctx.waitUntil(finish(env, host, request, requestId, response.status));
      return response;
    }
    if (admit.decision === "wait") {
      return html(renderWait(admit.message || "Ligando a instância.", admit.deadline_at, requestId), 503, admit.retry_after_sec);
    }
    if (admit.decision === "failed") return html(renderFailed(admit.message || "Não foi possível ligar.", admit.event_id), 503);
    return html(renderClosed(admit.message || "Fora do expediente."), 403);
  },
};

async function callApi(env: EdgeEnv, path: string, init?: RequestInit): Promise<AdmitResponse | null> {
  try {
    const response = await fetch(new URL(path, env.SHIFTGATE_API_BASE), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-shiftgate-edge": env.EDGE_SHARED_SECRET,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok && response.status !== 200) {
      const body = (await response.json().catch(() => null)) as AdmitResponse | null;
      if (body?.decision) return body;
      return null;
    }
    return (await response.json()) as AdmitResponse;
  } catch {
    return null;
  }
}

async function proxyToOrigin(request: Request, origin: string, host: string): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(origin);
  const headers = new Headers(request.headers);
  headers.set("host", host);
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", "https");
  const client = request.headers.get("cf-connecting-ip");
  if (client) headers.set("x-forwarded-for", client);
  headers.delete("x-shiftgate-edge");
  const init: RequestInit & { cf?: { resolveOverride: string } } = {
    method: request.method,
    headers,
    redirect: "manual",
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  };
  if (isIp(target.hostname)) {
    incoming.protocol = "https:";
    incoming.host = host;
    init.cf = { resolveOverride: target.hostname };
    return fetch(incoming.toString(), init);
  }
  incoming.protocol = target.protocol;
  incoming.host = target.host;
  return fetch(incoming.toString(), init);
}

async function finish(env: EdgeEnv, host: string, request: Request, requestId: string, status: number): Promise<void> {
  const path = new URL(request.url).pathname;
  await callApi(env, "/internal/gate/finish", {
    method: "POST",
    body: JSON.stringify({ host, method: request.method, path, request_id: requestId, status }),
  }).catch(() => undefined);
}

function isIp(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function retry(body: AdmitResponse): HeadersInit {
  return body.retry_after_sec ? { "retry-after": String(body.retry_after_sec) } : {};
}

function html(body: string, status: number, retryAfter?: number): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (retryAfter) headers.set("retry-after", String(retryAfter));
  return new Response(body, { status, headers });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

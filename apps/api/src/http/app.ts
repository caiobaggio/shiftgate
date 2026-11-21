import { existsSync, readFileSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { Actor, Clock, Deps } from "../deps.ts";
import { openDatabase, type DB } from "../db/index.ts";
import type { Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import { FakeCloud } from "../cloud/fake.ts";
import { AwsCloud } from "../cloud/aws.ts";
import { httpHealth, MapHealth, type HealthProbe } from "../cloud/health.ts";
import type { Cloud } from "../cloud/types.ts";
import { systemClock } from "../deps.ts";
import { admit, finishGate } from "../gate.ts";
import {
  createInstance,
  discoverInstance,
  listEvents,
  replaceHostnames,
  replaceInfra,
  replaceSchedules,
  replaceWorkloads,
  requestStart,
  requestStop,
  setActive,
  updateIdentity,
  updateIdle,
  updatePolicy,
  updateTiming,
} from "../fleet.ts";
import { currentDollarQuote } from "../fx.ts";
import { savingsReport } from "../savings.ts";
import { detailOf, findHost, jsonList } from "../model.ts";
import { HttpError } from "./errors.ts";
import { runTick } from "../runner.ts";
import { iso, secretsMatch, sha256, ulid } from "../util.ts";
import { SESSION_TTL_MS, MUTATIONS_PER_HOUR } from "../domain/types.ts";
import * as schemas from "./schemas.ts";

declare module "fastify" {
  interface FastifyRequest {
    operator: Actor | null;
    rawBody: string;
  }
}

export interface BuildOptions {
  config?: Config;
  db?: DB;
  cloud?: Cloud;
  health?: HealthProbe;
  clock?: Clock;
  ticker?: boolean;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? openDatabase(config.databasePath);
  const cloud = options.cloud ?? (config.awsAdapter === "ec2" ? new AwsCloud(config.ssmDocument) : new FakeCloud(config.fakeBootMs, config.fakeCloudPath));
  const health = options.health ?? (config.awsAdapter === "fake" ? new MapHealth() : httpHealth());
  const clock = options.clock ?? systemClock(config);
  const deps: Deps = { config, db, cloud, health, clock };
  bootstrap(deps);

  const app = Fastify({ logger: false });
  app.decorateRequest("operator", null);
  app.decorateRequest("rawBody", "");
  await app.register(cookie, { secret: config.sessionSecret || "dev" });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    request.rawBody = raw;
    if (!raw) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, event_id: error.eventId } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: "validation", message: error.issues.map((issue) => issue.message).join(" ") } });
    }
    const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
    if (status === 400) return reply.code(400).send({ error: { code: "validation", message: "JSON inválido." } });
    console.error(error);
    return reply.code(500).send({ error: { code: "conflict_phase", message: "Falha interna do Shiftgate." } });
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (path.startsWith("/internal") && panelHost(request.headers.host, config.panelPublicOrigin)) {
      return reply.code(404).send({ error: { code: "not_found", message: "A rota interna não mora no hostname do painel." } });
    }
    if (!path.startsWith("/api") || path === "/api/health" || path === "/api/session") return;
    request.operator = await resolveOperator(deps, request, reply);
    if (!request.operator) {
      return reply.code(401).send({ error: { code: "unauthenticated", message: "Sessão ausente." } });
    }
  });

  app.get("/api/health", async () => {
    db.get("SELECT 1 AS ok");
    const skew = clock.skewMs();
    return {
      ok: skew <= 30_000,
      sqlite: true,
      skew_ms: skew,
      skew_ok: skew <= 30_000,
      adapter: config.awsAdapter,
      dev_auth: config.devAuth,
      now: clock.now().toISOString(),
    };
  });

  app.post("/api/session", async (request, reply) => {
    if (!config.devAuth) throw new HttpError(404, "not_found", "Login local desligado.");
    const body = schemas.sessionSchema.parse(request.body);
    const operator = db.get<{ id: string; email: string; role: Actor["role"]; subject: string; disabled_at: string | null }>(
      "SELECT * FROM operators WHERE email = ?",
      body.email,
    );
    if (!operator || operator.disabled_at) throw new HttpError(401, "unauthenticated", "Operador não cadastrado.");
    issueSession(deps, reply, operator.id);
    return { email: operator.email, role: operator.role };
  });

  app.delete("/api/session", async (request, reply) => {
    const id = request.cookies.shiftgate_session;
    if (id) db.run("DELETE FROM sessions WHERE id = ?", id);
    reply.clearCookie("shiftgate_session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (request) => {
    if (!request.operator) throw new HttpError(401, "unauthenticated", "Sessão ausente.");
    return request.operator;
  });

  app.get("/api/savings", async (request) => {
    const query = request.query as { from?: string; to?: string; application?: string };
    return savingsReport(deps, query);
  });

  app.get("/api/fx", async () => currentDollarQuote());

  app.get("/api/instances", async (request) => {
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 500);
    const rows = query.cursor
      ? db.all<{ slug: string }>("SELECT slug FROM instances WHERE slug > ? ORDER BY slug LIMIT ?", query.cursor, limit)
      : db.all<{ slug: string }>("SELECT slug FROM instances ORDER BY slug LIMIT ?", limit);
    const instances = rows.map((row) => detailOf(db, row.slug, clock.now(), clock.skewMs(), config.controlPlaneInstanceId || null));
    return { instances, next_cursor: rows.length === limit ? rows[rows.length - 1]?.slug ?? null : null };
  });

  app.get("/api/instances/:slug", async (request) => {
    const slug = (request.params as { slug: string }).slug;
    const detail = detailOf(db, slug, clock.now(), clock.skewMs(), config.controlPlaneInstanceId || null);
    if (!detail) throw new HttpError(404, "not_found", "EC2 não encontrada.");
    return detail;
  });

  app.get("/api/instances/:slug/events", async (request) => {
    const slug = (request.params as { slug: string }).slug;
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    return listEvents(deps, slug, query.cursor ?? null, limit);
  });

  app.post("/api/instances", async (request, reply) =>
    mutate(deps, request, reply, async () => {
      const body = schemas.createSchema.parse(request.body);
      const detail = await createInstance(deps, actor(request), body);
      return { status: 201, body: detail };
    }),
  );

  app.patch("/api/instances/:slug", async (request, reply) =>
    mutate(deps, request, reply, async () => {
      const body = schemas.identitySchema.parse(request.body);
      return { status: 200, body: await updateIdentity(deps, actor(request), slugOf(request), body) };
    }),
  );

  app.put("/api/instances/:slug/schedules", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: replaceSchedules(deps, actor(request), slugOf(request), schemas.schedulesSchema.parse(request.body)),
    })),
  );

  app.put("/api/instances/:slug/idle", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: updateIdle(deps, actor(request), slugOf(request), schemas.idleSchema.parse(request.body).idle_minutes),
    })),
  );

  app.put("/api/instances/:slug/hostnames", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: replaceHostnames(deps, actor(request), slugOf(request), schemas.hostnamesSchema.parse(request.body).hostnames),
    })),
  );

  app.put("/api/instances/:slug/workloads", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: replaceWorkloads(deps, actor(request), slugOf(request), schemas.workloadsSchema.parse(request.body).workloads),
    })),
  );

  app.put("/api/instances/:slug/infra", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: replaceInfra(deps, actor(request), slugOf(request), schemas.infraSchema.parse(request.body).names),
    })),
  );

  app.put("/api/instances/:slug/policy", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: updatePolicy(deps, actor(request), slugOf(request), schemas.policySchema.parse(request.body)),
    })),
  );

  app.put("/api/instances/:slug/timing", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: updateTiming(deps, actor(request), slugOf(request), schemas.timingSchema.parse(request.body)),
    })),
  );

  app.post("/api/instances/:slug/deactivate", async (request, reply) =>
    mutate(deps, request, reply, async () => {
      const reason = requireReason(request, schemas.reasonSchema.parse(request.body).reason);
      return { status: 200, body: setActive(deps, actor(request), slugOf(request), false, reason) };
    }),
  );

  app.post("/api/instances/:slug/activate", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: setActive(deps, actor(request), slugOf(request), true, "reativar"),
    })),
  );

  app.post("/api/instances/:slug/start", async (request, reply) =>
    mutate(deps, request, reply, async () => {
      const body = schemas.startSchema.parse(request.body);
      if (body.hold_minutes) requireReason(request, body.reason);
      return { status: 202, body: await requestStart(deps, actor(request), slugOf(request), body) };
    }),
  );

  app.post("/api/instances/:slug/stop", async (request, reply) =>
    mutate(deps, request, reply, async () => {
      const body = schemas.stopSchema.parse(request.body);
      requireReason(request, body.reason);
      return { status: 202, body: await requestStop(deps, actor(request), slugOf(request), body) };
    }),
  );

  app.post("/api/instances/:slug/discover", async (request, reply) =>
    mutate(deps, request, reply, async () => ({
      status: 200,
      body: await discoverInstance(deps, actor(request), slugOf(request)),
    })),
  );

  app.get("/api/operators", async (request) => {
    if (actor(request).role !== "admin") throw new HttpError(403, "forbidden", "Só admin lista operadores.");
    return {
      operators: db.all("SELECT id, subject, email, role, disabled_at FROM operators ORDER BY email"),
    };
  });

  app.post("/api/operators", async (request, reply) =>
    mutate(deps, request, reply, async () => {
      if (actor(request).role !== "admin") throw new HttpError(403, "forbidden", "Só admin cria operador.");
      const body = schemas.operatorSchema.parse(request.body);
      const id = ulid();
      db.run("INSERT INTO operators (id, subject, email, role) VALUES (?, ?, ?, ?)", id, body.subject ?? body.email, body.email, body.role);
      return { status: 201, body: { id, email: body.email, role: body.role } };
    }),
  );

  app.get("/api/seed", async () => {
    const seed = JSON.parse(readFileSync(config.seedPath, "utf8")) as { candidates?: Array<{ slug: string }> };
    const taken = new Set(db.all<{ slug: string }>("SELECT slug FROM instances").map((row) => row.slug));
    return {
      ...seed,
      candidates: (seed.candidates ?? []).map((candidate) => ({ ...candidate, registered: taken.has(candidate.slug) })),
    };
  });

  app.post("/internal/gate/admit", async (request, reply) => {
    authorizeEdge(config, request);
    const body = schemas.admitSchema.parse(request.body);
    const result = await admit(deps, body, true);
    if (result.decision === "wait" && result.retry_after_sec) reply.header("retry-after", String(result.retry_after_sec));
    return result;
  });

  app.get("/internal/gate/status", async (request, reply) => {
    authorizeEdge(config, request);
    const query = request.query as { host?: string; request_id?: string };
    if (!query.host || !query.request_id) throw new HttpError(400, "validation", "host e request_id são obrigatórios.");
    const result = await admit(deps, { host: query.host, method: "GET", path: "/internal/gate/status", request_id: query.request_id }, false);
    if (result.decision === "wait" && result.retry_after_sec) reply.header("retry-after", String(result.retry_after_sec));
    return result;
  });

  app.post("/internal/gate/finish", async (request) => {
    authorizeEdge(config, request);
    finishGate(deps, schemas.finishSchema.parse(request.body));
    return { ok: true };
  });

  if (config.devAuth) {
    app.get("/dev/ligar", async (request, reply) => {
      request.operator = await resolveOperator(deps, request, reply);
      if (!request.operator) return reply.code(401).type("text/html").send("<p>Entre no painel antes de simular o acesso.</p>");
      const host = (request.query as { host?: string }).host ?? "";
      return reply.type("text/html").send(ligarPage(host));
    });
    app.get("/dev/ligar/poll", async (request, reply) => {
      request.operator = await resolveOperator(deps, request, reply);
      if (!request.operator) throw new HttpError(401, "unauthenticated", "Sessão ausente.");
      const query = request.query as { host?: string; request_id?: string };
      if (!query.host || !query.request_id) throw new HttpError(400, "validation", "host e request_id.");
      const located = findHost(db, query.host);
      const rule = located ? jsonList(located.host.wake_paths_json)[0] : undefined;
      const [method, ...rest] = (rule ?? "POST /").split(" ");
      const path = rest.join(" ") || "/";
      return admit(deps, { host: query.host, method, path, request_id: query.request_id }, true);
    });
  }

  app.post("/api/dev/fake-instances", async (request, reply) => {
    if (!(cloud instanceof FakeCloud)) throw new HttpError(404, "not_found", "O simulador não está ativo.");
    return mutate(deps, request, reply, async () => {
      if (actor(request).role !== "admin") throw new HttpError(403, "forbidden", "Só admin planta o simulador.");
      const body = schemas.plantSchema.parse(request.body);
      const box = cloud.plantWorkload({
        instanceId: body.instance_id,
        region: body.region,
        slug: body.slug,
        power: body.power,
        publicIp: body.public_ip,
        systemd: body.systemd,
        pm2: body.pm2,
        docker: body.docker,
        ssmOnline: body.ssm_online,
      });
      return { status: 201, body: { instance_id: box.instanceId, slug: body.slug, power: box.power } };
    });
  });

  app.get("/api/dev/fake-instances", async (request) => {
    if (!(cloud instanceof FakeCloud)) throw new HttpError(404, "not_found", "O simulador não está ativo.");
    if (actor(request).role === "auditor") {
      /* leitura permitida */
    }
    return {
      instances: cloud.list().map((box) => ({
        instance_id: box.instanceId,
        region: box.region,
        power: box.power,
        public_ip: box.publicIp,
        slug: box.tags["shiftgate:host"] ?? null,
        tags: box.tags,
      })),
    };
  });

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/internal") || request.url.startsWith("/dev")) {
        return reply.code(404).send({ error: { code: "not_found", message: "Rota não encontrada." } });
      }
      return reply.sendFile("index.html");
    });
  }

  if (options.ticker !== false && config.tickMs > 0) {
    const timer = setInterval(() => {
      void runTick(deps);
    }, config.tickMs);
    timer.unref?.();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  return app;
}

function bootstrap(deps: Deps): void {
  if (!deps.config.bootstrapAdminEmail) return;
  const email = deps.config.bootstrapAdminEmail;
  const existing = deps.db.get("SELECT id FROM operators WHERE email = ?", email);
  if (existing) return;
  deps.db.run(
    "INSERT INTO operators (id, subject, email, role) VALUES (?, ?, ?, 'admin')",
    ulid(),
    email,
    email,
  );
}

function issueSession(deps: Deps, reply: FastifyReply, operatorId: string): void {
  const now = deps.clock.now();
  const id = ulid(now.getTime());
  deps.db.run(
    "INSERT INTO sessions (id, operator_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    id,
    operatorId,
    iso(now, deps.config.timezone),
    iso(new Date(now.getTime() + SESSION_TTL_MS), deps.config.timezone),
  );
  reply.setCookie("shiftgate_session", id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: deps.config.panelPublicOrigin.startsWith("https://"),
  });
}

async function resolveOperator(deps: Deps, request: FastifyRequest, reply: FastifyReply): Promise<Actor | null> {
  const now = iso(deps.clock.now(), deps.config.timezone);
  const cookieId = request.cookies?.shiftgate_session;
  if (cookieId) {
    const row = deps.db.get<{ id: string; subject: string; email: string; role: Actor["role"] }>(
      `SELECT o.id, o.subject, o.email, o.role FROM sessions s
       JOIN operators o ON o.id = s.operator_id
       WHERE s.id = ? AND s.expires_at > ? AND o.disabled_at IS NULL`,
      cookieId,
      now,
    );
    if (row) return row;
  }
  const assertion = request.headers["cf-access-jwt-assertion"];
  const token = Array.isArray(assertion) ? assertion[0] : assertion;
  if (!token || !deps.config.accessAud || !deps.config.accessTeamDomain) return null;
  try {
    jwks ??= createRemoteJWKSet(new URL(`https://${deps.config.accessTeamDomain}/cdn-cgi/access/certs`));
    const verified = await jwtVerify(token, jwks, { audience: deps.config.accessAud });
    const subject = typeof verified.payload.sub === "string" ? verified.payload.sub : "";
    const email = typeof verified.payload.email === "string" ? verified.payload.email : "";
    if (!subject) return null;
    let operator = deps.db.get<{ id: string; subject: string; email: string; role: Actor["role"]; disabled_at: string | null }>(
      "SELECT * FROM operators WHERE subject = ?",
      subject,
    );
    if (!operator && email) {
      operator = deps.db.get("SELECT * FROM operators WHERE email = ?", email);
      if (operator && !operator.disabled_at) deps.db.run("UPDATE operators SET subject = ? WHERE id = ?", subject, operator.id);
    }
    if (!operator || operator.disabled_at) return null;
    issueSession(deps, reply, operator.id);
    return { id: operator.id, subject, email: operator.email, role: operator.role };
  } catch {
    return null;
  }
}

function panelHost(hostHeader: string | undefined, origin: string): boolean {
  if (!hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

function authorizeEdge(config: Config, request: FastifyRequest): void {
  const header = request.headers["x-shiftgate-edge"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!secretsMatch(value, config.edgeSecrets)) throw new HttpError(401, "unauthenticated", "Segredo da borda recusado.");
}

function actor(request: FastifyRequest): Actor {
  if (!request.operator) throw new HttpError(401, "unauthenticated", "Sessão ausente.");
  return request.operator;
}

function slugOf(request: FastifyRequest): string {
  return (request.params as { slug: string }).slug;
}

function requireReason(request: FastifyRequest, bodyReason: string | undefined): string {
  const header = request.headers["x-shiftgate-reason"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim() || bodyReason?.trim() || "";
  if (value.length < 12) throw new HttpError(400, "validation", "Informe o motivo, com pelo menos 12 caracteres.");
  return value;
}

async function mutate(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<unknown> {
  const current = actor(request);
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) throw new HttpError(400, "validation", "Idempotency-Key é obrigatória.");
  const path = request.url.split("?")[0] ?? request.url;
  const hash = sha256(request.rawBody || JSON.stringify(request.body ?? {}));
  const existing = deps.db.get<{ body_hash: string; path: string; status: number; response_json: string }>(
    "SELECT * FROM idempotency WHERE actor_id = ? AND key = ?",
    current.id,
    key,
  );
  if (existing) {
    if (existing.body_hash !== hash || existing.path !== path) {
      throw new HttpError(409, "idempotency_replay", "A mesma chave veio com outro corpo.");
    }
    return reply.code(existing.status).send(JSON.parse(existing.response_json) as unknown);
  }
  const since = iso(new Date(deps.clock.now().getTime() - 60 * 60_000), deps.config.timezone);
  const count = Number(deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mutations WHERE actor_id = ? AND at >= ?", current.id, since)?.n ?? 0);
  if (count >= MUTATIONS_PER_HOUR) throw new HttpError(429, "forbidden", "Limite de 30 mutações por hora.");
  const result = await handler();
  const stamp = iso(deps.clock.now(), deps.config.timezone);
  deps.db.run(
    "INSERT INTO idempotency (actor_id, key, method, path, body_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    current.id,
    key,
    request.method,
    path,
    hash,
    result.status,
    JSON.stringify(result.body),
    stamp,
  );
  deps.db.run("INSERT INTO mutations (id, actor_id, at) VALUES (?, ?, ?)", ulid(), current.id, stamp);
  return reply.code(result.status).send(result.body);
}

function ligarPage(host: string): string {
  const safe = host.replace(/[&<>"']/g, "");
  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<title>Ligando</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14160f; color: #f3efe4; font-family: "Segoe UI", sans-serif; }
  main { width: min(32rem, calc(100% - 2rem)); }
  p { color: #c9c2b2; line-height: 1.5; }
  .mark { letter-spacing: .14em; text-transform: uppercase; font-size: .75rem; color: #e6a23c; }
</style>
<main>
  <p class="mark">Shiftgate</p>
  <h1 id="title">Ligando</h1>
  <p id="message">Consultando o controle.</p>
</main>
<script>
  const host = ${JSON.stringify(safe)};
  const requestId = crypto.randomUUID();
  async function poll() {
    const response = await fetch("/dev/ligar/poll?host=" + encodeURIComponent(host) + "&request_id=" + encodeURIComponent(requestId), { credentials: "include" });
    const body = await response.json();
    document.getElementById("title").textContent = body.decision === "proxy" ? "Liberado" : body.decision === "wait" ? "Ligando" : "Fechado";
    document.getElementById("message").textContent = body.message || body.decision;
    if (body.decision === "wait") setTimeout(poll, (body.retry_after_sec || 5) * 1000);
  }
  poll();
</script>`;
}

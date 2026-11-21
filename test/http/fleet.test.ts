import { describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/http/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { FakeCloud } from "../../apps/api/src/cloud/fake.ts";
import { MapHealth } from "../../apps/api/src/cloud/health.ts";
import { runTick } from "../../apps/api/src/runner.ts";
import type { Clock } from "../../apps/api/src/deps.ts";

const NOW = new Date("2026-10-19T22:00:00.000Z");

function clock(): Clock {
  return { now: () => NOW, skewMs: () => 0 };
}

async function harness() {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DEV_AUTH: "1",
    BOOTSTRAP_ADMIN_EMAIL: "admin@shiftgate.local",
    AWS_ADAPTER: "fake",
    CONTROL_PLANE_INSTANCE_ID: "i-0cccccccc0000000c",
    EDGE_SHARED_SECRETS: "edge-test-secret",
    SESSION_SECRET: "test-secret",
    PANEL_PUBLIC_ORIGIN: "http://localhost:5173",
    FAKE_HEALTH: "off",
  });
  config.devAuth = true;
  config.bootstrapAdminEmail = "admin@shiftgate.local";
  config.awsAdapter = "fake";
  config.controlPlaneInstanceId = "i-0cccccccc0000000c";
  config.edgeSecrets = ["edge-test-secret"];
  config.fakeHealthFollowsPower = false;
  config.tickMs = 0;
  const db = openDatabase(":memory:");
  const cloud = new FakeCloud(0);
  const health = new MapHealth();
  const app = await buildApp({ config, db, cloud, health, clock: clock(), ticker: false });
  const login = await app.inject({ method: "POST", url: "/api/session", payload: { email: "admin@shiftgate.local" } });
  const setCookie = login.headers["set-cookie"];
  const cookie = String(setCookie).split(";")[0];
  return { app, db, cloud, health, config, cookie, clock: clock() };
}

function auth(cookie: string, key: string, extra: Record<string, string> = {}) {
  return { cookie, "idempotency-key": key, ...extra };
}

const office = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_local: "05:00", end_local: "18:00" }));

describe("HTTP da frota", () => {
  it("cria ficha nova sem lista compilada, e doze cabem", async () => {
    const { app, cloud, cookie } = await harness();
    for (let index = 0; index < 12; index += 1) {
      const id = `i-${index.toString(16).padStart(17, "a")}`;
      cloud.plantWorkload({ instanceId: id, region: "us-east-2", slug: `caixa-${index}`, power: "stopped" });
      const response = await app.inject({
        method: "POST",
        url: "/api/instances",
        headers: auth(cookie, `create-${index}`),
        payload: {
          display_name: `Caixa ${index}`,
          slug: `caixa-${index}`,
          aws_region: "us-east-2",
          aws_instance_id: id,
          has_elastic_ip: true,
          origin_host: `10.0.0.${index + 1}`,
          idle_minutes: 20,
          hostnames: index === 0
            ? [{ hostname: "caixa-0.local", health_url: "http://caixa-0.local/health", wake_paths: [] }]
            : [],
          schedules: [],
        },
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    const list = await app.inject({ method: "GET", url: "/api/instances?limit=50", headers: { cookie } });
    expect(list.json().instances).toHaveLength(12);
    const born = await app.inject({ method: "GET", url: "/api/instances/caixa-0", headers: { cookie } });
    expect(born.json().automation).toBe("enforce");
    expect(born.json().instance_stop_enabled).toBe(true);
    expect(born.json().windows.map((window: { weekday: number }) => window.weekday).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(born.json().hostnames[0].wake_paths).toEqual(["GET /", "GET /login"]);
    await app.close();
  });

  it("tag ausente e plano de controle não entram; ficha nova já nasce em enforce", async () => {
    const { app, cloud, cookie } = await harness();
    cloud.plant({
      instanceId: "i-0ddddddd00000000d",
      region: "us-east-2",
      power: "running",
      publicIp: null,
      ssmOnline: true,
      tags: {},
      observed: { systemd: [], pm2: [], docker: [] },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: auth(cookie, "no-tag"),
      payload: {
        display_name: "Sem tag",
        slug: "sem-tag",
        aws_region: "us-east-2",
        aws_instance_id: "i-0ddddddd00000000d",
        has_elastic_ip: true,
        idle_minutes: 20,
        hostnames: [],
        schedules: [],
      },
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe("tag_mismatch");

    cloud.plantWorkload({
      instanceId: "i-0cccccccc0000000c",
      region: "us-east-2",
      slug: "nano",
      power: "running",
    });
    const nano = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: auth(cookie, "nano"),
      payload: {
        display_name: "Nano",
        slug: "nano",
        aws_region: "us-east-2",
        aws_instance_id: "i-0cccccccc0000000c",
        has_elastic_ip: true,
        idle_minutes: 20,
        hostnames: [],
        schedules: [],
      },
    });
    expect(nano.json().error.code).toBe("control_plane_protected");

    cloud.plantWorkload({
      instanceId: "i-0eeeeeee00000000e",
      region: "us-east-2",
      slug: "ensaio-a",
      power: "stopped",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: auth(cookie, "ensaio"),
      payload: {
        display_name: "Ensaio A",
        slug: "ensaio-a",
        aws_region: "us-east-2",
        aws_instance_id: "i-0eeeeeee00000000e",
        has_elastic_ip: true,
        origin_host: "203.0.113.10",
        idle_minutes: 20,
        hostnames: [{ hostname: "ensaio-a.local", health_url: "http://ensaio-a.local/health", wake_paths: ["POST /sessions"] }],
        schedules: office,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().automation).toBe("enforce");
    expect(created.json().instance_stop_enabled).toBe(true);
    const start = await app.inject({
      method: "POST",
      url: "/api/instances/ensaio-a/start",
      headers: auth(cookie, "start-enforce", { "x-shiftgate-reason": "ligar ensaio agora" }),
      payload: { reason: "ligar ensaio agora" },
    });
    expect(start.statusCode, start.body).toBe(202);
    expect(cloud.starts).toEqual(["i-0eeeeeee00000000e"]);
    await app.close();
  });

  it("duas EC2 não herdam turno nem idle, e desativar não para", async () => {
    const h = await harness();
    await plantAndCreate(h, "ensaio-a", "i-0aaaaaaa000000001", 20, office);
    await plantAndCreate(h, "ensaio-b", "i-0bbbbbbb000000002", 60, [{ weekday: 1, start_local: "00:00", end_local: "00:00" }]);
    for (const slug of ["ensaio-a", "ensaio-b"]) {
      const policy = await h.app.inject({
        method: "PUT",
        url: `/api/instances/${slug}/policy`,
        headers: auth(h.cookie, `policy-${slug}`),
        payload: { automation: "enforce", instance_stop_enabled: true },
      });
      expect(policy.statusCode, policy.body).toBe(200);
      h.health.set(`http://${slug}.local/health`, true);
    }
    await runTick({ ...h, clock: h.clock });
    const first = await h.app.inject({ method: "GET", url: "/api/instances/ensaio-a", headers: { cookie: h.cookie } });
    const second = await h.app.inject({ method: "GET", url: "/api/instances/ensaio-b", headers: { cookie: h.cookie } });
    expect(first.json().phase).not.toBe(second.json().phase);
    expect(second.json().phase).toBe("schedule_hold");
    const off = await h.app.inject({
      method: "POST",
      url: "/api/instances/ensaio-b/deactivate",
      headers: auth(h.cookie, "off-b", { "x-shiftgate-reason": "tirar do tick de teste" }),
      payload: { reason: "tirar do tick de teste" },
    });
    expect(off.statusCode).toBe(200);
    expect(h.cloud.stops).toEqual([]);
    await h.app.close();
  });

  it("serviço desconhecido bloqueia o stop e o wake sobe só a dona do hostname", async () => {
    const h = await harness();
    await plantAndCreate(h, "ensaio-a", "i-0aaaaaaa000000001", 20, []);
    h.cloud.boxes.get("i-0aaaaaaa000000001")!.observed.systemd.push("vizinho.service");
    h.cloud.boxes.get("i-0aaaaaaa000000001")!.power = "running";
    await h.app.inject({
      method: "PUT",
      url: "/api/instances/ensaio-a/policy",
      headers: auth(h.cookie, "enf-a"),
      payload: { automation: "enforce", instance_stop_enabled: true },
    });
    const discovered = await h.app.inject({
      method: "POST",
      url: "/api/instances/ensaio-a/discover",
      headers: auth(h.cookie, "disc-a"),
    });
    expect(discovered.json().block_instance_stop).toBe(true);
    const stop = await h.app.inject({
      method: "POST",
      url: "/api/instances/ensaio-a/stop",
      headers: auth(h.cookie, "stop-a", { "x-shiftgate-reason": "parar com vizinho solto" }),
      payload: { reason: "parar com vizinho solto", confirm_slug: "ensaio-a" },
    });
    expect(stop.statusCode).toBe(409);
    expect(stop.json().error.code).toBe("unregistered_service");
    expect(h.cloud.stops).toEqual([]);

    await plantAndCreate(h, "ensaio-b", "i-0bbbbbbb000000002", 20, []);
    h.cloud.boxes.get("i-0bbbbbbb000000002")!.power = "stopped";
    h.db.run("UPDATE instances SET phase = 'off', power = 'stopped' WHERE slug = 'ensaio-b'");
    await h.app.inject({
      method: "PUT",
      url: "/api/instances/ensaio-b/policy",
      headers: auth(h.cookie, "enf-b"),
      payload: { automation: "enforce", instance_stop_enabled: false },
    });
    const closed = await h.app.inject({
      method: "POST",
      url: "/internal/gate/admit",
      headers: { "x-shiftgate-edge": "edge-test-secret" },
      payload: { host: "ensaio-b.local", method: "GET", path: "/", request_id: "req-1" },
    });
    expect(closed.json().decision).toBe("closed");
    expect(h.cloud.starts).toEqual([]);
    const waking = await h.app.inject({
      method: "POST",
      url: "/internal/gate/admit",
      headers: { "x-shiftgate-edge": "edge-test-secret" },
      payload: { host: "ensaio-b.local", method: "POST", path: "/sessions", request_id: "req-2" },
    });
    expect(waking.statusCode, waking.body).toBe(200);
    expect(waking.json().decision).toBe("wait");
    expect(h.cloud.starts).toEqual(["i-0bbbbbbb000000002"]);
    const again = await h.app.inject({
      method: "POST",
      url: "/internal/gate/admit",
      headers: { "x-shiftgate-edge": "edge-test-secret" },
      payload: { host: "ensaio-b.local", method: "POST", path: "/sessions", request_id: "req-3" },
    });
    expect(again.json().beginWake ?? again.json().decision).not.toBe("proxy");
    expect(h.cloud.starts).toEqual(["i-0bbbbbbb000000002"]);
    const unknown = await h.app.inject({
      method: "POST",
      url: "/internal/gate/admit",
      headers: { "x-shiftgate-edge": "edge-test-secret" },
      payload: { host: "ninguem.local", method: "POST", path: "/sessions", request_id: "req-4" },
    });
    expect(unknown.json().decision).toBe("closed");
    await h.app.close();
  });

  it("repete a resposta idempotente e o auditor não cria", async () => {
    const h = await harness();
    cloudReady(h.cloud, "i-0aaaaaaa000000001", "ensaio-a");
    const payload = {
      display_name: "Ensaio A",
      slug: "ensaio-a",
      aws_region: "us-east-2",
      aws_instance_id: "i-0aaaaaaa000000001",
      has_elastic_ip: true,
      idle_minutes: 20,
      hostnames: [],
      schedules: [],
    };
    const first = await h.app.inject({ method: "POST", url: "/api/instances", headers: auth(h.cookie, "same"), payload });
    const second = await h.app.inject({ method: "POST", url: "/api/instances", headers: auth(h.cookie, "same"), payload });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    const clash = await h.app.inject({
      method: "POST",
      url: "/api/instances",
      headers: auth(h.cookie, "same"),
      payload: { ...payload, display_name: "Outro nome" },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe("idempotency_replay");

    await h.app.inject({
      method: "POST",
      url: "/api/operators",
      headers: auth(h.cookie, "auditor"),
      payload: { email: "auditor@shiftgate.local", role: "auditor" },
    });
    const login = await h.app.inject({ method: "POST", url: "/api/session", payload: { email: "auditor@shiftgate.local" } });
    const auditor = String(login.headers["set-cookie"]).split(";")[0];
    const denied = await h.app.inject({
      method: "POST",
      url: "/api/instances",
      headers: auth(auditor, "nope"),
      payload: { ...payload, slug: "outra", aws_instance_id: "i-0bbbbbbb000000002" },
    });
    expect(denied.statusCode).toBe(403);
    await h.app.close();
  });
});

function cloudReady(cloud: FakeCloud, instanceId: string, slug: string) {
  cloud.plantWorkload({
    instanceId,
    region: "us-east-2",
    slug,
    power: "running",
    publicIp: "203.0.113.10",
    systemd: ["nginx.service"],
  });
}

async function plantAndCreate(
  h: Awaited<ReturnType<typeof harness>>,
  slug: string,
  instanceId: string,
  idle: number,
  schedules: Array<{ weekday: number; start_local: string; end_local: string }>,
) {
  cloudReady(h.cloud, instanceId, slug);
  const response = await h.app.inject({
    method: "POST",
    url: "/api/instances",
    headers: auth(h.cookie, `make-${slug}`),
    payload: {
      display_name: slug,
      slug,
      aws_region: "us-east-2",
      aws_instance_id: instanceId,
      has_elastic_ip: true,
      origin_host: "203.0.113.20",
      idle_minutes: idle,
      hostnames: [{ hostname: `${slug}.local`, health_url: `http://${slug}.local/health`, wake_paths: ["POST /sessions"] }],
      schedules,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
}

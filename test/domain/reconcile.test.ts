import { describe, expect, it } from "vitest";
import { applyUserTraffic, reconcile } from "../../apps/api/src/domain/reconcile.ts";
import { office, NOW, snap, tick } from "./fixture.ts";

describe("duas fichas não se herdam", () => {
  it("o silêncio de uma não arma o stop da outra", () => {
    const ctx = tick();
    const cold = reconcile(snap({ id: "A", slug: "ensaio-a", idleMinutes: 20 }), ctx);
    const warm = reconcile(
      snap({
        id: "B",
        slug: "ensaio-b",
        awsInstanceId: "i-0bbbbbbb000000002",
        idleMinutes: 60,
        lastUserRequestAt: new Date(NOW.getTime() - 21 * 60_000),
      }),
      ctx,
    );
    expect(cold.phase).toBe("draining");
    expect(cold.callStop).toBe(false);
    expect(warm.phase).toBe("on");
    expect(warm.callStop).toBe(false);
    expect(warm.intention).toBeNull();
  });

  it("o fim do turno de uma não muda a fase da outra", () => {
    const ctx = tick({ now: new Date("2026-10-19T22:00:00.000Z") });
    const leaving = reconcile(
      snap({
        slug: "ensaio-a",
        windows: office,
        phase: "schedule_hold",
        lastUserRequestAt: new Date(ctx.now.getTime() - 30 * 60_000),
      }),
      ctx,
    );
    const staying = reconcile(
      snap({
        slug: "ensaio-b",
        awsInstanceId: "i-0bbbbbbb000000002",
        windows: [{ weekday: 1, startLocal: "00:00", endLocal: "00:00" }],
        phase: "schedule_hold",
        lastUserRequestAt: new Date(ctx.now.getTime() - 30 * 60_000),
      }),
      ctx,
    );
    expect(leaving.phase).toBe("draining");
    expect(staying.phase).toBe("schedule_hold");
    expect(staying.callStop).toBe(false);
  });
});

describe("turno", () => {
  it("dentro da janela não desliga e liga se estiver parada", () => {
    const running = reconcile(
      snap({
        windows: office,
        phase: "schedule_hold",
        lastUserRequestAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
      }),
      tick(),
    );
    expect(running.phase).toBe("schedule_hold");
    expect(running.callStop).toBe(false);

    const stopped = reconcile(
      snap({ windows: office, phase: "off", power: "stopped", describedPower: undefined }),
      tick({ describedPower: "stopped" }),
    );
    expect(stopped.phase).toBe("waking");
    expect(stopped.callStart).toBe(true);
  });

  it("no fim da janela, uso recente segura; silêncio entra em drain", () => {
    const ctx = tick({ now: new Date("2026-10-19T22:00:00.000Z") });
    const recent = reconcile(
      snap({
        windows: office,
        phase: "schedule_hold",
        lastUserRequestAt: new Date(ctx.now.getTime() - 5 * 60_000),
      }),
      ctx,
    );
    expect(recent.phase).toBe("on");
    expect(recent.callStop).toBe(false);

    const quiet = reconcile(
      snap({
        windows: office,
        phase: "schedule_hold",
        lastUserRequestAt: new Date(ctx.now.getTime() - 21 * 60_000),
      }),
      ctx,
    );
    expect(quiet.phase).toBe("draining");
    expect(quiet.callQuiesce).toBe(true);
    expect(quiet.callStop).toBe(false);
  });

  it("respeita min_off na partida de turno e min_runtime no idle", () => {
    const held = reconcile(
      snap({
        windows: office,
        phase: "off",
        power: "stopped",
        lastOffAt: new Date(NOW.getTime() - 30_000),
      }),
      tick({ describedPower: "stopped" }),
    );
    expect(held.phase).toBe("off");
    expect(held.callStart).toBe(false);

    const young = reconcile(
      snap({ becameHealthyAt: new Date(NOW.getTime() - 60_000) }),
      tick(),
    );
    expect(young.phase).toBe("on");
    expect(young.callStop).toBe(false);
  });

  it("alarme de turno perdido se segue parada", () => {
    const result = reconcile(
      snap({
        windows: office,
        phase: "off",
        power: "stopped",
        powerChangedAt: new Date(NOW.getTime() - 6 * 60_000),
        lastOffAt: new Date(NOW.getTime() - 6 * 60_000),
      }),
      tick({ describedPower: "stopped" }),
    );
    expect(result.callStart).toBe(true);
    expect(result.alarms).toContain("schedule_miss");
  });
});

describe("stop da EC2", () => {
  it("quiesce cumprida pede StopInstances só dessa ficha", () => {
    const result = reconcile(
      snap({
        phase: "draining",
        drainStartedAt: new Date(NOW.getTime() - 61_000),
      }),
      tick(),
    );
    expect(result.phase).toBe("stopping");
    expect(result.callStop).toBe(true);
  });

  it("serviço desconhecido, flag desligada, skew, observe e plano de controle não chamam a AWS", () => {
    const dirty = reconcile(snap({ blockInstanceStop: true }), tick({ describedPower: "running" }));
    expect(dirty.power).toBe("blocked");
    expect(dirty.callStop).toBe(false);
    expect(dirty.phase).not.toBe("stopping");

    const disabled = reconcile(snap({ instanceStopEnabled: false }), tick());
    expect(disabled.callStop).toBe(false);
    expect(disabled.phase).toBe("on");

    const skew = reconcile(snap(), tick({ skewMs: 31_000 }));
    expect(skew.callStop).toBe(false);
    expect(skew.alarms).toContain("clock_skew");
    expect(skew.phase).toBe("on");

    const observe = reconcile(snap({ automation: "observe" }), tick());
    expect(observe.callStop).toBe(false);
    expect(observe.intention).toBe("stop");
    expect(observe.events.some((event) => event.action === "observe_skipped")).toBe(true);

    const nano = reconcile(snap({ awsInstanceId: "i-0cccccccc0000000c" }), tick());
    expect(nano.callStop).toBe(false);
    expect(nano.phase).toBe("on");
  });

  it("override hold on segura depois do turno; hold off vence o turno", () => {
    const outside = new Date("2026-10-19T22:00:00.000Z");
    const held = reconcile(
      snap({
        windows: office,
        phase: "manual_override",
        override: { id: "ov1", hold: "on", expiresAt: new Date(outside.getTime() + 30 * 60_000) },
        lastUserRequestAt: new Date(outside.getTime() - 3 * 60 * 60_000),
      }),
      tick({ now: outside }),
    );
    expect(held.phase).toBe("manual_override");
    expect(held.callStop).toBe(false);

    const forced = reconcile(
      snap({
        windows: office,
        phase: "manual_override",
        override: { id: "ov2", hold: "off", expiresAt: new Date(NOW.getTime() + 30 * 60_000) },
      }),
      tick(),
    );
    expect(forced.phase).toBe("draining");
    expect(forced.callStop).toBe(false);
  });

  it("override expirado dentro do turno volta para schedule_hold", () => {
    const result = reconcile(
      snap({
        windows: office,
        phase: "manual_override",
        override: { id: "ov", hold: "on", expiresAt: new Date(NOW.getTime() - 1000) },
      }),
      tick(),
    );
    expect(result.clearOverride).toBe(true);
    expect(result.phase).toBe("schedule_hold");
  });

  it("request durante o drain cancela", () => {
    const current = snap({ phase: "draining", drainStartedAt: new Date(NOW.getTime() - 10_000) });
    const traffic = applyUserTraffic(current, NOW, true);
    expect(traffic.phase).toBe("on");
    expect(traffic.drainStartedAt).toBeNull();
    expect(traffic.events[0]?.action).toBe("drain_cancelled");
    expect(traffic.lastUserRequestAt).toEqual(NOW);
  });

  it("desativada não muda de fase", () => {
    const result = reconcile(snap({ deactivated: true, phase: "on" }), tick());
    expect(result.phase).toBe("on");
    expect(result.callStart).toBe(false);
    expect(result.callStop).toBe(false);
  });
});

describe("boot, flap e backoff", () => {
  it("health ok dentro do turno vai para schedule_hold sem segundo start", () => {
    const result = reconcile(
      snap({
        windows: office,
        phase: "starting",
        power: "running",
        wakeStartedAt: new Date(NOW.getTime() - 20_000),
        anyHealthy: true,
      }),
      tick({ describedPower: "running" }),
    );
    expect(result.phase).toBe("schedule_hold");
    expect(result.callStart).toBe(false);
    expect(result.startAttempts).toBe(0);
    expect(result.releaseLock).toBe(true);
  });

  it("estouro do teto vai para erro e a quarta falha não tenta de novo", () => {
    const failed = reconcile(
      snap({
        windows: office,
        phase: "starting",
        power: "running",
        anyHealthy: false,
        wakeStartedAt: new Date(NOW.getTime() - 181_000),
        startAttempts: 0,
      }),
      tick({ describedPower: "running" }),
    );
    expect(failed.phase).toBe("error");
    expect(failed.startAttempts).toBe(1);

    const sticky = reconcile(
      snap({
        windows: office,
        phase: "error",
        power: "stopped",
        startAttempts: 4,
        phaseChangedAt: new Date(NOW.getTime() - 20 * 60_000),
        anyHealthy: false,
      }),
      tick({ describedPower: "stopped" }),
    );
    expect(sticky.phase).toBe("error");
    expect(sticky.callStart).toBe(false);

    const retry = reconcile(
      snap({
        windows: office,
        phase: "error",
        power: "stopped",
        startAttempts: 3,
        phaseChangedAt: new Date(NOW.getTime() - 601_000),
        anyHealthy: false,
        lastOffAt: new Date(NOW.getTime() - 601_000),
      }),
      tick({ describedPower: "stopped" }),
    );
    expect(retry.phase).toBe("waking");
    expect(retry.callStart).toBe(true);
  });

  it("três ciclos em 30 min caem em erro", () => {
    const result = reconcile(
      snap({
        phase: "stopping",
        power: "stopping",
        flapCount: 2,
        flapWindowStartedAt: new Date(NOW.getTime() - 10 * 60_000),
      }),
      tick({ describedPower: "stopped" }),
    );
    expect(result.phase).toBe("error");
    expect(result.flapCount).toBe(3);
    expect(result.alarms).toContain("flap");
  });

  it("sem hostname, no ar e no turno, sai do erro para schedule_hold", () => {
    const result = reconcile(
      snap({
        windows: office,
        phase: "error",
        power: "running",
        anyHealthy: false,
        hostnameCount: 0,
        becameHealthyAt: null,
        startAttempts: 4,
        phaseChangedAt: new Date(NOW.getTime() - 20 * 60_000),
      }),
      tick({ describedPower: "running" }),
    );
    expect(result.phase).toBe("schedule_hold");
    expect(result.callStart).toBe(false);
    expect(result.callStop).toBe(false);
    expect(result.startAttempts).toBe(0);
  });

  it("sem hostname, no ar e fora do turno, sai do erro e entra em drain", () => {
    const outside = new Date("2026-10-19T22:00:00.000Z");
    const result = reconcile(
      snap({
        windows: office,
        phase: "error",
        power: "running",
        anyHealthy: false,
        hostnameCount: 0,
        becameHealthyAt: null,
        healthyAt: null,
        powerChangedAt: new Date(outside.getTime() - 30 * 60_000),
        phaseChangedAt: new Date(outside.getTime() - 30 * 60_000),
        startAttempts: 1,
        lastUserRequestAt: null,
      }),
      tick({ now: outside, describedPower: "running" }),
    );
    expect(result.phase).toBe("draining");
    expect(result.callStop).toBe(false);
    expect(result.startAttempts).toBe(0);
  });

  it("a quarta falha sem hostname, fora do turno, não reabre o stop", () => {
    const outside = new Date("2026-10-19T22:00:00.000Z");
    const result = reconcile(
      snap({
        windows: office,
        phase: "error",
        power: "running",
        anyHealthy: false,
        hostnameCount: 0,
        startAttempts: 4,
        phaseChangedAt: new Date(outside.getTime() - 30 * 60_000),
      }),
      tick({ now: outside, describedPower: "running" }),
    );
    expect(result.phase).toBe("error");
    expect(result.callStop).toBe(false);
  });

  it("starting sem hostname no turno vira schedule_hold sem esperar health", () => {
    const result = reconcile(
      snap({
        windows: office,
        phase: "starting",
        power: "running",
        anyHealthy: false,
        hostnameCount: 0,
        wakeStartedAt: new Date(NOW.getTime() - 181_000),
        becameHealthyAt: null,
      }),
      tick({ describedPower: "running" }),
    );
    expect(result.phase).toBe("schedule_hold");
    expect(result.startAttempts).toBe(0);
    expect(result.callStart).toBe(false);
  });

  it("no turno, com hostname e health parado, o erro volta a esperar o serviço", () => {
    const result = reconcile(
      snap({
        windows: office,
        phase: "error",
        power: "running",
        anyHealthy: false,
        hostnameCount: 1,
        startAttempts: 1,
        phaseChangedAt: new Date(NOW.getTime() - 61_000),
      }),
      tick({ describedPower: "running" }),
    );
    expect(result.phase).toBe("starting");
    expect(result.callStart).toBe(false);
    expect(result.wakeStartedAt).toBe(NOW);
  });

  it("em observação o turno parado não chama StartInstances", () => {
    const result = reconcile(
      snap({
        windows: office,
        automation: "observe",
        phase: "off",
        power: "stopped",
      }),
      tick({ describedPower: "stopped" }),
    );
    expect(result.phase).toBe("off");
    expect(result.callStart).toBe(false);
    expect(result.intention).toBe("start");
  });
});

import { describe, expect, it } from "vitest";
import { decideAdmit } from "../../apps/api/src/domain/admit.ts";
import { office, NOW, snap } from "./fixture.ts";

function admit(over: Parameters<typeof decideAdmit>[0]["snapshot"] extends infer S ? Partial<NonNullable<S>> : never, extra: Partial<Parameters<typeof decideAdmit>[0]> = {}) {
  return decideAdmit({
    snapshot: snap({ phase: "off", power: "stopped", ...over }),
    method: "POST",
    path: "/sessions",
    wakeAllowed: true,
    healthFresh: false,
    now: NOW,
    automaticStartsInLastHour: 0,
    allowStart: true,
    ...extra,
  });
}

describe("admit por hostname", () => {
  it("fora do turno e na allowlist arma um wake; fora da allowlist não", () => {
    const open = admit({});
    expect(open.decision).toBe("wait");
    expect(open.beginWake).toBe(true);
    expect(open.waitKind).toBe("instance");
    expect(open.consumesBudget).toBe(true);

    const closed = admit({}, { wakeAllowed: false });
    expect(closed.decision).toBe("closed");
    expect(closed.beginWake).toBe(false);
  });

  it("a quarta partida automática da hora não chama a AWS", () => {
    const result = admit({}, { automaticStartsInLastHour: 3 });
    expect(result.decision).toBe("closed");
    expect(result.code).toBe("wake_budget");
    expect(result.beginWake).toBe(false);
  });

  it("no turno, parada, o visitante usa o mesmo start e não gasta o orçamento", () => {
    const result = admit({ windows: office }, { wakeAllowed: false, automaticStartsInLastHour: 3 });
    expect(result.beginWake).toBe(true);
    expect(result.consumesBudget).toBe(false);
  });

  it("já acordando não pede outro start", () => {
    const result = admit({
      phase: "starting",
      power: "running",
      wakeStartedAt: new Date(NOW.getTime() - 10_000),
    });
    expect(result.decision).toBe("wait");
    expect(result.beginWake).toBe(false);
    expect(result.waitKind).toBe("health");
  });

  it("health fresco em schedule_hold libera proxy", () => {
    const result = admit(
      { phase: "schedule_hold", power: "running", windows: office },
      { healthFresh: true, wakeAllowed: false },
    );
    expect(result.decision).toBe("proxy");
    expect(result.beginWake).toBe(false);
  });

  it("hostname sem ficha, desativada, hold off, observe e sem EIP não ligam", () => {
    expect(decideAdmit({
      snapshot: null,
      method: "GET",
      path: "/",
      wakeAllowed: false,
      healthFresh: false,
      now: NOW,
      automaticStartsInLastHour: 0,
      allowStart: true,
    }).decision).toBe("closed");

    expect(admit({ deactivated: true }).code).toBe("inactive");
    expect(admit({
      phase: "manual_override",
      override: { id: "ov", hold: "off", expiresAt: new Date(NOW.getTime() + 60_000) },
    }).beginWake).toBe(false);
    expect(admit({ automation: "observe" }).code).toBe("observe_only");
    expect(admit({ hasElasticIp: false }).code).toBe("validation");
  });

  it("erro em cooldown não liga; skew não entra na conta do admit", () => {
    const cooling = admit({
      phase: "error",
      startAttempts: 1,
      phaseChangedAt: new Date(NOW.getTime() - 10_000),
    });
    expect(cooling.decision).toBe("failed");
    expect(cooling.code).toBe("cooldown");
    expect(cooling.beginWake).toBe(false);
  });

  it("drain com health cancela e libera", () => {
    const result = admit(
      { phase: "draining", power: "running", drainStartedAt: new Date(NOW.getTime() - 5_000) },
      { healthFresh: true },
    );
    expect(result.decision).toBe("proxy");
    expect(result.cancelDrain).toBe(true);
  });
});

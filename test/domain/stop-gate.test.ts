import { describe, expect, it } from "vitest";
import { evaluateStop } from "../../apps/api/src/domain/stop-gate.ts";
import { NOW, snap } from "./fixture.ts";

const weekday = {
  weekday: 1,
  startLocal: "05:00",
  endLocal: "18:00",
};

describe("stop gate", () => {
  it("dentro do turno a observação não mascara o horário", () => {
    const decision = evaluateStop(
      snap({ automation: "observe", windows: [weekday], phase: "schedule_hold" }),
      NOW,
      0,
      null,
    );
    expect(decision.code).toBe("in_shift");
    expect(decision.desired).toBe(false);
    expect(decision.call).toBe(false);
  });

  it("fora do turno, em observação, a chamada não sai", () => {
    const decision = evaluateStop(snap({ automation: "observe" }), NOW, 0, null);
    expect(decision.code).toBe("observe_only");
    expect(decision.desired).toBe(true);
    expect(decision.call).toBe(false);
  });
});

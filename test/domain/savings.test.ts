import { describe, expect, it } from "vitest";
import { occupancy } from "../../apps/api/src/domain/savings.ts";
import { linuxHourlyUsd } from "../../apps/api/src/domain/prices.ts";

const START = Date.parse("2026-10-22T03:00:00.000Z");

describe("tempo economizado", () => {
  it("conta só a fase desligada e separa o dia em São Paulo", () => {
    const result = occupancy({
      points: [
        { at: START, phase: "off" },
        { at: START + 2 * 3_600_000, phase: "on" },
        { at: START + 3 * 3_600_000, phase: "off" },
      ],
      createdAt: START,
      phaseChangedAt: START + 3 * 3_600_000,
      currentPhase: "off",
      from: START,
      to: START + 5 * 3_600_000,
      now: START + 5 * 3_600_000,
      zone: "America/Sao_Paulo",
    });
    expect(result.stoppedMs).toBe(4 * 3_600_000);
    expect(result.runningMs).toBe(1 * 3_600_000);
    expect(result.unknownMs).toBe(0);
    expect(result.days).toEqual([{ day: "2026-10-22", stoppedMs: 4 * 3_600_000, runningMs: 1 * 3_600_000 }]);
  });

  it("deixa sem leitura o intervalo anterior ao primeiro evento", () => {
    const result = occupancy({
      points: [{ at: START + 2 * 3_600_000, phase: "schedule_hold" }],
      createdAt: START,
      phaseChangedAt: START + 2 * 3_600_000,
      currentPhase: "schedule_hold",
      from: START,
      to: START + 4 * 3_600_000,
      now: START + 4 * 3_600_000,
      zone: "America/Sao_Paulo",
    });
    expect(result.unknownMs).toBe(2 * 3_600_000);
    expect(result.runningMs).toBe(2 * 3_600_000);
    expect(result.stoppedMs).toBe(0);
  });

  it("conhece a hora do t3.micro em Ohio", () => {
    expect(linuxHourlyUsd("us-east-2", "t3.micro")).toBe(0.0104);
    expect(linuxHourlyUsd("us-east-1", "t3.micro")).toBeNull();
    expect(linuxHourlyUsd("us-east-2", "p5.48xlarge")).toBeNull();
  });
});

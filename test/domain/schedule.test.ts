import { describe, expect, it } from "vitest";
import { isInShift, summarizeWindows } from "../../apps/api/src/domain/schedule.ts";
import type { Window } from "../../apps/api/src/domain/types.ts";

const office: Window[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startLocal: "05:00",
  endLocal: "18:00",
}));

describe("turno em America/Sao_Paulo", () => {
  it("não trata o instante UTC como horário local", () => {
    const instant = new Date("2026-10-19T07:30:00.000Z");
    expect(isInShift(instant, office, "America/Sao_Paulo")).toBe(false);
    expect(isInShift(instant, office, "UTC")).toBe(true);
  });

  it("inclui o meio do expediente e exclui o instante final", () => {
    expect(isInShift(new Date("2026-10-19T15:00:00.000Z"), office, "America/Sao_Paulo")).toBe(true);
    expect(isInShift(new Date("2026-10-19T20:59:00.000Z"), office, "America/Sao_Paulo")).toBe(true);
    expect(isInShift(new Date("2026-10-19T21:00:00.000Z"), office, "America/Sao_Paulo")).toBe(false);
  });

  it("cruza a meia-noite a partir do weekday de início", () => {
    const night: Window[] = [{ weekday: 1, startLocal: "22:00", endLocal: "06:00" }];
    expect(isInShift(new Date("2026-10-20T02:00:00.000Z"), night, "America/Sao_Paulo")).toBe(true);
    expect(isInShift(new Date("2026-10-20T05:00:00.000Z"), night, "America/Sao_Paulo")).toBe(true);
    expect(isInShift(new Date("2026-10-20T09:00:00.000Z"), night, "America/Sao_Paulo")).toBe(false);
    expect(isInShift(new Date("2026-10-19T23:00:00.000Z"), night, "America/Sao_Paulo")).toBe(false);
  });

  it("00:00–00:00 nos sete dias é turno de 24 h", () => {
    const always = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      startLocal: "00:00",
      endLocal: "00:00",
    }));
    expect(isInShift(new Date("2026-10-19T21:30:00.000Z"), always, "America/Sao_Paulo")).toBe(true);
    expect(summarizeWindows(always)).toBe("24 h");
  });

  it("resume seg–sex sem citar outra EC2", () => {
    expect(summarizeWindows(office)).toBe("seg–sex 05:00–18:00");
    expect(summarizeWindows([])).toBe("sem turno");
  });
});

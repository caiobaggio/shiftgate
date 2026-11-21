import { describe, expect, it } from "vitest";
import { brlFromUsd, parsePtax } from "../../apps/api/src/domain/fx.ts";
import { loadDollarQuote } from "../../apps/api/src/fx.ts";

describe("conversão para real", () => {
  it("usa a PTAX venda mais recente", () => {
    const quote = parsePtax({
      value: [
        { cotacaoVenda: 5.014, dataHoraCotacao: "2026-10-20 13:09:36.250006" },
        { cotacaoVenda: 5.0277, dataHoraCotacao: "2026-10-21 13:08:17.041224" },
      ],
    });
    expect(quote).toEqual({ rate: 5.0277, quotedOn: "2026-10-21" });
  });

  it("soma 14% sobre o dólar convertido", () => {
    expect(brlFromUsd(1, 5.0277)).toBeCloseTo(5.0277 * 1.14, 8);
    expect(brlFromUsd(0.14191334444444445, 5.0277)).toBeCloseTo(0.14191334444444445 * 5.0277 * 1.14, 8);
  });

  it("recusa payload sem venda", () => {
    expect(parsePtax({ value: [] })).toBeNull();
    expect(parsePtax(null)).toBeNull();
  });

  it("monta a nota com a data da cotação", async () => {
    const quote = await loadDollarQuote(async () => new Response(JSON.stringify({
      value: [{ cotacaoVenda: 5.0277, dataHoraCotacao: "2026-10-21 13:08:17.041224" }],
    })));
    expect(quote.rate).toBe(5.0277);
    expect(quote.tax_rate).toBe(0.14);
    expect(quote.note).toBe("PTAX venda de 21/10/2026 a R$ 5,0277. O real soma 14% de imposto.");
  });
});

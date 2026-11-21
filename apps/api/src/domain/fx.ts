export const TAX_RATE = 0.14;

export interface PtaxQuote {
  rate: number;
  quotedOn: string;
}

export function brlFromUsd(usd: number, rate: number, taxRate = TAX_RATE): number {
  return usd * rate * (1 + taxRate);
}

export function parsePtax(payload: unknown): PtaxQuote | null {
  const rows = payload && typeof payload === "object" && "value" in payload ? payload.value : null;
  if (!Array.isArray(rows)) return null;
  let best: PtaxQuote | null = null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rate = "cotacaoVenda" in row ? Number(row.cotacaoVenda) : NaN;
    const stamp = "dataHoraCotacao" in row ? String(row.dataHoraCotacao) : "";
    const quotedOn = stamp.slice(0, 10);
    if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(quotedOn)) continue;
    if (!best || stamp > best.quotedOn) best = { rate, quotedOn: stamp };
  }
  if (!best) return null;
  return { rate: best.rate, quotedOn: best.quotedOn.slice(0, 10) };
}

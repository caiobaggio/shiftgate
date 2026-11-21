import { DateTime } from "luxon";
import { parsePtax, TAX_RATE } from "./domain/fx.ts";

const ZONE = "America/Sao_Paulo";
const TTL_MS = 60 * 60 * 1000;

export interface DollarQuote {
  rate: number | null;
  tax_rate: number;
  quoted_on: string | null;
  source: string;
  note: string;
}

let cached: { at: number; quote: DollarQuote } | null = null;

export async function currentDollarQuote(): Promise<DollarQuote> {
  if (cached && cached.quote.rate !== null && Date.now() - cached.at < TTL_MS) return cached.quote;
  const quote = await loadDollarQuote(fetch);
  if (quote.rate !== null) cached = { at: Date.now(), quote };
  return quote;
}

export async function loadDollarQuote(fetchImpl: typeof fetch, now = new Date()): Promise<DollarQuote> {
  const end = DateTime.fromJSDate(now, { zone: ZONE });
  const start = end.minus({ days: 10 });
  const url = ptaxUrl(start.toFormat("MM-dd-yyyy"), end.toFormat("MM-dd-yyyy"));
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "shiftgate" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return missing();
    const quote = parsePtax(await response.json());
    if (!quote) return missing();
    const shown = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(quote.rate);
    const [year, month, day] = quote.quotedOn.split("-");
    return {
      rate: quote.rate,
      tax_rate: TAX_RATE,
      quoted_on: quote.quotedOn,
      source: "PTAX venda",
      note: `PTAX venda de ${day}/${month}/${year} a R$ ${shown}. O real soma 14% de imposto.`,
    };
  } catch {
    return missing();
  }
}

function missing(): DollarQuote {
  return {
    rate: null,
    tax_rate: TAX_RATE,
    quoted_on: null,
    source: "PTAX venda",
    note: "Cotação PTAX indisponível. O real fica sem valor até a próxima leitura.",
  };
}

function ptaxUrl(start: string, end: string): string {
  const query = `@dataInicial='${start}'&@dataFinalCotacao='${end}'&$top=5&$orderby=dataHoraCotacao%20desc&$format=json`;
  return `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?${query}`;
}

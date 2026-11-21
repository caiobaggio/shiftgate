import { useEffect, useState } from "react";
import { api } from "./api.ts";

interface SavingsInstance {
  slug: string;
  display_name: string;
  aws_instance_id: string;
  aws_region: string;
  instance_type: string | null;
  application: string | null;
  stopped_ms: number;
  running_ms: number;
  unknown_ms: number;
  percent: number;
  hourly_usd: number | null;
  usd: number | null;
}

interface SavingsReport {
  from: string;
  to: string;
  price_note: string;
  applications: string[];
  totals: { stopped_ms: number; running_ms: number; percent: number; usd: number | null };
  days: Array<{ day: string; stopped_ms: number; running_ms: number }>;
  instances: SavingsInstance[];
}

interface DollarQuote {
  rate: number | null;
  tax_rate: number;
  quoted_on: string | null;
  source: string;
  note: string;
}

type Preset = "today" | "7" | "30" | "month";
type Currency = "USD" | "BRL";

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "today", label: "Hoje" },
  { id: "7", label: "7 dias" },
  { id: "30", label: "30 dias" },
  { id: "month", label: "Este mês" },
];

export function SavingsPage() {
  const opening = monthSpan();
  const [preset, setPreset] = useState<Preset | null>("month");
  const [fromDay, setFromDay] = useState(opening.from);
  const [toDay, setToDay] = useState(opening.to);
  const [application, setApplication] = useState("");
  const [currency, setCurrency] = useState<Currency>(storedCurrency);
  const [fx, setFx] = useState<DollarQuote | null>(null);
  const [report, setReport] = useState<SavingsReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const { from, to } = bounds(fromDay, toDay);
    const params = new URLSearchParams({ from, to });
    if (application) params.set("application", application);
    let cancel = false;
    void api<SavingsReport>(`/api/savings?${params.toString()}`)
      .then((body) => {
        if (!cancel) {
          setReport(body);
          setError("");
        }
      })
      .catch((caught: unknown) => {
        if (!cancel) setError(caught instanceof Error ? caught.message : "Falha ao calcular.");
      });
    return () => {
      cancel = true;
    };
  }, [fromDay, toDay, application]);

  useEffect(() => {
    let cancel = false;
    void api<DollarQuote>("/api/fx")
      .then((body) => {
        if (!cancel) setFx(body);
      })
      .catch(() => {
        if (!cancel) setFx(null);
      });
    return () => {
      cancel = true;
    };
  }, []);

  const maxDay = Math.max(1, ...(report?.days.map((day) => day.stopped_ms) ?? [1]));

  function choosePreset(next: Preset) {
    const span = next === "month" ? monthSpan() : next === "today" ? { from: dayStamp(new Date()), to: dayStamp(new Date()) } : rollingSpan(next === "7" ? 7 : 30);
    setPreset(next);
    setFromDay(span.from);
    setToDay(span.to);
  }

  function chooseFrom(value: string) {
    if (!value) return;
    const nextTo = value > toDay ? value : toDay;
    const clamped = clampSpan(value, nextTo);
    setPreset(null);
    setFromDay(clamped.from);
    setToDay(clamped.to);
  }

  function chooseTo(value: string) {
    if (!value) return;
    const nextFrom = value < fromDay ? value : fromDay;
    const clamped = clampSpan(nextFrom, value);
    setPreset(null);
    setFromDay(clamped.from);
    setToDay(clamped.to);
  }
  function chooseCurrency(next: Currency) {
    setCurrency(next);
    try {
      localStorage.setItem("shiftgate-currency", next);
    } catch {
      /* a preferência fica só nesta visita */
    }
  }

  function money(usd: number | null): string {
    if (usd === null) return "sem tarifa";
    if (currency === "USD") return formatUsd(usd);
    if (!fx) return "lendo cotação";
    if (fx.rate === null) return "sem cotação";
    return formatBrl(usd * fx.rate * (1 + fx.tax_rate));
  }

  return (
    <>
      <div className="top">
        <div>
          <h2>Acompanhamento</h2>
          <p className="lede">
            Tempo em que cada EC2 ficou desligada. O valor usa a hora do tipo, em Linux sob demanda. {report?.price_note}
            {currency === "BRL" ? ` ${fx?.note ?? "Lendo a PTAX."}` : ""}
          </p>
        </div>
      </div>

      <div className="filters">
        <div className="choices">
          <div className="segment" role="group" aria-label="Período">
            {PRESETS.map((item) => (
              <button key={item.id} className={preset === item.id ? "solid" : "ghost"} aria-pressed={preset === item.id} onClick={() => choosePreset(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="segment" role="group" aria-label="Moeda">
            <button className={currency === "USD" ? "solid" : "ghost"} aria-pressed={currency === "USD"} onClick={() => chooseCurrency("USD")}>Dólar</button>
            <button className={currency === "BRL" ? "solid" : "ghost"} aria-pressed={currency === "BRL"} onClick={() => chooseCurrency("BRL")}>Real + 14%</button>
          </div>
        </div>
        <div className="choices">
          <label className="compact">
            Início
            <input type="date" aria-label="Data início" value={fromDay} max={toDay} onChange={(event) => chooseFrom(event.target.value)} />
          </label>
          <label className="compact">
            Fim
            <input type="date" aria-label="Data fim" value={toDay} min={fromDay} max={dayStamp(new Date())} onChange={(event) => chooseTo(event.target.value)} />
          </label>
          <label>
            Application
            <select aria-label="Tag Application" value={application} onChange={(event) => setApplication(event.target.value)}>
              <option value="">Todas</option>
              {(report?.applications ?? []).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              <option value="__none">Sem tag Application</option>
            </select>
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {report && (
        <>
          <section className="gauges three" aria-label="Totais do período">
            <article className="gauge" data-tone="hold">
              <span className="kicker">Tempo parado</span>
              <strong>{formatDuration(report.totals.stopped_ms)}</strong>
              <p>absoluto no período</p>
            </article>
            <article className="gauge" data-tone="ok">
              <span className="kicker">Percentual</span>
              <strong>{formatPercent(report.totals.percent)}</strong>
              <p>do tempo acompanhado</p>
            </article>
            <article className="gauge" data-tone={report.totals.usd === null ? "idle" : "ok"}>
              <span className="kicker">Economia</span>
              <strong>{money(report.totals.usd)}</strong>
              <p>{currency === "BRL" ? "PTAX venda mais 14%" : "soma dos tipos com tarifa"}</p>
            </article>
          </section>

          {report.days.length > 1 && (
            <section className="card">
              <h3>Por dia</h3>
              <div className="columns" aria-label="Horas paradas por dia">
                {report.days.map((day) => (
                  <div key={day.day} className="column" title={`${dayLabel(day.day)}: ${formatDuration(day.stopped_ms)} parada`}>
                    <i style={{ height: `${Math.max(4, (day.stopped_ms / maxDay) * 100)}%` }} />
                    <span>{dayLabel(day.day)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <h3>Por instância</h3>
            {report.instances.length === 0 ? (
              <p className="lede">Nenhuma EC2 neste filtro.</p>
            ) : (
              <ul className="bars">
                {report.instances.map((item) => {
                  const whole = item.stopped_ms + item.running_ms + item.unknown_ms || 1;
                  return (
                    <li key={item.slug}>
                      <div className="bar-name">
                        <strong>{item.display_name}</strong>
                        <span className="mono">{item.instance_type ?? "tipo não lido"} · {item.application ?? "sem Application"} · {item.aws_region}</span>
                      </div>
                      <div className="track" aria-hidden="true">
                        <i className="saved" style={{ width: `${(item.stopped_ms / whole) * 100}%` }} />
                        <i className="ran" style={{ width: `${(item.running_ms / whole) * 100}%` }} />
                      </div>
                      <div className="bar-meta">
                        <span>{formatDuration(item.stopped_ms)} parada</span>
                        <span>{formatPercent(item.percent)}</span>
                        <span>{money(item.usd)}{item.hourly_usd !== null ? ` · ${money(item.hourly_usd)}/h` : ""}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="lede">A faixa clara é o tempo desligado. A faixa verde é o tempo no ar, inclusive o boot. Sem histórico de fase, o trecho fica sem cor.</p>
          </section>
        </>
      )}
    </>
  );
}

function dayStamp(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function monthSpan(now = new Date()): { from: string; to: string } {
  return { from: dayStamp(new Date(now.getFullYear(), now.getMonth(), 1)), to: dayStamp(now) };
}

function rollingSpan(days: number, now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: dayStamp(start), to: dayStamp(now) };
}

function clampSpan(from: string, to: string): { from: string; to: string } {
  const start = parseDay(from);
  const end = parseDay(to);
  const max = 366 * 24 * 3_600_000;
  if (end.getTime() - start.getTime() <= max) return { from, to };
  return { from: dayStamp(new Date(end.getTime() - max)), to };
}

function bounds(fromDay: string, toDay: string): { from: string; to: string } {
  const start = parseDay(fromDay);
  const endExclusive = parseDay(toDay);
  endExclusive.setDate(endExclusive.getDate() + 1);
  const now = new Date();
  const to = endExclusive.getTime() > now.getTime() ? now : new Date(endExclusive.getTime() - 1);
  const from = start.getTime() >= to.getTime() ? new Date(to.getTime() - 60_000) : start;
  return { from: from.toISOString(), to: to.toISOString() };
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, (month || 1) - 1, date || 1);
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}min`;
}

function formatPercent(fraction: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 }).format(fraction);
}

function storedCurrency(): Currency {
  try {
    return localStorage.getItem("shiftgate-currency") === "BRL" ? "BRL" : "USD";
  } catch {
    return "USD";
  }
}

function formatUsd(usd: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" }).format(usd);
}

function formatBrl(brl: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(brl);
}

function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${date}/${month}`;
}

import type { Deps } from "./deps.ts";
import { linuxHourlyUsd, PRICE_NOTE } from "./domain/prices.ts";
import { occupancy } from "./domain/savings.ts";
import { httpError } from "./http/errors.ts";

const ZONE = "America/Sao_Paulo";
const MAX_SPAN_MS = 366 * 24 * 3_600_000;

export interface SavingsInstance {
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

export interface SavingsReport {
  from: string;
  to: string;
  zone: string;
  price_note: string;
  applications: string[];
  totals: { stopped_ms: number; running_ms: number; percent: number; usd: number | null };
  days: Array<{ day: string; stopped_ms: number; running_ms: number }>;
  instances: SavingsInstance[];
}

export async function savingsReport(
  deps: Deps,
  query: { from?: string; to?: string; application?: string },
): Promise<SavingsReport> {
  const now = deps.clock.now();
  const to = query.to ? parseInstant(query.to, "to") : now;
  const from = query.from ? parseInstant(query.from, "from") : new Date(to.getTime() - 7 * 24 * 3_600_000);
  if (to.getTime() <= from.getTime()) throw httpError(400, "validation", "O período precisa ter começo antes do fim.");
  if (to.getTime() - from.getTime() > MAX_SPAN_MS) throw httpError(400, "validation", "O período máximo é de 366 dias.");

  const rows = deps.db.all<{
    id: string;
    slug: string;
    display_name: string;
    aws_instance_id: string;
    aws_region: string;
    phase: string;
    phase_changed_at: string;
    created_at: string;
  }>("SELECT id, slug, display_name, aws_instance_id, aws_region, phase, phase_changed_at, created_at FROM instances ORDER BY display_name");

  const described = await Promise.all(
    rows.map(async (row) => {
      try {
        return await deps.cloud.describeInstance(row.aws_region, row.aws_instance_id);
      } catch {
        return null;
      }
    }),
  );

  const applications = new Set<string>();
  const instances: SavingsInstance[] = [];
  const dayTotals = new Map<string, { day: string; stopped_ms: number; running_ms: number }>();

  rows.forEach((row, index) => {
    const live = described[index];
    const application = live?.tags.Application?.trim() || null;
    if (application) applications.add(application);
    if (query.application === "__none") {
      if (application) return;
    } else if (query.application && application !== query.application) {
      return;
    }

    const points = deps.db.all<{ at: string; to_phase: string }>(
      "SELECT at, to_phase FROM events WHERE instance_id = ? AND action = 'phase_changed' AND to_phase IS NOT NULL ORDER BY at",
      row.id,
    );
    const span = occupancy({
      points: points.map((point) => ({ at: Date.parse(point.at), phase: point.to_phase })),
      createdAt: Date.parse(row.created_at),
      phaseChangedAt: Date.parse(row.phase_changed_at),
      currentPhase: row.phase,
      from: from.getTime(),
      to: to.getTime(),
      now: now.getTime(),
      zone: ZONE,
    });
    const hourly = linuxHourlyUsd(row.aws_region, live?.instanceType ?? null);
    const observed = span.stoppedMs + span.runningMs + span.unknownMs;
    instances.push({
      slug: row.slug,
      display_name: row.display_name,
      aws_instance_id: row.aws_instance_id,
      aws_region: row.aws_region,
      instance_type: live?.instanceType ?? null,
      application,
      stopped_ms: span.stoppedMs,
      running_ms: span.runningMs,
      unknown_ms: span.unknownMs,
      percent: observed > 0 ? span.stoppedMs / observed : 0,
      hourly_usd: hourly,
      usd: hourly === null ? null : (span.stoppedMs / 3_600_000) * hourly,
    });
    for (const day of span.days) {
      const current = dayTotals.get(day.day) ?? { day: day.day, stopped_ms: 0, running_ms: 0 };
      current.stopped_ms += day.stoppedMs;
      current.running_ms += day.runningMs;
      dayTotals.set(day.day, current);
    }
  });

  const stopped = instances.reduce((sum, item) => sum + item.stopped_ms, 0);
  const running = instances.reduce((sum, item) => sum + item.running_ms, 0);
  const unknown = instances.reduce((sum, item) => sum + item.unknown_ms, 0);
  const observed = stopped + running + unknown;
  const priced = instances.filter((item) => item.usd !== null);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    zone: ZONE,
    price_note: PRICE_NOTE,
    applications: [...applications].sort((a, b) => a.localeCompare(b, "pt-BR")),
    totals: {
      stopped_ms: stopped,
      running_ms: running,
      percent: observed > 0 ? stopped / observed : 0,
      usd: priced.length === 0 ? null : priced.reduce((sum, item) => sum + (item.usd ?? 0), 0),
    },
    days: [...dayTotals.values()].sort((a, b) => a.day.localeCompare(b.day)),
    instances,
  };
}

function parseInstant(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw httpError(400, "validation", `Data inválida em ${label}.`);
  return parsed;
}

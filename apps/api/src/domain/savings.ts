import { DateTime } from "luxon";

export interface PhasePoint {
  at: number;
  phase: string;
}

export interface DaySavings {
  day: string;
  stoppedMs: number;
  runningMs: number;
}

export interface Occupancy {
  stoppedMs: number;
  runningMs: number;
  unknownMs: number;
  days: DaySavings[];
}

export function occupancy(input: {
  points: PhasePoint[];
  createdAt: number;
  phaseChangedAt: number;
  currentPhase: string;
  from: number;
  to: number;
  now: number;
  zone: string;
}): Occupancy {
  const end = Math.min(input.to, input.now);
  const start = Math.max(input.from, input.createdAt);
  const days = daysIn(input.from, end, input.zone);
  if (!(end > start)) return { stoppedMs: 0, runningMs: 0, unknownMs: 0, days };

  const marks = [...input.points, { at: input.phaseChangedAt, phase: input.currentPhase }].sort((a, b) => a.at - b.at);
  const bounds = [start];
  for (const mark of marks) {
    if (mark.at > start && mark.at < end) bounds.push(mark.at);
  }
  bounds.push(end);

  let stoppedMs = 0;
  let runningMs = 0;
  let unknownMs = 0;
  const byDay = new Map(days.map((day) => [day.day, day]));

  for (let index = 0; index < bounds.length - 1; index += 1) {
    const from = bounds[index]!;
    const to = bounds[index + 1]!;
    const phase = phaseAt(marks, from);
    const kind = phase === null ? "unknown" : phase === "off" ? "stopped" : "running";
    if (kind === "stopped") stoppedMs += to - from;
    else if (kind === "running") runningMs += to - from;
    else unknownMs += to - from;
    addSpan(byDay, from, to, kind, input.zone);
  }

  return { stoppedMs, runningMs, unknownMs, days: [...byDay.values()] };
}

function phaseAt(marks: PhasePoint[], at: number): string | null {
  let phase: string | null = null;
  for (const mark of marks) {
    if (mark.at > at) break;
    phase = mark.phase;
  }
  return phase;
}

function daysIn(from: number, to: number, zone: string): DaySavings[] {
  if (!(to > from)) return [];
  const days: DaySavings[] = [];
  let cursor = DateTime.fromMillis(from, { zone }).startOf("day");
  const last = DateTime.fromMillis(to - 1, { zone }).startOf("day");
  while (cursor <= last) {
    days.push({ day: cursor.toISODate() ?? cursor.toFormat("yyyy-LL-dd"), stoppedMs: 0, runningMs: 0 });
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

function addSpan(days: Map<string, DaySavings>, from: number, to: number, kind: "stopped" | "running" | "unknown", zone: string): void {
  let cursor = from;
  while (cursor < to) {
    const day = DateTime.fromMillis(cursor, { zone });
    const next = day.endOf("day").plus({ milliseconds: 1 }).toMillis();
    const slice = Math.min(to, next) - cursor;
    const key = day.toISODate() ?? day.toFormat("yyyy-LL-dd");
    const row = days.get(key) ?? { day: key, stoppedMs: 0, runningMs: 0 };
    if (kind === "stopped") row.stoppedMs += slice;
    if (kind === "running") row.runningMs += slice;
    days.set(key, row);
    cursor += slice;
  }
}

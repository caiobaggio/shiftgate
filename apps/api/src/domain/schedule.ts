import { DateTime } from "luxon";
import { DAY_SHORT } from "../../../../packages/contracts/src/index.ts";
import type { Window } from "./types.ts";

export function toMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === 24 && minute === 0) return 24 * 60;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function covers(minutes: number, start: number, end: number): boolean {
  if (start === end) return start === 0;
  if (end === 24 * 60 && start === 0) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** Janela da EC2 em horário local. `start > end` cruza a meia-noite no weekday de início. */
export function isInShift(now: Date, windows: Window[], timezone: string): boolean {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) return false;
  const weekday = local.weekday;
  const minutes = local.hour * 60 + local.minute;
  for (const window of windows) {
    const start = toMinutes(window.startLocal);
    const end = toMinutes(window.endLocal);
    if (start === null || end === null) continue;
    if (start < end || (start === 0 && end === 0) || end === 24 * 60) {
      if (window.weekday === weekday && covers(minutes, start, end === 0 && start === 0 ? 24 * 60 : end)) {
        return true;
      }
      continue;
    }
    if (window.weekday === weekday && minutes >= start) return true;
    const previous = weekday === 1 ? 7 : weekday - 1;
    if (window.weekday === previous && minutes < end) return true;
  }
  return false;
}

function fullDay(window: Window): boolean {
  const start = toMinutes(window.startLocal);
  const end = toMinutes(window.endLocal);
  return start === 0 && (end === 0 || end === 24 * 60);
}

function compressDays(days: number[]): string {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < unique.length) {
    let end = index;
    while (end + 1 < unique.length && unique[end + 1] === unique[end] + 1) end += 1;
    const from = DAY_SHORT[unique[index]];
    const to = DAY_SHORT[unique[end]];
    parts.push(index === end ? from : `${from}–${to}`);
    index = end + 1;
  }
  return parts.join(", ");
}

export function summarizeWindows(windows: Window[]): string {
  if (windows.length === 0) return "sem turno";
  const days = new Set(windows.map((window) => window.weekday));
  if (days.size === 7 && windows.every(fullDay)) return "24 h";
  const grouped = new Map<string, number[]>();
  for (const window of [...windows].sort((a, b) => a.weekday - b.weekday)) {
    const key = `${window.startLocal}–${window.endLocal}`;
    grouped.set(key, [...(grouped.get(key) ?? []), window.weekday]);
  }
  return [...grouped.entries()].map(([hours, weekdays]) => `${compressDays(weekdays)} ${hours}`).join("; ");
}

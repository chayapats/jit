import { AppError } from "../../errors";
import { validTimezone, wallToUtc } from "../../jobs/schedule-policy";

/**
 * `s16-routine-schedule/v1` recurrence. Wall-clock kinds are evaluated in the routine's explicit IANA
 * timezone, never the host zone; `interval` counts absolute minutes from the confirmation anchor.
 */
export type RoutineRecurrence =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "interval"; minutes: number };
/** How a wall-clock time was interpreted: as written, moved past a DST gap, or the first of a repeated hour. */
export type RoutineResolution = "exact" | "gap_shifted" | "overlap_first";
/** One computed instant with its local reading and DST interpretation. */
export interface RoutineInstant { at: number; local: string; resolution: RoutineResolution }

/** Fixed schedule bounds. A missed-run scan never evaluates more than `scanLimit` instants. */
export const scheduleLimits = Object.freeze({ intervalMinutes: { min: 15, max: 10080 }, scanLimit: 10000, horizonDays: 366 });

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/, datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const invalid = (): never => { throw new AppError("invalid_routine_schedule"); };
const exactKeys = (value: Record<string, unknown>, keys: string[]) => { const own = Object.keys(value).sort(); if (own.length !== keys.length || own.some((key, index) => key !== [...keys].sort()[index])) invalid(); };

/** Validates a recurrence and timezone exactly; unknown fields, zones or impossible dates refuse. */
export function validateRecurrence(value: unknown, timezone: unknown): asserts value is RoutineRecurrence {
  if (!validTimezone(timezone)) throw new AppError("invalid_routine_timezone");
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const rec = value as Record<string, unknown>;
  if (rec.kind === "once") {
    exactKeys(rec, ["kind", "date", "time"]);
    const match = typeof rec.date === "string" ? datePattern.exec(rec.date) : null;
    if (!match || typeof rec.time !== "string" || !timePattern.test(rec.time)) invalid();
    const [y, m, d] = [Number(match![1]), Number(match![2]), Number(match![3])], date = new Date(Date.UTC(y, m - 1, d));
    if (y < 2000 || y > 2200 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) invalid();
  } else if (rec.kind === "daily") {
    exactKeys(rec, ["kind", "time"]); if (typeof rec.time !== "string" || !timePattern.test(rec.time)) invalid();
  } else if (rec.kind === "weekly") {
    exactKeys(rec, ["kind", "days", "time"]);
    if (typeof rec.time !== "string" || !timePattern.test(rec.time) || !Array.isArray(rec.days) || !rec.days.length || rec.days.length > 7) invalid();
    const days = rec.days as unknown[];
    if (days.some((day, index) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6 || index > 0 && (days[index - 1] as number) >= day)) invalid();
  } else if (rec.kind === "interval") {
    exactKeys(rec, ["kind", "minutes"]);
    if (typeof rec.minutes !== "number" || !Number.isInteger(rec.minutes) || rec.minutes < scheduleLimits.intervalMinutes.min || rec.minutes > scheduleLimits.intervalMinutes.max) invalid();
  } else invalid();
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(timezone: string, at: number): { y: number; mo: number; d: number; h: number; mi: number; weekday: number } {
  let format = formatters.get(timezone);
  if (!format) { format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); formatters.set(timezone, format); }
  const values = Object.fromEntries(format.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const y = Number(values.year), mo = Number(values.month), d = Number(values.day);
  return { y, mo, d, h: Number(values.hour), mi: Number(values.minute), weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}
const pad = (n: number) => String(n).padStart(2, "0");
/** Local `YYYY-MM-DD HH:MM` reading of an instant in `timezone`; display data, never an input. */
export function localReading(timezone: string, at: number): string { const p = parts(timezone, at); return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`; }
function instant(timezone: string, y: number, mo: number, d: number, time: string): RoutineInstant {
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const found = wallToUtc(timezone, y, mo, d, h, mi);
  return { at: found.utc, local: localReading(timezone, found.utc), resolution: found.resolution };
}

/**
 * Next instant strictly after `after`, or null when a one-time schedule has passed. A DST gap runs once at
 * the first valid local minute after the written time; a repeated hour runs once, at its first occurrence.
 * Every local calendar day therefore yields at most one daily/weekly instant.
 */
export function nextInstant(rec: RoutineRecurrence, timezone: string, anchor: number, after: number): RoutineInstant | null {
  if (rec.kind === "interval") {
    const step = rec.minutes * 60000, k = after < anchor ? 1 : Math.floor((after - anchor) / step) + 1, at = anchor + k * step;
    return { at, local: localReading(timezone, at), resolution: "exact" };
  }
  if (rec.kind === "once") {
    const [y, mo, d] = rec.date.split("-").map(Number) as [number, number, number], found = instant(timezone, y, mo, d, rec.time);
    return found.at > after ? found : null;
  }
  const start = parts(timezone, after);
  // Start one local day early: a gap-shifted instant of the previous day can still lie after `after`.
  for (let add = -1; add <= 8; add++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + add));
    if (rec.kind === "weekly" && !rec.days.includes(day.getUTCDay())) continue;
    const found = instant(timezone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), rec.time);
    if (found.at > after) return found;
  }
  return null;
}

/** The next `count` instants strictly after `after`, for review before save and for the read-only feed. */
export function upcoming(rec: RoutineRecurrence, timezone: string, anchor: number, after: number, count: number, until = Number.MAX_SAFE_INTEGER): RoutineInstant[] {
  const result: RoutineInstant[] = [];
  for (let cursor = after; result.length < count;) { const next = nextInstant(rec, timezone, anchor, cursor); if (!next || next.at > until) break; result.push(next); cursor = next.at; }
  return result;
}

/**
 * Instants in `(cursor, now]`, coalesced: `last` is the latest due instant, `count` how many fell due. A
 * scan stopped at `scanLimit` reports `truncated` and still returns the last instant it reached at or
 * before `now`, so a very long downtime coalesces into one run instead of replaying history.
 */
export function dueInstants(rec: RoutineRecurrence, timezone: string, anchor: number, cursor: number, now: number): { count: number; first: RoutineInstant; last: RoutineInstant; truncated: boolean } | null {
  if (rec.kind === "interval") {
    const step = rec.minutes * 60000, first = nextInstant(rec, timezone, anchor, cursor)!;
    if (first.at > now) return null;
    const count = Math.floor((now - first.at) / step) + 1, at = first.at + (count - 1) * step;
    return { count, first, last: { at, local: localReading(timezone, at), resolution: "exact" }, truncated: false };
  }
  let first: RoutineInstant | null = null, last: RoutineInstant | null = null, count = 0, at = cursor;
  while (count < scheduleLimits.scanLimit) {
    const next = nextInstant(rec, timezone, anchor, at);
    if (!next || next.at > now) break;
    first ??= next; last = next; count++; at = next.at;
  }
  if (!first || !last) return null;
  return { count, first, last, truncated: count >= scheduleLimits.scanLimit };
}

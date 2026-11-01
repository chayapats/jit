import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { JobSchedule, WallResolution } from "./schedules-legacy";

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = dtfCache.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // Validation happens before caching; an invalid zone throws RangeError here.
    found.format(0);
    dtfCache.set(timezone, found);
  }
  return found;
}

/** Explicit validated timezone policy: IANA names resolve; anything else is rejected, never host-local. */
export function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length > 128) return false;
  try { formatter(value); return true; } catch { return false; }
}

function tzParts(timezone: string, utcMs: number): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = formatter(timezone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
}

function tzOffsetMs(timezone: string, utcMs: number): number {
  const p = tzParts(timezone, utcMs);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - utcMs;
}

/**
 * Converts a wall-clock reading in `timezone` to a UTC instant.
 * Gap (nonexistent local time): shifts forward minute-by-minute to the first valid wall time.
 * Overlap (ambiguous local time): takes the first (earliest UTC) occurrence.
 * Pure function of zone + wall time; the host timezone is never consulted.
 */
export function wallToUtc(timezone: string, y: number, mo: number, d: number, h: number, mi: number): { utc: number; resolution: WallResolution } {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  for (let step = 0; step <= 2880; step++) {
    const shifted = new Date(wall + step * 60_000);
    const target = { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), h: shifted.getUTCHours(), mi: shifted.getUTCMinutes() };
    const asWall = Date.UTC(target.y, target.mo - 1, target.d, target.h, target.mi);
    const offsets = new Set([tzOffsetMs(timezone, asWall - 86400_000), tzOffsetMs(timezone, asWall), tzOffsetMs(timezone, asWall + 86400_000)]);
    const matches = [...offsets].map(offset => asWall - offset).filter(utc => {
      const p = tzParts(timezone, utc);
      return p.y === target.y && p.mo === target.mo && p.d === target.d && p.h === target.h && p.mi === target.mi;
    }).sort((a, b) => a - b);
    if (matches.length === 2) return { utc: matches[0]!, resolution: step === 0 ? "overlap_first" : "gap_shifted" };
    if (matches.length === 1) return { utc: matches[0]!, resolution: step === 0 ? "exact" : "gap_shifted" };
  }
  throw new AppError("invalid_schedule_command");
}

/** Next daily wall-clock instant strictly after `afterUtc`, with its DST resolution. */
export function nextDailyInstant(timezone: string, time: string, afterUtc: number): { utc: number; resolution: WallResolution } {
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const anchor = tzParts(timezone, afterUtc);
  for (let add = 0; add <= 367; add++) {
    const base = new Date(Date.UTC(anchor.y, anchor.mo - 1, anchor.d + add));
    const found = wallToUtc(timezone, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi);
    if (found.utc > afterUtc) return found;
  }
  throw new AppError("invalid_schedule_command");
}

/**
 * Next scheduled instant strictly after `afterUtc`, or null when the recurrence is consumed.
 * After pause/resume/edit the same computation runs from `now`, so misses are never replayed.
 */
export function nextScheduledInstant(schedule: Pick<JobSchedule, "recurrence" | "timezone" | "cursor" | "createdAt">, afterUtc: number): { utc: number; resolution: WallResolution } | null {
  if (!Number.isSafeInteger(afterUtc) || afterUtc < 0) throw new AppError("invalid_schedule_command");
  const rec = schedule.recurrence;
  if (rec.kind === "once") {
    const cursor = schedule.cursor.lastInstant ?? Number.NEGATIVE_INFINITY;
    return cursor < rec.at && rec.at > afterUtc ? { utc: rec.at, resolution: "exact" } : null;
  }
  if (rec.kind === "interval") {
    const anchor = schedule.cursor.lastInstant ?? schedule.createdAt;
    if (anchor + rec.everyMs > afterUtc) return { utc: anchor + rec.everyMs, resolution: "exact" };
    return { utc: anchor + Math.ceil((afterUtc - anchor + 1) / rec.everyMs) * rec.everyMs, resolution: "exact" };
  }
  if (rec.kind === "weekly") {
    const local = tzParts(schedule.timezone, afterUtc);
    const [h, mi] = rec.time.split(":").map(Number);
    for (let offset = 0; offset <= 7; offset++) {
      const date = new Date(Date.UTC(local.y, local.mo - 1, local.d + offset));
      if (date.getUTCDay() !== rec.day) continue;
      const candidate = wallToUtc(schedule.timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h!, mi!);
      if (candidate.utc > afterUtc) return candidate;
    }
    return null;
  }
  return nextDailyInstant(schedule.timezone, rec.time, afterUtc);
}

/** All due instants in (cursor, now] coalesced: the latest is materialized, the rest disclosed as missed. */
export function dueRange(schedule: Pick<JobSchedule, "recurrence" | "timezone" | "cursor" | "createdAt">, now: number): {
  first: number; last: number; count: number; resolution: WallResolution; requestedWall: string | null;
} | null {
  const anchor = schedule.cursor.lastInstant;
  const rec = schedule.recurrence;
  if (rec.kind === "once") {
    const start = anchor ?? Number.NEGATIVE_INFINITY;
    return start < rec.at && rec.at <= now ? { first: rec.at, last: rec.at, count: 1, resolution: "exact", requestedWall: null } : null;
  }
  if (rec.kind === "interval") {
    const base = anchor ?? schedule.createdAt;
    const first = base + rec.everyMs;
    if (first > now) return null;
    const count = Math.floor((now - first) / rec.everyMs) + 1;
    return { first, last: first + (count - 1) * rec.everyMs, count, resolution: "exact", requestedWall: null };
  }
  if (rec.kind === "weekly") {
    const first = nextScheduledInstant(schedule, anchor ?? schedule.createdAt - 1);
    if (!first || first.utc > now) return null;
    const last = nextScheduledInstant(schedule, now - 8 * 86400000)!;
    let latest = last;
    const next = nextScheduledInstant(schedule, latest.utc);
    if (next && next.utc <= now) latest = next;
    const count = Math.round((latest.utc - first.utc) / (7 * 86400000)) + 1;
    return { first: first.utc, last: latest.utc, count, resolution: latest.resolution, requestedWall: rec.time };
  }
  const firstDue = nextDailyInstant(schedule.timezone, rec.time, anchor ?? schedule.createdAt - 1);
  if (firstDue.utc > now) return null;
  const today = tzParts(schedule.timezone, now);
  const wallH = Number(rec.time.slice(0, 2)), wallM = Number(rec.time.slice(3));
  let last = wallToUtc(schedule.timezone, today.y, today.mo, today.d, wallH, wallM);
  if (last.utc > now) {
    const prev = new Date(Date.UTC(today.y, today.mo - 1, today.d - 1));
    last = wallToUtc(schedule.timezone, prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), wallH, wallM);
  }
  const count = Math.round((last.utc - firstDue.utc) / 86400_000) + 1;
  return { first: firstDue.utc, last: last.utc, count, resolution: last.resolution, requestedWall: rec.time };
}

/** jobs.quiet_outcomes/v1: the typed outcome of one schedule.summary run (ADR 0032). */
export type SummaryOutcome = { kind: "report"; text: string } | { kind: "no_update" } | { kind: "failed"; reason: string };
/** Maximum `reason` length (UTF-16 code units) for a typed failed summary outcome. */
export const summaryReasonChars = 200;
/**
 * Normalizes a `jobs.quiet_outcomes/v1` run output. Prose, JSON without an
 * `outcome` key, and unknown outcome strings stay reports; malformed typed
 * fields fail with `invalid_outcome`; a failed reason must be a non-empty
 * string within `summaryReasonChars`, and a credential-like reason becomes
 * `reason_redacted`. Only an explicit `no_update` outcome is quiet.
 */
export function normalizeSummaryOutcome(output: string): SummaryOutcome {
  const raw = output, trimmed = output.trim();
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { kind: "report", text: raw }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, "outcome")) {
    return { kind: "report", text: raw };
  }
  const outcome = (parsed as { outcome: unknown }).outcome;
  if (typeof outcome !== "string") return { kind: "failed", reason: "invalid_outcome" };
  if (outcome === "no_update") return { kind: "no_update" };
  if (outcome === "report") {
    const text = (parsed as { text: unknown }).text;
    return typeof text === "string" && text.trim() ? { kind: "report", text } : { kind: "failed", reason: "invalid_outcome" };
  }
  if (outcome === "failed") {
    const reason = (parsed as { reason: unknown }).reason;
    if (typeof reason !== "string") return { kind: "failed", reason: "invalid_outcome" };
    const r = reason.trim();
    if (!r || r.length > summaryReasonChars) return { kind: "failed", reason: "invalid_outcome" };
    if (containsCredential(r)) return { kind: "failed", reason: "reason_redacted" };
    return { kind: "failed", reason: r };
  }
  return { kind: "report", text: raw };
}

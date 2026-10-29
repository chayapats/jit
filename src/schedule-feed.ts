import { liveProjectSql } from "./project-lifecycle";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";
import type { AppTransaction } from "./store";
import { dueRange, listSchedules, nextScheduledInstant, type JobSchedule, type ScheduleKind } from "./jobs/schedules";

/**
 * app.schedule_feed/v1 — the owner's read-only `.ics` feed of upcoming schedule occurrences (S10 REL08, FR-34,
 * ADR 0035). See docs/contracts/schedule-feed-v1.md.
 *
 * - One installation-wide feed (schema 30, `schedule_feed`, a singleton row). It is off until `feed.create`.
 * - The feed URL is `/feeds/schedules/<token>.ics`. Only the SHA-256 of the token is stored, the table is
 *   installation-scoped (never in a backup image, kept from the live store on restore and upgrade activation),
 *   and the plaintext token leaves the service once: in the response to the `feed.create` or `feed.rotate`
 *   command that minted it. Receipts persist no token, so a replayed request id answers `url: null`.
 * - The feed lists only the kind, project name, optional purpose and UTC start of each occurrence. It grants no
 *   authority: reading it admits nothing and writes nothing.
 */
export const scheduleFeedContract = "app.schedule_feed/v1" as const;

/** Finite feed bounds: the 30-day horizon (ADR 0035), the most events one response carries and the line length. */
export const feedLimits = Object.freeze({ horizonMs: 30 * 86_400_000, events: 5000, lineOctets: 75 });

/** A feed token is 32 random bytes in base64url (43 characters). Anything else is not a token. */
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** The owner-visible feed state. It never contains the token or its hash. */
export interface ScheduleFeed {
  enabled: boolean;
  includePurpose: boolean;
  /** Revision of the singleton row (0 before the first feed command). */
  revision: number;
  /** When the current token was minted, or null while the feed is off. */
  tokenCreatedAt: number | null;
  updatedAt: number | null;
}

type FeedBase<K extends string, P> = { kind: K; requestId: string; projectId: null; expectedRevision: number; payload: P };
/** `app.schedule_feed/v1` owner commands. Each is revisioned against the feed row and idempotent by request id. */
export type FeedCommand =
  | FeedBase<"feed.create", Record<string, never>>
  | FeedBase<"feed.rotate", Record<string, never>>
  | FeedBase<"feed.disable", Record<string, never>>
  | FeedBase<"feed.set_include_purpose", { includePurpose: boolean }>;
/** `url` is the absolute feed URL, present only in the first response of `feed.create` or `feed.rotate`. */
export interface FeedReceipt { feed: ScheduleFeed; url: string | null }

export const feedCommandKinds: readonly FeedCommand["kind"][] = Object.freeze(["feed.create", "feed.rotate", "feed.disable", "feed.set_include_purpose"]);
export const isFeedCommand = (command: unknown): command is FeedCommand =>
  !!command && typeof command === "object" && feedCommandKinds.includes((command as { kind?: unknown }).kind as FeedCommand["kind"]);

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Mints a fresh feed token from the platform CSPRNG. */
export const mintFeedToken = (): string => randomBytes(32).toString("base64url");

/** The path of the feed for `token`; the caller prefixes the configured origin. */
export const feedPath = (token: string) => `/feeds/schedules/${token}.ics`;

/** The token of a feed path, or null when the path is not `/feeds/schedules/<43 base64url>.ics`. */
export function feedPathToken(pathname: string): string | null {
  const match = /^\/feeds\/schedules\/([^/]+)\.ics$/.exec(pathname);
  return match && tokenPattern.test(match[1]!) ? match[1]! : null;
}

interface FeedRow { revision: number; token_hash: string | null; include_purpose: number; token_created_at: number | null; updated_at: number }

function readRow(tx: AppTransaction): FeedRow | null {
  return tx.get<FeedRow>("SELECT revision, token_hash, include_purpose, token_created_at, updated_at FROM schedule_feed WHERE id = 1");
}

/** Reads the feed state, or the off default before the first command. */
export function readScheduleFeed(tx: AppTransaction): ScheduleFeed {
  const row = readRow(tx);
  return row ? { enabled: row.token_hash !== null, includePurpose: row.include_purpose === 1, revision: row.revision, tokenCreatedAt: row.token_created_at, updatedAt: row.updated_at }
    : { enabled: false, includePurpose: false, revision: 0, tokenCreatedAt: null, updatedAt: null };
}

/** Validates a command shape and returns its stable identity for receipt replay. */
export function feedIdentity(command: FeedCommand): string {
  const payloadKeys = command?.kind === "feed.set_include_purpose" ? ["includePurpose"] : [];
  if (!isFeedCommand(command) || command.projectId !== null ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" || Array.isArray(command.payload) ||
      Object.keys(command.payload).length !== payloadKeys.length || Object.keys(command.payload).some(key => !payloadKeys.includes(key)) ||
      (command.kind === "feed.set_include_purpose" && typeof command.payload.includePurpose !== "boolean")) throw new AppError("invalid_feed_command");
  const includePurpose = command.kind === "feed.set_include_purpose" ? command.payload.includePurpose : null;
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, includePurpose])).digest("hex");
}

/**
 * Applies a validated command inside the caller's write transaction. `token` is the freshly minted token for
 * `feed.create` / `feed.rotate`; only its hash is written. A stale revision or a command that does not fit the
 * current state (create while on, rotate or turn off while off) is rejected.
 */
export function writeScheduleFeed(tx: AppTransaction, command: FeedCommand, token: string, now: number): ScheduleFeed {
  const row = readRow(tx);
  const current = readScheduleFeed(tx);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  let tokenHash = row?.token_hash ?? null, tokenCreatedAt = row?.token_created_at ?? null, includePurpose = current.includePurpose;
  if (command.kind === "feed.create" || command.kind === "feed.rotate") {
    if (command.kind === "feed.create" && current.enabled) throw new AppError("feed_already_enabled", 409);
    if (command.kind === "feed.rotate" && !current.enabled) throw new AppError("feed_not_enabled", 409);
    if (!tokenPattern.test(token)) throw new AppError("invalid_feed_command");
    tokenHash = sha256(token).toString("hex"); tokenCreatedAt = now;
  } else if (command.kind === "feed.disable") {
    if (!current.enabled) throw new AppError("feed_not_enabled", 409);
    tokenHash = null; tokenCreatedAt = null;
  } else includePurpose = command.payload.includePurpose;
  tx.run(`INSERT INTO schedule_feed (id, revision, token_hash, include_purpose, token_created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, token_hash = excluded.token_hash, include_purpose = excluded.include_purpose,
      token_created_at = excluded.token_created_at, updated_at = excluded.updated_at`,
  current.revision + 1, tokenHash, includePurpose ? 1 : 0, tokenCreatedAt, now);
  return readScheduleFeed(tx);
}

/**
 * Constant-time token check. A malformed token, a disabled feed and a wrong token are indistinguishable to the
 * caller; the comparison always runs over two 32-byte digests.
 */
export function feedTokenMatches(tx: AppTransaction, token: string): boolean {
  const presented = sha256(typeof token === "string" && tokenPattern.test(token) ? token : "");
  const stored = readRow(tx)?.token_hash ?? null;
  const expected = stored && /^[a-f0-9]{64}$/.test(stored) ? Buffer.from(stored, "hex") : Buffer.alloc(32);
  const equal = timingSafeEqual(presented, expected);
  return equal && stored !== null;
}

/** One occurrence in the feed: the schedule identity at its revision, the UTC instant and the title fields only. */
export interface FeedEvent {
  scheduleId: string; revision: number; instant: number; stamp: number;
  kind: ScheduleKind; projectName: string; purpose: string;
}

/**
 * Upcoming occurrences of every `active` schedule in (now, now + 30 days], computed only with
 * `nextScheduledInstant` (jobs.configured_schedules/v1) applied iteratively from `now`, and never more than the
 * budget the engine will still spend on future instants: `occurrencesRemaining`, less one when an instant is
 * already due but not yet ticked (the next tick coalesces it and spends one). Paused and revoked schedules
 * contribute nothing. Events are ordered by instant, then schedule id, and cut at `feedLimits.events`; the
 * schedules are merged lazily through a heap, so one read computes at most that many occurrences beyond one
 * look-ahead per schedule.
 */
export function readFeedEvents(tx: AppTransaction, now: number): FeedEvent[] {
  const horizon = now + feedLimits.horizonMs;
  interface Head { event: FeedEvent; schedule: JobSchedule; left: number }
  const before = (a: Head, b: Head) => a.event.instant < b.event.instant || (a.event.instant === b.event.instant && a.event.scheduleId < b.event.scheduleId);
  const heap: Head[] = [];
  const push = (head: Head) => {
    heap.push(head);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!]; i = parent;
    }
  };
  const pop = (): Head => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && before(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && before(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!]; i = m;
      }
    }
    return top;
  };
  const advance = (schedule: JobSchedule, projectName: string, after: number, left: number) => {
    if (left <= 0) return;
    const next = nextScheduledInstant(schedule, after);
    if (!next || next.utc > horizon) return;
    push({ schedule, left, event: { scheduleId: schedule.id, revision: schedule.revision, instant: next.utc, stamp: schedule.updatedAt,
      kind: schedule.kind, projectName, purpose: schedule.purpose } });
  };
  for (const project of tx.all<{ id: string; name: string }>(`SELECT p.id, p.name FROM projects p WHERE ${liveProjectSql("p")} ORDER BY p.created_at, p.id`)) {
    for (const schedule of listSchedules(tx, project.id)) {
      if (schedule.state !== "active" || schedule.occurrencesRemaining <= 0) continue;
      advance(schedule, project.name, now, schedule.occurrencesRemaining - (dueRange(schedule, now) ? 1 : 0));
    }
  }
  const events: FeedEvent[] = [];
  while (heap.length && events.length < feedLimits.events) {
    const head = pop();
    events.push(head.event);
    advance(head.schedule, head.event.projectName, head.event.instant, head.left - 1);
  }
  return events;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and line breaks; other control characters become spaces. */
export function escapeIcsText(value: string): string {
  return value.replace(/\r\n|[\r\n]/g, "\n").replace(/[\\;,\n]/g, char => char === "\n" ? "\\n" : `\\${char}`)
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " ");
}

/** Folds one content line at `feedLimits.lineOctets` UTF-8 octets without splitting a character (RFC 5545 §3.1). */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "", octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (octets + size > feedLimits.lineOctets) { out.push(current); current = " "; octets = 1; }
    current += char; octets += size;
  }
  out.push(current);
  return out.join("\r\n");
}

const icsTime = (utc: number) => new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

/** Text the feed needs from the dictionary, in the owner's language. */
export interface FeedLabels { calendarName: string; kind: Record<ScheduleKind, string> }

/**
 * Renders the feed as an RFC 5545 VCALENDAR with CRLF line ends: one VEVENT per occurrence with a stable
 * `UID` (`<scheduleId>-<revision>-<instant>@jit`), `DTSTART` in UTC and a `SUMMARY` of the kind label and the
 * project name, plus the purpose only when `includePurpose` is on. Nothing else about a project is included.
 */
export function renderScheduleFeed(events: readonly FeedEvent[], options: { includePurpose: boolean; labels: FeedLabels }): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//Jit//${scheduleFeedContract}//EN`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.labels.calendarName)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const event of events) {
    const title = [options.labels.kind[event.kind], event.projectName, ...(options.includePurpose && event.purpose ? [event.purpose] : [])].join(" · ");
    lines.push("BEGIN:VEVENT", `UID:${event.scheduleId}-${event.revision}-${event.instant}@jit`, `DTSTAMP:${icsTime(event.stamp)}`,
      `DTSTART:${icsTime(event.instant)}`, `SUMMARY:${escapeIcsText(title)}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

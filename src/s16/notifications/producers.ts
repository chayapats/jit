import type { Database } from "bun:sqlite";
import type { ConversationOwnerRow } from "../../s15/conversation";
import type { Routine, RoutineOccurrence } from "../routines/types";
import type { NoticeInput, NoticeProducer, NotificationOwner } from "./types";

/** Owner-visible conversation path of the S16 app; the service worker opens it and the app re-fetches current state. */
export const conversationPath = (conversationId: string) => `/s16/chat/${conversationId}`;

/**
 * Notices from CHAT's immutable `events` journal, read in sequence order behind a durable cursor. The first run
 * starts at the current end, so enabling notifications never replays history.
 *
 * - `needs_me` → `needs_you`, only while the request still shows that exact Needs-you item; its identity
 *   (`hold_<request>_<revision>` or `action_<id>_<revision>`) is the source, so repeated events for one item give one notice.
 * - `result` → `result`, for a completed request whose result is currently publishable, has no open Needs-you item and
 *   took at least `resultAfterMs` from receipt (a quick reply the owner is watching does not buzz the device).
 * - Routine runs are left to {@link routineNotices}, so a quiet run is never announced; stops and progress never notify.
 *
 * `row` reads through the guarded owner projection as that request's owner and returns null when the owner changed.
 */
export function conversationNotices(port: { db: Database; row(owner: NotificationOwner, requestId: string): ConversationOwnerRow | null }, options: { resultAfterMs: number; batch?: number }): NoticeProducer {
  const batch = options.batch ?? 64;
  return { name: "conversation_events", collect(cursor) {
    const end = port.db.query<{ end: number | null }, []>("SELECT max(sequence) AS end FROM events").get()?.end ?? 0;
    if (cursor === null || cursor > end) return { cursor: end, notices: [] };
    const rows = port.db.query<{ sequence: number; request_id: string; conversation_id: string; at: number; kind: "needs_me" | "result"; owner_id: string; generation: number; received_at: number }, [number, number, number]>(
      `SELECT e.sequence, e.request_id, e.conversation_id, e.at, e.kind, json_extract(r.record_json,'$.owner.id') AS owner_id, json_extract(r.record_json,'$.owner.generation') AS generation,
        json_extract(r.record_json,'$.receipt.receivedAt') AS received_at
       FROM events e JOIN requests r ON r.id=e.request_id
       WHERE e.sequence>? AND e.sequence<=? AND e.kind IN ('needs_me','result') AND json_extract(r.record_json,'$.routine') IS NULL AND (e.kind='needs_me' OR json_type(r.record_json,'$.delegation') IS NULL) ORDER BY e.sequence LIMIT ?`).all(cursor, end, batch);
    const notices: NoticeInput[] = [];
    for (const event of rows) {
      const owner = { ownerId: event.owner_id, generation: event.generation };
      let row: ConversationOwnerRow | null = null;
      try { row = port.row(owner, event.request_id); } catch { row = null; }
      if (!row) continue;
      const path = conversationPath(event.conversation_id);
      if (event.kind === "needs_me" && row.needsYou) notices.push({ source: `needs_you:${row.needsYou.id}`, owner, kind: "needs_you", path });
      if (event.kind === "result" && row.state === "done" && row.result && !row.needsYou && event.at - event.received_at >= options.resultAfterMs) notices.push({ source: `result:${event.request_id}`, owner, kind: "result", path });
    }
    return { cursor: rows.length === batch ? rows.at(-1)!.sequence : end, notices };
  } };
}

/** Occurrence states that wait on the owner; every other notified outcome is an ordinary routine notice. */
const waiting = new Set<RoutineOccurrence["state"]>(["needs_you", "waiting_review", "unknown"]);

/**
 * Notices from routine occurrences that raised attention (`notified`), which excludes quiet runs by construction.
 * One notice per occurrence: `needs_you` when it waits on the owner, otherwise `routine`. The cursor is the instant
 * notifications started, and only outcomes settled since then and within `horizonMs` are read.
 */
export function routineNotices(db: Database, now: () => number, options: { horizonMs?: number } = {}): NoticeProducer {
  const horizon = options.horizonMs ?? 86_400_000;
  return { name: "routine_occurrences", collect(cursor) {
    if (cursor === null) return { cursor: now(), notices: [] };
    const since = Math.max(cursor, now() - horizon);
    const rows = db.query<{ occurrence: string; routine: string }, [number]>(`SELECT o.json AS occurrence, r.json AS routine FROM occurrences_v1 o JOIN routines_v1 r ON r.id=o.routine_id
      WHERE json_extract(o.json,'$.notified')=1 AND json_extract(o.json,'$.settledAt')>=? ORDER BY o.rowid DESC LIMIT 256`).all(since);
    const notices = rows.map(({ occurrence: o, routine: r }): NoticeInput => {
      const occurrence = JSON.parse(o) as RoutineOccurrence, routine = JSON.parse(r) as Routine;
      return { source: `routine:${occurrence.id}`, owner: { ...routine.owner }, kind: waiting.has(occurrence.state) ? "needs_you" : "routine",
        path: occurrence.requestId ? conversationPath(routine.draft.conversationId) : `/s16/routines/${routine.id}` };
    });
    return { cursor, notices };
  } };
}

# web.reply_stream/v2 — push reply text without publishing it

Owner: Jit STR01 #174. Confirmed S12-D02; NFR-05, NFR-10, NFR-11. Amends the SSE portion of [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md) and uses [app.jit_reply/v2](jit-reply-v1.md), `app.run_port/v1` and `jobs.attempt_fence/v1` without changing publication authority.

## Endpoint and durable replay

`GET /projects/:projectId/topics/:topicId/events` keeps the existing owner authentication, project/topic read scope, no-store, same-origin CSP, `text/event-stream` and `X-Accel-Buffering: no` headers. It starts no work. A reader beyond the per-store limit receives 429. The numeric cursor comes from `Last-Event-ID`, then `?cursor`, then zero; existing cursor validation applies.

Successful outer store commits wake readers in a coalesced microtask; rolled-back changes do not. A durable `reply` event is unchanged: its `id` is that reply's persisted change cursor; data contains the persisted state, revision, committed text when answered, source-backed message identity and server-localised labels. Admission, preparation, commit and queue-only transitions still move the cursor. Demand drains all pages in order without a poll timer. A reconnect starts after its last delivered durable event; it neither loses later pages nor re-admits the reply. As before, this is a projection of current reply rows, not an immutable log of intermediate job states.

## Memory-only snapshots

The run observer consumes exact typed `delta` events and writes only into its in-process mailbox. Each `reply-preview` event has **no `id` field** and therefore never advances the browser's durable replay cursor. Data is:

```ts
{
  id: string; projectId: string; topicId: string;
  attemptId: string; sequence: number;
  text: string; provisional: true; stalled: boolean; label: string;
}
```

`text` replaces the previous preview; it is never appended to it. `sequence` increases per delta/reset within one attempt; stall changes may repeat the same sequence. A new attempt starts at zero with a fresh identity. A reconnect receives the latest snapshot even if no durable change occurred. It does not replay old deltas. Restart has no snapshots. Legacy JSON responses are withheld until commit. The prose filter withholds all line-start triple-backtick fences from the first partial opener, so valid and malformed proposal trailers never enter the preview. Code examples use tilde fences. The final result is parsed independently using the v2 grammar.

The mailbox checks the signal, run identity, current attempt authority (generation, owner, scheduler and lease), admitted job, active context and current sources/context packet on every read/write. Stop, supersession, expiry or deletion removes stale previews; a late result still has to pass the unchanged job commit fence. The supported Schway public `retry`/`tool_started` observation resets the draft instead of joining output across attempts/model turns. Generic progress/retry messages and raw provider objects never become reply text.

## Bounds and back-pressure

- Per store: at most 64 active previews, 32,768 UTF-8 bytes each, clamped to the reply's existing attempt output ceiling (currently 4,096 bytes including the trailer). A full mailbox declines a new preview; it does not alter work admission. Overflow clears/disables that preview and cannot enlarge the final output ceiling.
- At most 128 connected readers per store. Each has one queued SSE frame, capped at 262,144 encoded bytes, and a bounded map of at most 64 snapshot versions. Oversized frames close the connection. No reader retains a delta queue or historical message bodies.
- With no transport demand, the stream does not enqueue or advance replay. The shared mailbox coalesces producer updates to its latest bounded snapshot. On demand, durable state takes priority, followed by changed snapshots and a keep-alive. It does not pause the model or grow its budget.
- A 1,000 ms timer checks the watchdog and sends keep-alives, independent of delta delivery; it does not poll SQLite for reply changes. After 120 ticks the connection closes so `EventSource` reconnects and authentication is checked again. Request abort, reader cancellation, read failure and expiry cancel the timer and remove the subscription. Push latency is a microtask plus transport demand; deterministic evidence asserts <=100 ms with the timer unfired.

## Owner experience and no script

The thinking placeholder shows streamed prose with `textContent` and the unsaved label. After 10,000 ms with no delta on an active attempt, the server sends the localised still-working label; the next delta clears it. Queued/waiting work is not an active attempt for this watchdog. On commit, durable message text replaces the preview. Stop, failure or route block clears it and shows the existing state and next action. Proposals render through existing committed cards, never as JSON.

On a transport error the browser clears the draft and shows `reply.reconnecting` beside the existing Refresh link. Reconnection replaces the snapshot, including when the attempt changed; a terminal card ignores late preview events. The stream closes when no card is live. No preview is stored in browser storage, HTML reads, SQLite, receipts, sources, backups, ordinary exports or service-worker caches. A no-script reload shows the committed attributed message and the same ordinary Stop/Refresh forms as before.

New bilingual keys: `reply.streaming`, `reply.still_working`, `reply.reconnecting`, `error.reply_stream_limit`. Existing `reply.provisional` remains the unsaved label. CSS changes are limited to `.reply-progress` typography/colour and `.reply-connection` hint styling; visual polish is a separate pass.

## Deterministic evidence

`tests/reply-format.test.ts`: v2/legacy parser matrix, discard handlers/codes, every delimiter split, malformed trailers, Unicode and byte bounds. `tests/web-reply-stream.test.ts`: <=100 ms push with fake time, watchdog/reset/recovery, coalescing, replay cursors, cancellation/expiry, mailbox/reader bounds and rollback-safe notifications. `tests/jit-reply.test.ts`: adapter-to-SSE integration, hidden metadata, unchanged receipts/attribution, failed/expired/stopped attempts, no-script v2 replies, replay/auth/scope and a fake `EventSource` UI contract. `tests/schway-bridge.test.ts`: untruncated supported host deltas. No live provider or host calls are needed.

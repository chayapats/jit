---
status: accepted
scope: S09 main-bot engineering choices; extends ADRs 0011 and 0015
---

# Jit conversational replies, owner-configured persona and role proposals

FR-19 and FR-20 make the coordinator answer every owner message as "Jit", and let it propose new specialists. ADR 0011 still holds: provider/model output has no configuration authority. ADR 0015 still holds: coordinator output is recommendation-only.

## Selected implementation

- An owner `message.send` in a topic admits one `team.jit-reply` interactive job through `jobs.queue_admission`. Its result is published through `jobs.attempt_fence` as an attributed Jit message source. Duplicate request IDs, refreshes and reconnects do not admit another reply. A late result from a stopped or superseded generation is discarded.
- The run receives trusted operator instructions (product policy plus the owner's persona) and an untrusted manifest (topic history, sources, memory context and specialist results). It receives no tools in this slice. Its structured output may contain prose plus at most a finite number of typed proposals: `role`, `dispatch` (see ADR 0030) and `promotion` (see ADR 0031). Unknown fields are discarded.
- **Persona** is owner configuration, stored with revisions and written only by owner commands from setup or settings. It covers how Jit addresses the owner, the language for UI and replies, self-reference, politeness particle, a personality preset (calm, direct, friendly) and free-text "about me". The persona is trusted instruction text. The model cannot rewrite it.
- **Role proposal** is an immutable revision containing name, responsibility, and a route reference chosen only from routes the owner has already configured. It can be in one of four states: proposed, accepted, rejected or superseded. `role.proposal.accept` requires the current proposal id and revision, and writes through the existing `role.save` path in the same transaction and receipt. Editing before acceptance creates an owner-authored revision. A proposal never names tools, budgets or new routes. Text that asks for them is ignored, and the card shows what was dropped.
- When specialists took part, the reply cites the committed specialist result revisions and records the coverage gap. This is the same rule as ADR 0015.

## Alternatives and consequences

Letting the model create roles directly was rejected by the owner (S09-D03) and conflicts with FR-17. Free-form intent parsing on the owner's own message was rejected because the model would still be the interpreter. Schema changes add persona, proposal and reply records behind the existing snapshot-before-DDL migration.

## STR01 / S12-D02: reply text streaming (Jit #174)

Confirmed requirement: stream real prose by push SSE, keep it provisional until the existing attempt fence commits, never show proposals JSON, and preserve no-script replies and replay (NFR-05, NFR-10, NFR-11). The owner confirmed D02; the following are engineering choices for that requirement.

- `app.jit_reply/v2` uses prose then an optional, sole trailing `jit-proposals` fence containing `{"version":2,"proposals":[...]}`. The version is explicit so later task suggestions/chips can register handlers without changing the grammar. Unknown fields/kinds retain safe discard codes and the eight-code evidence cap. Bad or non-final trailers discard everything from their opener as `field:proposals` while keeping valid preceding prose. Only an unindented line whose info string is exactly `jit-proposals` is reserved; normal Markdown code fences, indented fences and lookalikes remain prose. V1 JSON is accepted for one transition release but never streamed; a whole-output json/unlabelled fence is legacy only when its content parses as an object with a string `reply`. See the [exact parser rules](../contracts/jit-reply-v1.md#structured-output).
- Provisional bytes live only in a per-store, attempt-scoped mailbox, never a record, source, receipt, export or replay log. It retains at most 64 active entries of 32 KiB each, additionally clamped to the existing attempt output ceiling (currently 4 KiB). Overflow disables the preview; terminal output still goes through normal validation. Apart from possible v1 envelopes, the filter withholds only a line-start backtick/info-string suffix that could still become the exact `jit-proposals` opener, releases it on divergence or a nonmatching line ending, and withholds the complete trailer once its opener line ends. Partial Unicode pairs are withheld. The completed result is parsed independently.
- The mailbox rejects stale writes/reads using the attempt generation/owner/scheduler/lease, run id, live signal, active context and current sources/context packet. The existing commit callback and producer transaction remain the only publication authority. A host retry/tool start resets the buffer. These observations use only `schway/host`'s supported public surface.
- Store commits notify after the successful outer transaction only (rollback emits nothing). Notifications/deltas coalesce into one microtask. `web.reply_stream/v2` has durable `reply` events with existing numeric replay cursors and memory-only replacement `reply-preview` snapshots without IDs. A slow reader retains one queued frame, capped at 256 KiB, plus the shared latest snapshot; no per-token backlog. There are at most 128 readers per store. Abort, cancellation and expiry unsubscribe.
- A 1 s timer checks the 10 s no-delta watchdog and sends keep-alives, rather than polling for reply changes. Connections expire after 120 ticks and reconnect for authentication as before. Watchdog status is text, not animation alone. Transport errors clear drafts and show a localised reconnect/Refresh hint. No-script page reads return durable state only. Telegram and downstream COMM/CTX work are unchanged.

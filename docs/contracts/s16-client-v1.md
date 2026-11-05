# S16 shared client v1

Implemented by API16-01 [#395](https://github.com/chayapats/jit/issues/395), against the [S16 handoff](../design/S16-rakazo-experience.md) and [ADR 0074](../adr/0074-rakazo-reuse-and-product-convergence.md). This is the first protected shared-client seam, not a claim of complete S16-AC02 or product parity. Existing S14/legacy/default selection, S15 policy/stores and engine ownership are unchanged.

## Ownership and entry points

`src/s16/client/index.ts` is a browser/native-safe TypeScript entry point. Runtime code uses only Fetch, streams, text encoding and local generation state; server/Schway imports are type-only. `createS16ClientHandler` mounts under `/api/s16/client/` in the opt-in S15 composition. It calls the actual conversation application's owner projections, admission, exact decisions, event queries and stop. It owns no database, provider loop or alternate approval system.

All endpoints require the installation's existing owner session. POST requires exact Origin and current CSRF. Exact Host and cross-site Fetch Metadata are checked; there is no CORS opt-in. Streaming a body is an async boundary, so current authentication/CSRF are rechecked after it finishes. Private JSON responses are no-store, nosniff and bounded to 8 MiB; a larger projection refuses rather than silently truncating evidence. Request JSON is bounded to 32 KiB and rejects duplicate keys, malformed UTF-8/JSON and authority-bearing extra command keys through the owning validator.

## Operations

| Method / path after `/api/s16/client` | Result / semantics |
| --- | --- |
| GET `/bootstrap` | `s16-client-bootstrap/v1`: current CSRF, `s16-client-capabilities/v1`, up to 64 recent conversations and up to 1024 current Needs-you items. Reads do not start execution. The transport retains CSRF internally and removes it from returned UI bootstrap state. |
| GET `/conversations/:id` | `s16-client-snapshot/v1` wraps the existing guarded `s15.owner-view/v1`: up to 32 recent requests, current results/evidence/slips and current conversation cursor. Each read reacquires publication/lineage guards. |
| GET `/conversations/:id/events?after=N` | `s16-client-events/v1`: up to 64 strictly increasing, conversation-bound metadata events and the last returned cursor. No model delta, result or evidence payload. Invalid/cross-conversation cursors refuse; recover by a fresh snapshot, never by resubmission. |
| GET `/requests/:id` | `s16-client-request/v1`: the exact original command `receipt` plus its current guarded root `row`, independent of the recent conversation window. A clarification ID can differ from `row.requestId` but its receipt must name that root and conversation. Recovers a retained send after response loss/restart; exposes neither raw native state nor the raw request journal. |
| POST `/conversations/:id/messages` | The existing exact `s15-conversation/v1` text command; returns its durable receipt with HTTP 202. Admission precedes a local drain wake. Same identity/body returns the original receipt; conflicting payload refuses. No file fields are silently appended to v1. |
| POST `/conversations/:id/decisions` | The exact `s15-conversation-decision/v1` command, bound to a currently presented action ID/revision/hash. HTTP 202 receipt; no model interpretation or scope widening. The full typed command fingerprint is retained, so changed revision/hash under an old ID conflicts instead of being presented as the original vote. |
| POST `/requests/:id/stop` | Empty JSON object; fences only that request through its owning service and returns `stop_requested`. Acknowledgement is not proof that all external work/effects have settled. |

The path and posted conversation identity must match. Query parameters are rejected except the single events cursor. Errors contain safe codes, not provider errors or credentials. New identity/authority errors cannot be converted into a client-side retry of an effect.

## Capabilities and known limits

This revision supports text messages, current control progress, snapshots, original-send recovery, stop and exact decisions where the actual policy ports are composed. `liveSteering` is false. Uploads and immutable artifact delivery remain unavailable unless the explicit [file composition](s16-files-v1.md) is enabled; that versioned seam adds UTF-8 receipts, file-bearing messages and committed immutable downloads. The current conversation drain can retain new ingress while another request runs; this adapter does not claim concurrent run scheduling, token streaming or targeted live steering. Those need their own supported execution/ordering contract.

Owner memory search, inspection, correction and forget use the separate [memory client contract](s16-memory-client-v1.md) and the additive `memory` capability field.

File-bearing messages, upload receipts and artifact collection/publication use the separate [S16 file contract](s16-files-v1.md) and current disclosure/input custody. A filename/path embedded in model text is not a file. The existing result library is not recast as immutable artifacts. The first React renderer is explicitly selected at `/s16` on S15; API16-01 itself remains the headless contract foundation.

## Client continuity

`prepareMessage` creates a frozen local command. The caller retains its exact ID/body until a durable receipt or recovery query resolves it. `send` and `decide` copy inputs before I/O, never automatically retry, and retain the original identity on an unknown outcome. Fetch uses configured exact origin, same-origin credentials/mode, no-store, no-referrer and refused redirects. A native Fetch adapter must attach its authenticated session cookie and, on every POST, the exact configured `Origin` header. A cookie-only adapter can bootstrap but commands refuse `origin_rejected`; browser Fetch supplies Origin itself. Sessions go only to the configured service and never to a model.

`JitClientError` distinguishes not-sent, unknown and received-response outcomes. A successful mutation with missing/malformed JSON, invalid receipt identity or an invalid stop acknowledgement remains unknown with its original identity. Recovery reads the original command receipt and guarded root; manual retransmission must use the same command identity/body. Unknown remote effects remain governed by the owning service, never recreated with a new client ID. Authentication/authorization errors clear transport CSRF.

`clear()` and every new bootstrap advance an ephemeral session generation and discard CSRF until the new bootstrap validates. Late success/error responses from an older generation cannot restore or clear a newer session's CSRF or return its private projections. They fail `client_response_stale`; mutation failures retain an unknown outcome and original identity. This is a local response fence, not server work cancellation or permission renewal.

Conversation state is ephemeral. Begin every target/session change or revalidation with a fresh generation and discard the old projection. Only a matching target/generation and monotonic snapshot cursor may populate it. On failed authentication/revalidation, withhold private content and advance the generation so late responses cannot repopulate it. Events only invalidate; they cannot certify completion or supply a cached approval. Re-fetch the authorized snapshot before displaying results or deciding actions. No transcript/CSRF/session/approval is persisted by this client.

## Compatibility and evidence

The only added retained conversation field is the optional typed-decision fingerprint. It uses the existing JSON writer transaction, with no DDL/store-version change. Successful older typed decisions can retry only when their retained exact action and decision match; a changed or unprovable old typed command refuses. Ordinary existing text-command dedupe remains unchanged. Native state and existing stores are not converted.

Deterministic composed tests exercise an actual registered VM tool, lost-response recovery/restart, duplicate/conflicting sends, exact approval with one send, private-source withdrawal, independent stop, auth/origin/CSRF/cursor checks, post-stream reauthentication, stale client generations and browser bundling without server/engine imports. The VM/provider transports are controlled fixtures; this is not new live-host, device, provider or complete-product acceptance.

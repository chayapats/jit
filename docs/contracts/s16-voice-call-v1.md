# s16-voice-call/v1

Status: selected contract for CALL16-01 (#423), implementation/evidence pending. [ADR 0098](../adr/0098-s16-continuous-local-voice-turns.md) owns the decision. This extends the optional [local voice contract](s16-voice-v1.md), using existing CHAT messages and [steering](s16-steering-v1.md); it adds no grant, decision or model/provider loop.

## Intent, capture and turns

The owner deliberately starts one finite call after seeing the configured local route, remaining quota and limits. Native microphone permission remains explicit. No background capture, browser recognition service, remote fallback or automatic account/budget change is selected. Text remains usable.

Listening segments bounded PCM into an utterance. Use 16 kHz mono samples, RMS activity threshold 0.015, at least 160 ms of consecutive activity before speech onset, 900 ms trailing silence after speech and a 15-second no-speech limit. The capture's smaller actual duration/deadline still wins. Speech onset immediately interrupts local reply audio and invalidates pending playback; energy detection supplies no identity or authority. A no-speech window ends voice capture rather than creating a transcript/request.

Silence stops the native clip and starts one existing local transcription. Its untrusted transcript is editable and never submitted automatically. The owner's **Send turn** confirms exact text and the displayed target. A message uses ordinary CHAT admission. A steer uses the exact unfinished request in the same conversation and its frozen scope, with existing queued/sent/applied/resubmitted/unapplied/uncertain dispositions. Neither route calls an action decision or raises purpose, resources, access or budgets. Ambient/quoted audio alone creates no work or approval.

After confirmation, the same call rearms listening automatically and can listen while thinking/speaking. At most one unconfirmed transcript is buffered. Playback interruption does not cancel a confirmed turn, running work or an uncertain effect. The conversation continues to show text results, work and authenticated needs-you/action cards.

## Owner HTTP surface

All routes retain exact Host/Origin, current owner session, CSRF on POST, strict streamed body limits, no-store and final reauthentication. No serialized actor, provider account, arbitrary script, approval command or raw unguarded reply text is accepted.

| Route below `/api/s16/client` | Exact input / result |
| --- | --- |
| `GET /conversations/:conversationId/voice/calls` | Up to eight current-owner call metadata views, newest first; no capture/work starts |
| `POST /conversations/:conversationId/voice/calls` | `{contract: "s16-voice-call-begin/v1", requestId}`; timestamped voice identity, one finite call view |
| `GET /voice/calls/:callId` | Current call facts and original turn receipts; never resubmits |
| `POST /voice/calls/:callId/control` | `{contract: "s16-voice-call-control/v1", revision, kind: "mute" | "resume" | "end"}`; current view |
| `POST /voice/calls/:callId/captures` | `{contract: "s16-voice-call-capture/v1", revision, requestId}`; existing finite `VoiceCapture` bound to this live call/revision |
| `POST /voice/calls/:callId/turns` | `{contract: "s16-voice-call-turn/v1", revision, ordinal, text, target}`; `target` is a root request ID for steering, or `null` for an explicitly confirmed ordinary message; current view |
| `POST /voice/calls/:callId/playback` | `{contract: "s16-voice-call-playback/v1", revision, request}`; `request` is the existing exact `s16-voice-playback/v1` command for this conversation; guarded bounded audio |

Existing `/voice/:captureId/transcribe` and `/cancel` retain their strict PCM/result rules. Call bindings in protected operation metadata enforce the current call/revision at every process/publication boundary; a client cannot add a duplex flag to ordinary dictation/playback. Only the configured composition exposes the additive call capability. Older clients retain their dictation behavior.

Call views contain `contract`, opaque `id`, `conversationId`, monotonic `revision`, `state` (`active`, `muted`, `ended`), safe `reason`, `serverTime`, `expiresAt`, limits and at most 32 turn metadata rows. They contain no raw audio, transcript text, reply text, protected paths or credentials. Each turn names ordinal, deterministic request ID, message/steer kind, exact target, acceptance state and the existing current CHAT/steer receipt, if available. Accepted is distinct from applied, completed or effect success.

## Identity and restart

One confirmed ordinal derives one CHAT/steer ID from its call ID and ordinal. Before hashing/persistence, apply ordinary CHAT Unicode/byte/credential-content validation. The metadata intent binds call/revision/conversation, target, kind and exact confirmed text hash; a changed retry conflicts. CHAT alone retains confirmed text. A missing/unaccepted previous ordinal must be recovered before another is admitted.

Persist the metadata intent before the synchronous owning CHAT submission. The two journals are separate crash boundaries. On a retry/reconnect, first read the deterministic CHAT or steer receipt. If found, return that original identity/disposition without another submit. A pending metadata intent with no CHAT receipt is unaccepted; an explicit byte-identical retry can submit only while its original call/revision is still live. A stopped/expired/restarted call never admits an unaccepted turn. A previously accepted receipt that is no longer available is unavailable, not proof that nothing was sent.

Startup ends old active/muted calls with reason `restart`, retains metadata and the original CHAT receipts, and never reconstructs microphone capture, transcript submission or synthesis. Reopening the page reads current call/turn facts; resuming microphone capture needs another gesture. No raw transcript/audio goes into URL, browser storage, logs or ordinary exports.

## Limits, duplex and stopping

Hard call bounds: ten minutes and 32 confirmed turns. Keep at most 128 retained call records, each with at most 32 turn intents, under the existing seven-day voice retention. Timestamped expired/pruned begin identities cannot become new calls. Capacity refuses new work rather than dropping unknown identities. One live call is permitted installation-wide. Existing owner-generation and protected journal lease rules still apply.

At most one capture and one playback can reserve/process concurrently, and only for the same live call. Both retain their conservative worst-case local quota reservations. Another call or ordinary dictation/playback cannot borrow this exception. Capture bounds narrow to the remaining call time, including finite permission/submission grace. STT/TTS supervisor settlement remains separate from local microphone/playback stop; failed/unknown started processing keeps its conservative charge.

Mute/end stop browser tracks, nodes, buffers and audio immediately, then fence/cancel the corresponding service speech operations. Resume requires the exact current revision; it advances a muted or disconnected active binding so old capture/playback responses cannot revive. Retrying the retained resume command returns its original revision without cancelling a new capture. Repeated narrowing mute/end controls are safe; a stale resume refuses. The confirmed-turn ceiling ends the call with `turn_limit` after accepting its last text command. Expiry has a host-owned timer, advances/fences the call and aborts its speech processes; source/owner/route/budget loss also prevents new processing/publication. Ending voice never invokes CHAT stop, clears effect uncertainty or loses ordinary text results.

The client also stops native resources on permission/track loss, hidden/unloaded document, conversation/target/session changes and disconnect. It displays Listening, Transcribing, Review transcript, Thinking, Speaking, Muted, Reconnecting and Ended with visible limits, microphone state and accepted/applied facts. It fences late native permission, transcription and audio promises independently of remote settlement. Reconnect reads facts; no automatic send, re-recording or re-synthesis occurs.

## Compatibility and evidence

Call/turn tables are additive metadata in the optional protected voice journal. Older binaries ignore them; message/steer/effect schemas, existing scope/history, S14 default and S15 opt-in retain their meanings. No owner-host activation occurs. New state must ship through existing runtime/package inventory with no new dependencies or copied upstream assets.

Delivery requires actual service/client/UI and native speech evidence described by ADR 0098, including multi-turn request/effect counts, silence segmentation, barge-in, accepted response loss/restart recovery, withdrawal, all finite limits and English/Thai keyboard/mobile behavior. Isolated state tests or this document do not complete #423. Live device/account evidence and exact owner-host adoption remain #431/#432.

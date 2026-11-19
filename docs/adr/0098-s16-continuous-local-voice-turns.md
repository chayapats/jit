---
status: selected engineering contract; implementation and evidence pending
date: 2026-11-19
scope: CALL16-01 (#423); S16-AC15; FR-06/11/13/14/19/24/25/37/38; NFR-05/06/07/09/11
---

# Continuous local voice turns under existing conversation authority

## Required outcome and baseline

An intentional finite call must keep listening across turns, segment speech at silence, interrupt reply playback on barge-in, recover the original accepted turn after disconnect, and leave text/work usable when voice ends. Speech cannot approve an action or widen a running work grant. Reuse the authored [voice experience](../design/S16-rakazo-experience.md#voice-and-clients) and existing Mobbin R09/R10 observations; the primary agent owns the implementation and design.

At main `7184c2afb6826513c00f19a1213a6cbc42d03b8f`, #422 and #406 are merged/closed. [ADR 0096](0096-s16-bounded-local-dictation-and-playback.md) supplies actual optional local STT/TTS, strict PCM capture, pinned supervised executables, a persistent conservative local quota and guarded reply synthesis. [ADR 0086](0086-s16-live-steering-and-concurrent-conversations.md) supplies durable CHAT steering and Schway's public `schway.host.steering/v1`. A repeated dictation button alone does not deliver a call. #423 was unassigned with no competing branch/PR and is now owned on its own worktree.

## Alternatives

| Approach | Result and tradeoff |
| --- | --- |
| A new realtime provider/connection loop | Could reduce speech latency, but introduces recipient/account/billing and a second lifecycle without improving Jit's existing authority. Keep as a future explicitly configured adapter, with no automatic fallback |
| Browser/system speech recognition or synthesis | Can use an unproved remote service; ADR 0096's custody objections still apply |
| Reuse the protected local route with bounded client speech segmentation | Select. Actual continuous call orchestration, local silence detection, immediate client interruption and existing speech/process accounting can compose with CHAT without replacing Schway |

The pinned Rakazo voice adapter/native sources and their hashes were inspected in ADR 0096. Reuse those comparison observations, not upstream execution/authority code. No new upstream source, asset or package dependency is selected. Operator-supplied speech artifacts retain their separate licensing/provenance requirements.

## Selected turn and authority contract

`s16-voice-call/v1` adds one owner-authenticated, conversation-bound finite call and metadata-only turn identities to the existing optional voice service. It is not a Bot tool, grant, decision surface or provider loop. The owner deliberately starts the call after seeing its local route, quota and limits. The existing service owns capture/transcription and synthesis; only the current ordinary CHAT message or steering port admits a confirmed turn.

Silence finalizes a bounded speech clip into an editable **untrusted transcript**. The owner confirms it with Send turn, the same authority boundary as ordinary text Send. Ambient audio, quoted instructions and recognition mistakes cannot themselves start work. This confirmation does not approve a held effect: exact action cards remain the only decision surface. While work runs, the visible send target is that exact unfinished request and the confirmation uses existing steering; show queued/sent/applied/resubmitted/unapplied/uncertain facts separately. Starting a fresh request uses the ordinary explicit message admission. Never infer a larger grant from a recognized instruction or a playback interruption.

The call automatically rearms listening after a confirmed turn and can listen while thinking/speaking. Speech onset stops local playback immediately and fences pending synthesized audio. It creates no second CHAT request, does not undo a confirmed send and does not imply the Bot/effect stopped. End, mute, permission loss, hidden/unloaded document, owner/session change and target/conversation change stop microphone tracks, nodes and playback immediately. Resume after mute/reconnect requires an explicit gesture; no microphone reacquisition on reload. The full transcript, work state and needs-you cards stay in the ordinary authenticated conversation.

Each confirmed ordinal has one deterministic CHAT/steer request ID bound to the call, conversation, command kind, target and exact confirmed text hash. Retrying that ordinal cannot change its text/target or create a second request. Persist the intent metadata before submitting to CHAT; CHAT owns the confirmed text and durable receipt. These separate journals are not one atomic transaction. A crash between writes is resolved by a read of the deterministic CHAT/steer identity, never by inventing a fresh send or replaying audio. A missing receipt is an honest not-found/uncertain state. An explicit exact retry may reuse the original identity while the call is still admitted; a stopped/expired call cannot admit an unaccepted turn. Accepted receipts remain recoverable after the call ends.

Raw audio and unconfirmed transcripts remain ephemeral under ADR 0096. The call journal stores bounded metadata/identities/hashes, not audio, transcript text, reply text, credentials or model sessions. Confirmation places text only in the existing CHAT store. Every status/result reacquires the current owner/conversation and underlying guarded publication. Reconnect reads existing call/turn facts and never starts capture, synthesis or work. Stale private results remain withheld after session/source withdrawal.

## Bounds, duplex and lifecycle

Select a hard ten-minute call, at most 32 confirmed turns, one bounded pending transcript and one in-flight confirmed turn. Existing 30-second capture, PCM byte and local daily quota ceilings still apply and may be configured smaller. Segment an utterance after bounded trailing silence; a finite no-speech timeout ends the current listening window instead of retaining unbounded silence. Publish exact activity thresholds/timers in the versioned contract and test them with PCM and fake clocks. Energy detection is segmentation, not speaker identity or proof of intent.

Listening during reply synthesis requires bounded duplex reservations. Permit at most one capture and one playback belonging to the **same live call**, while retaining both worst-case quota reservations and independent process settlement. Ordinary dictation/playback and other calls cannot borrow that exception. At most one transcript is processed/reviewed; additional audio cannot form an unbounded queue. Cancellation after local processing starts keeps conservative usage until the actual supervisor settles. Call expiry/budget/route loss fences new speech and stops client audio while leaving existing CHAT results, effect uncertainty and unrelated work intact.

The selected lifecycle exposes Preparing, Listening, Transcribing, Review transcript, Thinking, Speaking, Muted, Reconnecting and Ended, with the exact accepted/applied turn facts alongside it. Playback and microphone custody are separate from those CHAT dispositions. Interruption fences late responses even when service processing has not settled. Muting discards the current unconfirmed capture rather than sending a partial command. Ending is not a CHAT stop command.

## Compatibility and proof obligations

Existing `s16-voice/v1`, exact decisions, message/steering schemas, owner configuration and default runtime keep their meanings. Add call discovery/operations only when the protected local voice route is configured. Older clients ignore the additive capability/tables; no historical scope or CHAT record is migrated. No production activation, owner account/device acceptance or wider budget is implied. #431/#432 remain separate; parent #392 remains open for the rest of S16.

Before delivery, demonstrate the actual composed service/client with scripted models and real bundled English/Thai keyboard/mobile UI: multiple confirmed turns, automatic silence segmentation, barge-in before/during playback, accepted response loss and read-only original-receipt recovery, restart between journal writes, current source/owner withdrawal, mute/end/permission/visibility loss, finite call/turn/idle/daily limits and text fallback. Assert actual request/effect counts and steering dispositions, not only reducer phases. Run existing voice, CHAT/steering, exact-approval, runtime/package/provenance regressions. Reuse real native speech artifacts for an opt-in composed call proof, recording exact tested builds/commands and honest device/recognition limits. Source presence, a successful HTTP response or this ADR alone is not completion.

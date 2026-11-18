# s16-voice/v1

Status: selected contract for #422 implementation ([ADR 0096](../adr/0096-s16-bounded-local-dictation-and-playback.md)); **not an implemented capability yet**. #423 owns continuous calls. This draft records decisions before behavior changes and must be reconciled with actual exported signatures/endpoints/tests before delivery.

## Protected host route

Compose an optional local voice service in S15 and add an optional `voice` capability to the existing shared client. Older services/clients keep text behavior. No configured route means voice unavailable, never an implicit browser/cloud service. A route names pinned executable/model artifacts, STT language, synthesis kind/voice and finite local quota. Protected paths and raw CLI output never enter capability JSON. Configuration is explicit host-owned state, not a model/tool payload.

Linux route: `whisper.cpp` CLI with fixed model/file/output/language/no-GPU/thread arguments, plus `espeak-ng` file-to-WAV synthesis. macOS evidence may explicitly select `say` file-to-WAV synthesis; this does not claim Linux availability. No shell parsing, arbitrary flags, URL input, inherited provider credentials or automatic model download. Verify exact configured artifact hashes before use. Operator-supplied libraries/model/voice data remain a trusted installation dependency; do not claim the CLI wrapper is a sandbox against a malicious executable.

## Owner-client operations

All operations use the current shared-client owner session, exact Host/Origin, CSRF for POST, no cross-site access, no-store responses, finite streamed bodies and reauthentication after asynchronous boundaries. No voice endpoint accepts an approval command or serialized actor.

| Operation | Binding and result |
| --- | --- |
| Read capability/usage | Actual configured route health, finite limits, local audio-second quota and pending/unknown reservations. Read starts no capture/process |
| Begin dictation | One exact command ID, conversation and current session generation; reserve bounded local capture quota. Returns opaque capture identity, expiry and permitted duration/bytes; starts no Bot work |
| Transcribe | One capture identity and strict PCM WAV bytes; identity/hash conflict refuses. Actual owner/route/capacity checks precede process start and transcript publication. Returns editable untrusted draft text plus observed/unknown usage |
| Cancel | Fence current capture/transcription, stop and join actual local process, discard scratch/draft. A late result cannot revive it. Does not cancel a Bot request |
| Synthesize reply | One identity with exact conversation/request/revision/text hash. Reacquire current guarded owner projection; synthesize only its published result. Return bounded WAV after current authorization/source checks |
| Interrupt playback | Stop client audio immediately, revoke its object URL and fence pending synthesis/play responses; underlying work remains separate |

These are semantic operations; final HTTP paths and exported types are frozen with the implementation. Client retries never invent an identity or automatically replay speech. No transcript is automatically submitted to CHAT. Owner Send uses the ordinary frozen message command/receipt and unchanged exact-decision surface. Cancel before Send creates no conversation request/work.

## Audio and finite usage

Capture uses explicit `getUserMedia` after a deliberate Mic action, with visible Recording/elapsed time/Stop/Cancel. A bounded PCM conversion emits canonical RIFF/WAVE, PCM format 1, mono, 16-bit little-endian at 16,000 Hz. Validate RIFF length, exact format/data layout, alignment, sample count and hard duration/byte limits before CLI input. Reject malformed/compressed/oversized or trailing data rather than trusting MIME or client duration. No private audio decoding library or arbitrary attachment parser runs for capture.

Hard per-capture ceiling: 30,000 ms / 960,044 canonical WAV bytes. Transcript is at most 16 KiB UTF-8 and still subject to ordinary message limits. Synthesis accepts at most 2,000 characters / 8 KiB UTF-8 of one current result, with at most 60 seconds / 4 MiB output and a finite process deadline. Longer replies remain readable; do not silently label truncated speech as a complete result. Final implementation may narrow bounds and must publish the actual limits before capture/playback.

Configured quota is local audio seconds per UTC day, persisted outside the working VM. Reserve worst-case capacity before capture/synthesis; update observed accepted/generated audio seconds only after real evidence. Unknown processing keeps its conservative charge/reservation, including restart. Local audio seconds are not measured compute time, provider billing or tokens. A refused/not-started operation can release unused capacity; cancellation after actual processing is not proof of zero usage. Quota exhaustion or route failure stops voice without disabling text or switching provider.

Only one owner capture/playback lifecycle is active per client generation. Permission denial/revocation, track `ended`/unusable capture, cancellation, limit, target change, logout and unmount stop all tracks/nodes and clear buffers. An unresolved permission prompt can outlive a cancellation: any later stream must be stopped without adoption. Stop does not rely on a `MediaStreamTrack` ended event firing for application-initiated stop. Browser resources and pending responses are fenced independently of server process settlement.

## Custody, publication and recovery

Raw audio stays in client memory and protected service scratch. The local engine receives only bounded private files and a minimal environment; raw output is never returned as an error. Scratch is removed after actual process settlement; startup reaps abandoned scratch without following arbitrary paths. No audio/transcript is placed in the working VM, native model history, logs or ordinary exports. A submitted transcript becomes ordinary owner text under existing CHAT custody. Browser/device-local memory cannot be remotely recalled after disclosure.

The service owns a separate versioned voice/quota journal with bounded metadata and no audio. It retains original command identities and conservative charges across process loss. A restarted pending local operation becomes terminal/unknown, with no reconstructed execution. Missing/expired draft/audio results are reported honestly; automatic re-recording, re-synthesis or re-submission is forbidden. #423 will extend continuity for confirmed continuous-call turns using the existing durable CHAT receipt, rather than treating a voice response as work acceptance.

The implemented core uses `VoiceService.open` with an exclusive protected journal lease before its engine factory opens scratch. `begin`, `inspect`, `transcribe`, `playback`, `cancel`, `status` and memoized `close` accept trusted current-owner ingress closures; they are not model tools or serialized actor APIs. Client composition remains pending. Command IDs embed issuance time (`voiceRequestId`); first admission permits five minutes of age and thirty seconds of future skew. Retained retries reuse the original binding. Terminal metadata may expire after seven days, but an old timestamped identity still cannot become a new capture. A persisted clock high-water prevents clock rewind from resetting a quota day. At most 4,096 retained operations and 8 MiB / sixteen short-lived response-cache entries are permitted; storage exhaustion refuses new voice work honestly.

Accepted input duration is known from strict PCM bytes and rounded up to quota milliseconds when transcription starts. Synthesis starts with its conservative maximum and narrows only after a valid actual WAV result. Failed/unknown started processing does not refund the charge. The independent local supervisor retains a private stdin liveness lease; controller loss, cancellation or its own deadline kills and joins its CLI before writing a metadata-only settlement receipt. A reopened engine cleans abandoned scratch only when no command could have been supplied or the matching supervisor receipt proves settlement. An unproven orphan keeps the route unavailable. Runtime composition must place scratch in protected temporary storage outside application state/backups, while the metadata-only journal remains durable. No raw audio/draft is an ordinary export.

Private reply publication is always reacquired through the owning conversation service, including before returning generated audio. Source withdrawal, owner/session revocation, changed result/revision, changed route artifact or generation prevents stale publication. Interruption invalidates client playback without claiming remote work or effects stopped. Audio content, transcripts, quoted commands and model output cannot approve, change scope or configure a route.

## Delivery evidence

Tests must exercise the actual configured local adapter/service and ordinary Send/decision ports, not only a reducer or a mock successful transcript. Deterministic fixtures cover strict WAV parsing, finite quotas across restart, duplicate/conflicting commands, late permission/result rejection, denied/revoked capture, exact reply/current-source checks, provider/process loss and no work before Send. Real English/Thai bundle tests cover keyboard/mobile/error states, interrupted playback, text fallback and transcribed approval words. Opt-in local speech evidence records actual known speech transcription and reply audio with exact executable/model hashes. Physical native-device/permission acceptance remains #431; source presence or this contract is not completion.

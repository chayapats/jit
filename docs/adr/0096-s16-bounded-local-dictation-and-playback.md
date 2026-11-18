---
status: selected engineering contract for implementation; no voice availability claimed yet
date: 2026-11-18
scope: VOICE16-01 (#422); S16-AC15; FR-06/11/13/14/19/24/25/37/38; NFR-05/06/07/09/11
---

# Bounded local dictation and reply playback

## Required outcome and current baseline

S16-AC15 and the authored [voice experience](../design/S16-rakazo-experience.md#voice-and-clients) require intentional microphone capture, visible recording/transcription, an editable transcript, cancellable playback and finite usage. Text remains usable. Audio/transcribed approval words cannot invoke an exact protected decision. Continuous calls belong to #423; native account/device evidence belongs to #431. The primary agent owns implementation/design under the current AGENTS agreement.

At main `be21d747d25f4a6a234f057d8b35362501b03a7f`, the shared client (#395) and connections (#417) prerequisites are merged/closed. The React composer, guarded owner projections, command identities and exact decision cards are available. There is no audio implementation; `tests/chat-voice*` tests prose style. #422 was unassigned with no competing branch/PR; it is now owned on an issue-specific worktree. Existing worktrees are untouched.

## Alternatives and source observations

| Choice | Benefits and limits | Selection |
| --- | --- | --- |
| Browser/system speech recognition and synthesis | Little server infrastructure. Recognition may use a browser/vendor service or lack a language/platform; synthesis voices can also be remote. A system API is not evidence of local custody | Do not silently use it as local speech. A future explicit device-local adapter must prove its locality and availability |
| Protected provider STT/TTS | Broad language/voice coverage; requires exact account/recipient, billing scope, current private-source checks and uncertain-usage handling | Keep as a future adapter option, not an automatic fallback or a prerequisite for configured local voice |
| Local CLI STT/TTS on the protected Jit host | Actual speech without a new external recipient or paid account. Operator supplies verified binaries/model; resource limits and lifecycle are Jit's responsibility. Recognition/voice quality varies | Select `whisper.cpp` transcription and `espeak-ng` synthesis on Linux, with an explicit `say` synthesis adapter for macOS development/evidence |

The selected local route satisfies #422's configured-local-or-provider choice. It does not claim every provider or device is supported. The host uses fixed argument arrays, private bounded files and finite processes, never a model-provided command or a working-VM execution backend. Schway continues to own model/tool execution; this owner-client audio adapter introduces no provider loop or private Schway import.

Rakazo inspection: repository `elie222/rakazo`, immutable commit `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`, tree `f8ca5adc96366b722bb60186c21cb29cec0f5390` (complete tree, not truncated). Read without executing upstream scripts:

| Source | SHA-256 | Observation |
| --- | --- | --- |
| `packages/adapters/src/openai-compatible-voice.ts` | `33c9fd666df55f36305b26e1a0f9b6deaf0e73e36e07e0382c64f51d5f154c76` | Explicit compatible server/model credentials, bounded transcription/synthesis calls; not Jit's recipient/budget authority |
| `packages/adapters/src/voice-http.ts` | `ceda3d36f626a5893e808f8e94ceb2edd7ff853a234c718165697843359fb80e` | Finite request deadlines and response byte limits are useful concepts |
| `apps/desktop/native/speech/main.swift` | `099d8862dae69ebbd077b352c30afcbf21e949c7008cba1c08c56f0225295b30` | Requests on-device recognition when supported, otherwise permits system service; that fallback cannot establish Jit's local-only route |

These are comparison observations, not upstream vulnerability claims. No upstream source/assets/dependencies are copied. Existing Apache-2.0 inventory/notices remain unchanged; future copied files follow ADR 0074/0080. CLI binaries, voice data and model weights are separately operator-supplied artifacts; each installation must retain their applicable licenses/provenance rather than infer them from Jit's MIT license.

## Selected ownership and custody

The proposed [s16-voice/v1](../contracts/s16-voice-v1.md) owns finite client capture sessions and local speech usage. It adds no Bot tool, message admission or approval authority. The configured voice route is installation-owned, opt-in and contains no credentials. Its artifact paths/hashes are protected configuration; clients get labels, capabilities and limits only. No automatic binary/model download or installation activation occurs.

The owner starts dictation with a deliberate Mic press. The authenticated service reserves finite local quota before capture. The browser then requests microphone permission, captures bounded PCM and stops every track/audio node on Stop, Cancel, permission loss, page/target/session change or deadline. Cancelled/late permission promises immediately stop any subsequently supplied stream. No browser speech-recognition service is contacted.

Stop submits a bounded canonical WAV to the same authenticated Jit service for one fixed local transcription. A transcript is untrusted draft data. It is not a conversation message until the owner uses ordinary Send; editing and cancellation create no Bot work. Spoken/quoted "approve" cannot call `decide`, `decideAction` or change purpose. Existing file-bearing/steering semantics remain explicit rather than being inferred from speech.

Playback selects the exact currently guarded reply by conversation/request/revision/text digest; it does not accept arbitrary unguarded text from the page. Recheck owner/session and source publication before local synthesis and before publishing audio. Interrupt stops playback immediately and fences pending playback responses; underlying Bot work keeps its existing state. Local synthesis is not evidence that an effect succeeded.

## Bounds, uncertainty and compatibility

Use finite per-capture duration, WAV bytes, transcript/reply bytes, local process time, synthesized audio duration/bytes and persistent per-day local speech quota. Configuration can narrow published hard limits. Unknown/failed process usage retains its conservative reservation; do not reset quota on restart or confuse audio seconds with measured CPU/GPU time, provider tokens or a zero monetary bill. Local route loss/budget exhaustion ends voice with a safe code while ordinary text remains usable. No fallback creates a new account/recipient or raises limits.

Audio/transcript scratch is private and short-lived, never in model prompts, working VM, exports, raw errors or logs. Submitted text uses existing conversation retention. Metadata-only quota receipts remain protected; abandoned pending operations are terminal after restart and cannot silently replay. Shutdown kills and actually joins local children before removing scratch/releasing capacity. Browser stop and server settlement are separate facts.

This is a new optional voice journal/port, not a migration of CHAT, TEAM, MEM, FILE or policy meaning. S14 stays default; S15 opt-in and omitted-runtime compatibility stay. No existing owner host/account/policy is changed by implementation. Packaging verifies the optional feature without bundling a model/binary or asserting device acceptance. #422 closes only after actual composed client/service and native speech evidence plus required checks/review; this document alone does not complete it.

## Verification obligations

Use deterministic PCM/command fixtures, fake clocks and barriers for quota, cancellation, lost responses, stale generations and current owner/publication checks. Browser tests exercise the real bundle in English/Thai and mobile/keyboard layouts, with fake media devices rather than a real microphone. Native opt-in evidence must transcribe actual known speech and synthesize an actual guarded reply through configured local executables, recording exact binary/model/build hashes. Label recognition accuracy, device permissions and all untested platforms honestly. #423 retains continuous-call/barge-in/reconnect behavior.

Protocol references inspected 2026-11-18: [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [whisper.cpp CLI implementation](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp), [espeak-ng command reference](https://github.com/espeak-ng/espeak-ng/blob/master/src/espeak-ng.1.ronn). Implementations must validate their exact supplied build; these moving references are not installation pins.

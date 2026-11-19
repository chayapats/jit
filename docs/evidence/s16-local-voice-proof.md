# VOICE16-01 local dictation and guarded playback

Date: 2026-11-18. Runtime source: `60679513fdf70d0f9b32e409387023e7068dafae`. Scope: #422, the bounded-dictation/playback portion of S16-AC15; FR-06/11/13/14/19/24/25/37/38; NFR-05/06/07/09/11. Contract: [s16-voice/v1](../contracts/s16-voice-v1.md), [ADR 0096](../adr/0096-s16-bounded-local-dictation-and-playback.md), [operator runbook](../runbooks/s16-local-voice.md).

This evidence uses the actual optional composed voice service, shared client, local process supervisor and React/AudioWorklet bundle. Model, interpretation and working-VM work remain scripted fixtures. Native speech uses actual local executables/model files; no microphone, private recording, provider credential, metered API or owner-host activation is used. Installation paths and full private receipts remain ignored `.local` records. Public facts below contain build/artifact hashes and outcomes.

## Actual local speech

`tests/s16-voice.native.test.ts` synthesizes the original public test sentence, "The quick brown fox jumps over the lazy dog.", converts its actual PCM to canonical capture WAV, transcribes through the actual configured whisper CLI, and verifies the known words without changing assertions between platforms. The composed request count and model history stay empty until ordinary Send. An explicit text edit adds a diagnostic instruction; scripted model/VM work then publishes the real guarded result, "Completed with observed tool evidence.", which the local adapter synthesizes. Final usage has no outstanding reservation or conservative charge.

| Observation | macOS ARM64 | Linux ARM64 |
| --- | --- | --- |
| Receipt UTC | `2026-11-18T05:45:53.063Z` | `2026-11-18T05:48:28.227Z` |
| Runtime | Bun `1.4.2` (`43848b5a7`) | Ubuntu 24.04.5, Bun `1.4.2` (`744846f84`) |
| STT | whisper.cpp v1.9.2, `tiny.en`, language `en`, CPU-only fixed arguments | whisper.cpp v1.9.2 CPU build, `base.en`, language `en`, same fixed arguments |
| TTS | Explicit local `say`, installed `Samantha`, rate 165 | eSpeak NG `1.51+dfsg-12build1`, installed `en-us`, rate 165 |
| Canonical input duration | 2,670.75 ms | 3,091.1875 ms |
| Observed transcript | Exact test sentence | Exact test sentence |
| Actual reply duration | 2,194 ms | 2,531 ms |
| Charged local audio | 4,865 ms | 5,623 ms |
| Native suite | 1 pass, 0 fail, 10 assertions | 1 pass, 0 fail, 10 assertions |

Usage dates are intentionally `1970-01-01` under the composed fixture's deterministic clock; receipt UTC is the actual proof time. Audio seconds measure accepted/generated audio, not compute time or monetary cost. The Linux proof ran inside a disposable controller VM and does not assert default Linux/KVM or owner-host acceptance.

| SHA-256 artifact | macOS ARM64 | Linux ARM64 |
| --- | --- | --- |
| `whisper-cli` | `40bca494d49af736058eb3f33cbcebaa020eacf6d0087b623f334946e1ab2128` | `651c5ca81bbd648da226598e0349ec097ffb1c74dd04f8e8f249e807b1758bb6` |
| Synthesis executable | `29f947458332d87ae788ba874728bfbe5fc39a30b6249522569ddbd11bd2bb5c` | `89402b6a13d29ab2edb0570c809796751b22a5d031828897cfb1b370dafa9c29` |
| Model | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| Canonical input WAV | `dec53bc57d9f07d9b5c133aa91c069c91e2d2b3050f85c90ff032037ad87d3af` | `75b061d3b158a198b8fc7b9a029dba7c2d2eee0af2b5223a585f4500b6d15a7b` |
| Actual reply WAV | `2b8f1312b9fa85aabf4351cb8e9494d286b94e66f742441b713051a8ad04510a` | `620a065674469b24d8e2761b3117e352088938981b2c43aca761197ba95a7228` |

The Linux source archive is [whisper.cpp commit `306c88f4d1286aec1bf96e544632897886af5501`](https://github.com/ggml-org/whisper.cpp/tree/306c88f4d1286aec1bf96e544632897886af5501), archive SHA-256 `f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df`. It was built with CMake `3.28.3-1build7`, GCC package `4:13.2.0-7ubuntu1`, Release, two build jobs, `GGML_NATIVE/OPENMP/BLAS/CUDA/VULKAN=OFF`, `WHISPER_CURL=OFF`, `WHISPER_BUILD_TESTS=OFF`, target `whisper-cli`. Runtime still explicitly passes `--no-gpu`. Artifact pins cover the executable/model, not an attestation of every dynamic dependency or an OS sandbox. Source, binaries, voice data and weights are separately trusted operator dependencies with their own licenses; Jit imports/bundles none of them.

Both public models came from Hugging Face repository `ggerganov/whisper.cpp`, immutable revision `5359861c739e955e79d9a303bcbc70fb988958b1`; downloaded bytes were checked against its LFS SHA-256/size metadata. Model links, bytes and hashes are in the runbook. No training was performed.

## Browser and owning-service behavior

`JIT_S16_BROWSER_TESTS=1 bun test tests/s16-voice.browser.test.ts`: **7 pass, 0 fail, 71 assertions**. The real English 1440 px and Thai 390 px React layouts use native Chrome fake media devices and the actual fixed AudioWorklet over a loopback HTTP server. Sound is muted; no physical microphone is opened. Keyboard-started reply playback, no horizontal overflow, elapsed capture, Stop, editable transcript, Add to message and ordinary Send are exercised. Before Send there is no CHAT request/model history; Cancel creates no additional work. Playback interruption and later local route loss stop client audio without stopping the underlying conversation request. Controlled permission denial/track-mute, late permission after navigation and actual owner-cookie rejection exercise cleanup/text fallback and private-draft clearing. The session-negative case's HTTP 401 is expected. Fake wall-clock barriers also cover permission delayed beyond fifteen seconds, automatic recording stop followed by successful upload, an expired recording receipt opening no microphone prompt, and a late recording-health response preserving the completed editable transcript.

Chrome AudioWorklet fetches bypassed the older Playwright request-route harness; the final test uses a real isolated HTTP server rather than substituting a fake worklet. The successful native capture uses the actual browser AudioContext/AudioWorklet classes. Screenshots were inspected for desktop/mobile layout; they are private test artifacts, not physical-device evidence.

`tests/s16-voice-client.test.ts` additionally exercises the actual HTTP/composed ports: approval words remain ordinary text while a Google send slip stays pending; streaming reauthentication and malformed/oversized capture refuse before engine start; client clear rejects late private JSON; withdrawal after the synthesis promise resolves still prevents final HTTP audio release; omitted voice preserves text and creates no voice journal; the worklet requires owner authentication and no-store/CSP headers.

## Durability, bounds and regression coverage

At the source revision above, `bun test tests/s16-voice-audio.test.ts tests/s16-voice-local.test.ts tests/s16-voice-service.test.ts tests/s16-voice-client.test.ts` passed **30 tests / 164 assertions** on both macOS and Linux ARM64. This includes the authenticated-worklet case (seven client tests / 35 assertions) and a completed clip submitted during the separate finite submission window. The core covers strict actual PCM bytes, 30-second limits, native `say` filler without relaxing capture input, pinned artifacts, minimal process environment, actual cancellation/deadline/close joining, actual controller SIGKILL plus supervisor settlement, journal reopen/unknown quota/no replay, route-health races, stale generation and reply/source guards. These process-crash fixtures use actual subprocesses with controlled CLI output; they are distinct from the actual speech proof above.

The composed/runtime/package regression at the final runtime source above passed **254 tests / 1,479 assertions across thirteen files**. Frozen install, typecheck, upstream provenance and committed diff checks passed; the PR records its final head (including subsequent evidence-only changes). Linux ARM64 typecheck passed after its repeated native proof; provenance passed on both platforms. Package tests exercise the existing source inventory, which ships the supervisor/worklet without bundling speech models or binaries.

## Review and CI corrections

Review identified that slow permission could let recording end at submission expiry. Capture receipts now separate `recordingEndsAt` and a submission deadline fifteen seconds later. Expired recording receipts refuse before asking for microphone access. A delayed capture-health failure can update availability without discarding an already completed transcript; owner/authentication rejection still withholds it.

The initial ARM64 CI shard 5 failed when a crash-test marker became visible before its JSON write completed. The controlled marker is now published by atomic rename, and the production supervisor similarly publishes its complete settlement receipt only after joining the actual CLI. No timeout/assertion was weakened. The exact failing shard command passed locally: **641 pass, 17 opt-in skips, 0 fail, 66,627 assertions across 52 files**. Updated native/controller-crash suites passed on Linux ARM64 as recorded above; the fresh PR CI run must still pass on its own final head before merge.

## Failed experiments and remaining acceptance

The first macOS actual WAV included an `FLLR` padding chunk and was refused by synthesis validation. The corrected parser accepts that bounded padding; an independent fixture keeps canonical capture strict. The Linux source build initially produced a group-writable executable, correctly refused by artifact validation; the supplied artifact's mode was corrected before proof, without changing its hash. Linux `tiny.en` misrecognized the eSpeak NG sentence (including "quick brown fox"). That run failed the unchanged assertions and is not accepted evidence. Selecting the separately pinned `base.en` model passed the same test. These results do not establish broad recognition quality.

Thai copy/layout is tested; Thai speech accuracy is unverified because these proof models/voices are English. Operators must validate their selected multilingual model/voice. Physical microphone permission/revocation, real mobile audio/background behavior, other speech platforms/languages, accounts and owner-host cutover remain #431/#432. Linux x64 deterministic CI is separate from actual ARM64 speech proof. Subsequent continuous call, barge-in and reconnect delivery is recorded separately in the [CALL16-01 evidence](s16-voice-call-proof.md); this original standalone proof does not establish that later behavior. Parent #392 and full S16-AC15/AC22 acceptance stay open. No production deployment, standing-policy change, default-runtime cutover, historical scope migration or private-data disclosure follows from this proof.

# CALL16-01 continuous local confirmed voice turns

Date: 2026-11-19. Runtime source: `9d8050df37d97c221cd1281b4410a14d326ff4bd`. Scope: #423, the continuous-call portion of S16-AC15; FR-06/11/13/14/19/24/25/37/38; NFR-05/06/07/09/11. The selected decision preceded implementation: [ADR 0098](../adr/0098-s16-continuous-local-voice-turns.md), [s16-voice-call/v1](../contracts/s16-voice-call-v1.md). Setup and recovery: [local voice runbook](../runbooks/s16-local-voice.md).

This proof composes the actual optional speech service, shared client, CHAT/steering receipts, React UI, fixed AudioWorklet and native media playback. Model/interpretation/VM work is scripted. Browser audio is deterministic PCM with Chrome's fake physical device; actual STT/TTS is separately exercised with supplied local executables/models. No physical microphone, private recording, provider credential, paid speech route, account change or owner-host activation is used. Private receipts, installation paths and screenshots stay in ignored `.local` records.

## Observable turn and authority behavior

One deliberate call is bounded to ten minutes and 32 confirmed turns. Silence produces an editable untrusted transcript. Explicit Send turn confirms its exact text and visible CHAT/steer target; this is the ordinary message input boundary, not an action approval. Listening rearms across turns and during reply synthesis/playback. Sustained speech onset interrupts local audio and pending response adoption immediately, without a second request or CHAT stop. This delivery does not claim automatic hands-free message admission.

`tests/s16-voice-call.browser.test.ts` exercises the real bundle/HTTP server and actual AudioContext/AudioWorklet/HTMLMediaElement. English 1440 px and Thai 390 px cases use keyboard Send turn, actual silence segmentation, editable quoted approval text, two confirmed messages, overlapping microphone/reply audio, barge-in, mute/resume and End. The resulting CHAT request count is exactly two. Before confirmation it is zero and model history is empty. The confirmation buttons and target stay visible on mobile, with no horizontal overflow; desktop/mobile screenshots were inspected.

Barriers additionally demonstrate that local audio/tracks stop before a delayed remote cancel/mute settles; a previously synthesized but late HTTP reply cannot play after barge-in; late native permission and late Resume cannot restart media after End. Controlled permission denial, track-mute and hidden-document events keep typed text usable and create no request. A finite quota refusal ends the call before another permission prompt while retaining the already accepted CHAT text/result. A held CHAT result displays attention in chat and produces no invented speech.

Accepted-response loss is injected after the actual owning service has written its receipt. Read-only recovery returns that same deterministic turn identity with no new microphone, synthesis or request. Gesture Resume fences the old binding and does not replay a reply. A separate loss before admission retains the exact unsent text; it can be explicitly discarded only after acknowledged End and a current unaccepted/absent ordinal. Accepted/unavailable receipts cannot use that path.

## Native local speech on the same source

`tests/s16-voice.native.test.ts` retains the standalone dictation proof and adds a two-turn call proof. The public synthetic sentence is the original pangram from the [standalone evidence](s16-local-voice-proof.md). Actual local STT recognizes its known words twice. There is no CHAT/model request until explicit confirmation. The first accepted response is lost and retried under its original identity; request count stays one. Actual local TTS synthesizes the guarded scripted reply, "The confirmed voice turn was received.", while a same-call capture reservation remains live. Mute/resume rejects the old capture binding before another transcription. The second confirmation uses CHAT steering's resubmitted follow-up, then actual TTS speaks that currently guarded result. Final counts are two transcriptions, two syntheses and two CHAT requests, with no reserved or conservative usage.

| Observation | macOS ARM64 | Linux ARM64 |
| --- | --- | --- |
| Call receipt UTC | `2026-11-19T10:47:39.070Z` | `2026-11-19T10:48:16.525Z` |
| Runtime | Bun `1.4.2` (`43848b5a7`) | Bun `1.4.2` (`744846f84`) |
| STT | whisper.cpp v1.9.2, `tiny.en`, English, CPU-only | whisper.cpp v1.9.2 CPU build, `base.en`, English |
| TTS | Existing local `say` / `Samantha` | eSpeak NG `1.51+dfsg-12build1` / `en-us` |
| Each canonical input | 2,670.75 ms | 3,091.1875 ms |
| Each reply | 2,172 ms | 2,431 ms |
| Total charged audio | 9,686 ms | 11,046 ms |
| Native suite, dictation + call | 2 pass / 37 assertions | 2 pass / 37 assertions |

The exact executable/model pins and immutable upstream model/source provenance are unchanged from the [standalone artifact table](s16-local-voice-proof.md#actual-local-speech). Each configured job rehashes those pins. No dependency, voice data, weights or upstream source was added/bundled. The Linux proof uses a disposable controller VM; it does not establish a Linux/KVM working host or owner-host acceptance. Fixture usage dates remain `1970-01-01`; receipt UTC is actual proof time.

| SHA-256 | macOS ARM64 | Linux ARM64 |
| --- | --- | --- |
| Canonical input WAV | `dec53bc57d9f07d9b5c133aa91c069c91e2d2b3050f85c90ff032037ad87d3af` | `75b061d3b158a198b8fc7b9a029dba7c2d2eee0af2b5223a585f4500b6d15a7b` |
| Each actual reply WAV | `f820431af85469ba72f1ab34d26e7a3880dcf9765eb9045f58d4c675d344f343` | `a161200f7eebaa4576f4e71d8708f1518ba298d4bbb8b2ca458c6dee49399751` |

## Durability, bounds and regression commands

The six voice suites comprise **47 tests / 268 assertions**, also included in the full command below on both platforms. Call cases cover separate journal crash boundaries before/after CHAT admission, no automatic replay after restart, byte-identical retry conflicts, accepted versus steering dispositions, credential-shaped input rejected before intent/hash persistence, same-call duplex quotas, source/owner withdrawal during synthesis, exact resume idempotency, preparing-call cancellation, expiry and all 32 original turn receipts after the hard ceiling. PCM tests cover the exact activity/onset/silence/idle bounds; existing actual subprocess tests retain crash/cancel/deadline/quota coverage.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 30000 tests/s16-voice-call.test.ts tests/s16-voice-service.test.ts tests/s16-voice-client.test.ts tests/s16-voice-local.test.ts tests/s16-voice-audio.test.ts tests/s16-voice-segmentation.test.ts tests/s16-steering.test.ts tests/s16-client.test.ts tests/s15-composition.test.ts tests/s15-runtime.test.ts tests/s15-runtime-bindings.test.ts tests/ops-service-package.test.ts tests/s16-upstream.test.ts
JIT_S16_BROWSER_TESTS=1 bun test tests/s16-voice-call.browser.test.ts tests/s16-voice.browser.test.ts tests/s16-approval.browser.test.ts tests/s16-steering.browser.test.ts
bun run upstream:check
git diff --check
```

The composed/runtime/package/provenance regression command passes **281 tests / 1,545 assertions** on both macOS and Linux ARM64. Frozen dependency installation and typecheck pass on both; Linux invokes the same compiler directly with `bun node_modules/typescript/lib/tsc.js --noEmit` because Node is not installed. Linux uses the existing dedicated non-root fixture account, with `umask 022`. Package source inventory distributes the new call/client code through its existing tree; additive call metadata uses the existing protected journal, with no scope/history migration. No S14 default, S15 opt-in, installed policy or owner configuration was changed.

The exact four-file browser command passes **21 tests / 204 assertions** on each platform: ten call cases, seven standalone voice cases, two exact in-chat approval cases and two running-work steering cases. Linux uses Chrome for Testing `156.0.8078.4`, executable SHA-256 `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65`, and Bun executable SHA-256 `616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1`, kernel `6.8.0-149-generic`. Actual speech runs under the controller fixture user with access to its previously supplied pinned artifacts; browser/package cases use the dedicated non-root fixture account. No live account or working-VM browser trust anchor is involved. Private receipts/logs were copied before stopping the disposable controller VM.

## Failed experiments and limits

The first browser harness could not find a completed transcript because a wrapping accessible label included its mutable text value. An explicit `htmlFor`/`useId` association fixed the actual label. Successful native synthesis then exposed a final publisher hash that omitted the call binding; the publisher now validates the same immutable binding as admission, with a successful-publication/retained-listening regression. A repeated execute-mode scripted fixture correctly held its second request as `result_unavailable` when it supplied no fresh tool evidence. Multi-turn voice tests use an explicit answer fixture; a separate held-work test verifies honest attention instead of bypassing CHAT's evidence guard.

Final review reproduced a control-response publication gap: generation withdrawal after the asynchronous control completed could return its earlier call metadata. The HTTP publisher now reads the current guarded call view again in its serialization turn. The new actual HTTP/client regression rejects that boundary with `voice_stale`/403; the pre-fix test returned a successful response. Full browser, composed/package and native proofs above were repeated on the corrected runtime source.

An initial Linux package regression inherited the account's `umask 002`; its generated fixture directories were group-writable and the root-path policy correctly refused them. Running the unchanged suite with `umask 022` passed. The raw failure log remains private. The first six-suite Mac command used Bun's five-second default and timed out on the 32-turn integration case; the required `--timeout 30000` command passed with no assertion/bound weakened.

Thai copy/layout is tested; these English-only native models/voices do not prove Thai recognition or synthesis quality. Fake media and controlled track/visibility events do not establish real microphone permission/revocation, real mobile background audio or physical-device acceptance. Those and real account/owner-host cutover remain #431/#432. Parent #392 and complete S16-AC15/AC22 acceptance remain open for their remaining deliverables. No production deployment, billing, credential change, historical private-scope migration or owner-host activation follows from this proof.

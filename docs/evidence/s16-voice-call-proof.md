# CALL16-01 continuous local confirmed voice turns

Date: 2026-11-19. Runtime source: `2a0978d72a9c44273711f802a2c12b0a80bca721`. Scope: #423, the continuous-call portion of S16-AC15; FR-06/11/13/14/19/24/25/37/38; NFR-05/06/07/09/11. The selected decision preceded implementation: [ADR 0098](../adr/0098-s16-continuous-local-voice-turns.md), [s16-voice-call/v1](../contracts/s16-voice-call-v1.md). Setup and recovery: [local voice runbook](../runbooks/s16-local-voice.md).

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
| Call receipt UTC | `2026-11-19T11:18:58.812Z` | `2026-11-19T11:19:55.938Z` |
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

The six voice suites comprise **48 tests / 304 assertions**, also included in the full command below on both platforms. Call cases cover separate journal crash boundaries before/after CHAT admission, no automatic replay after restart, byte-identical retry conflicts, accepted versus steering dispositions, credential-shaped input rejected before intent/hash persistence, same-call duplex quotas, source/owner withdrawal during synthesis, exact resume idempotency, preparing-call cancellation, expiry and all 32 original turn receipts after the hard ceiling. PCM tests cover the exact activity/onset/silence/idle bounds; existing actual subprocess tests retain crash/cancel/deadline/quota coverage.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 30000 tests/s16-voice-call.test.ts tests/s16-voice-service.test.ts tests/s16-voice-client.test.ts tests/s16-voice-local.test.ts tests/s16-voice-audio.test.ts tests/s16-voice-segmentation.test.ts tests/s16-steering.test.ts tests/s16-client.test.ts tests/s15-composition.test.ts tests/s15-runtime.test.ts tests/s15-runtime-bindings.test.ts tests/ops-service-package.test.ts tests/s16-upstream.test.ts
JIT_S16_BROWSER_TESTS=1 bun test tests/s16-voice-call.browser.test.ts tests/s16-voice.browser.test.ts tests/s16-approval.browser.test.ts tests/s16-steering.browser.test.ts
bun run upstream:check
git diff --check
```

The composed/runtime/package/provenance regression command passes **282 tests / 1,581 assertions** on both macOS and Linux ARM64. Frozen dependency installation and typecheck pass on both; Linux invokes the same compiler directly with `bun node_modules/typescript/lib/tsc.js --noEmit` because Node is not installed. Linux uses the existing dedicated non-root fixture account, with `umask 022`. Package source inventory distributes the new call/client code through its existing tree; additive call metadata uses the existing protected journal, with no scope/history migration. No S14 default, S15 opt-in, installed policy or owner configuration was changed.

The exact four-file browser command passes **26 tests / 242 assertions** on each platform: fifteen call cases, seven standalone voice cases, two exact in-chat approval cases and two running-work steering cases. Browser harness source is `c6d7706467425387967d75b2eef9208883323184`; commits after runtime source `2a0978d7` change only this test harness and documentation, with identical production code. Linux uses Chrome for Testing `156.0.8078.4`, executable SHA-256 `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65`, and Bun executable SHA-256 `616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1`, kernel `6.8.0-149-generic`. Actual speech runs under the controller fixture user with access to its previously supplied pinned artifacts; browser/package cases use the dedicated non-root fixture account. No live account or working-VM browser trust anchor is involved. Private receipts/logs, including the raw failed experiments, were copied before stopping the disposable controller VM.

## Failed experiments and limits

The first browser harness could not find a completed transcript because a wrapping accessible label included its mutable text value. An explicit `htmlFor`/`useId` association fixed the actual label. Successful native synthesis then exposed a final publisher hash that omitted the call binding; the publisher now validates the same immutable binding as admission, with a successful-publication/retained-listening regression. A repeated execute-mode scripted fixture correctly held its second request as `result_unavailable` when it supplied no fresh tool evidence. Multi-turn voice tests use an explicit answer fixture; a separate held-work test verifies honest attention instead of bypassing CHAT's evidence guard.

Final review reproduced a control-response publication gap: generation withdrawal after the asynchronous control completed could return its earlier call metadata. The HTTP publisher now reads the current guarded call view again in its serialization turn. The new actual HTTP/client regression rejects that boundary with `voice_stale`/403; the pre-fix test returned a successful response. Full browser, composed/package and native proofs above were repeated on the corrected runtime source.

An initial Linux package regression inherited the account's `umask 002`; its generated fixture directories were group-writable and the root-path policy correctly refused them. Running the unchanged suite with `umask 022` passed. The raw failure log remains private. The first six-suite Mac command used Bun's five-second default and timed out on the 32-turn integration case; the required `--timeout 30000` command passed with no assertion/bound weakened.

Thai copy/layout is tested; these English-only native models/voices do not prove Thai recognition or synthesis quality. Fake media and controlled track/visibility events do not establish real microphone permission/revocation, real mobile background audio or physical-device acceptance. Those and real account/owner-host cutover remain #431/#432. Parent #392 and complete S16-AC15/AC22 acceptance remain open for their remaining deliverables. No production deployment, billing, credential change, historical private-scope migration or owner-host activation follows from this proof.


## Review recovery and CI corrections

Review reproduced three client recovery defects in the actual browser: a delayed accepted Send response could erase a newer transcript after Mute/Resume; checking an ordinal absent from call metadata disabled its exact retry while still permitting an invalid Resume; and End's permanently aborted media lease also prevented read-only receipt recovery. Five new browser cases failed before the correction. The corrected client advances one mutation epoch for each owner control/recovery, ignores old successes/failures/finalizers and releases the superseded mutation's busy guard. The late-failure case also confirms a new turn while the original native fetch delivery remains pending, then preserves a later editable draft when that failure finally arrives.

Check original turn now retains an absent/unaccepted pending command and its exact retry while the original call is active. Resume cannot advance that unresolved binding; a known accepted receipt is freshly recovered before Resume. End keeps native media permanently off while read-only recovery remains available. The two lost-End cases cover response loss after accepted End and loss before admission, including an explicit End retry without another microphone or synthesis. All cases assert original identities and actual request/media counts; no old response can replace a later draft.

The initial ARM64 CI shard 3 failed only because the 32-turn integration case exceeded the unchanged thirty-second timeout; `service_closed` during cleanup was secondary. Repeated metadata checks had been rebuilding recent private result/action projections. CHAT now supplies the same bounded current-owner/recent-request-generation admission check without projecting content. Exact reply/source publication remains unchanged, and a new actual HTTP case rejects fresh speech admission against a prior owner generation before processing. The limit fixture supplies healthy scripted answers instead of accumulating execute requests without fresh evidence, and now verifies all 32 original owner texts and published results after End, rather than only the first receipt. The hard 32-turn limit and thirty-second timeout are unchanged.

The exact failed-shard command, `bun test --timeout 30000 $(bun ops/ci/test-shard.ts 3 6)`, passes **797 tests / 27 opt-in skips / 0 failures / 10,580 assertions across 54 files** on both macOS and Linux ARM64. Corrected-source full composed/package and actual native speech proofs above were repeated on each platform. The PR's fresh required checks must independently pass on its final head before merge.


The first corrected-source Linux browser run exposed a harness synchronization failure: Playwright's `Response.finished()` and later CDP `requestfinished` did not settle reliably while the accepted original response was held. Teardown was also closing the context before releasing held server requests. The final harness releases barriers before context close and gates the native browser fetch delivery promise after its actual authenticated HTTP 202 and complete body have arrived. It returns that same untouched response, or injects the controlled late loss; no service/client result, cookie, header, PCM or UI state is fabricated. This directly exercises the late continuation without relying on CDP lifecycle events. Applying the same final harness to the pre-fix runtime `a929e2a8` reproduced the erased draft, so the correction does not hide the original bug. Full final browser suites above pass on both platforms without increasing timeouts or reducing assertions.

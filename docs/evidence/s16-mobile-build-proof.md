# MOBILE16-01 native build and owning-fixture evidence

Date: 2026-11-20. Runtime/tooling source: `ed9904f6ae5fd579fe7135dc0bf58458682d5517`, clean at both builds. Scope: #426, S16-AC17; FR-10/11/18/24/25/28/35/37/38; NFR-05/07/09/11/13. [ADR 0100](../adr/0100-s16-packaged-native-mobile-client.md), [s16-mobile/v1](../contracts/s16-mobile-v1.md), [build runbook](../../clients/mobile/README.md), [separate native/device checklist](../operations/s16-mobile-acceptance.md).

**This is build/fixture evidence, not completed #426 acceptance.** Packaged native UI workflows remain pending because the environment's Agent device access is disabled. Its requested enablement is separate from these local builds. Do not merge/close #426 on this record alone. Physical devices, real APNs/FCM, signing/account setup and owner-host cutover remain #431/#432; no live credential, account, private recording, payment, production deployment or owner-host activation was used.

## Immutable local distributions

Both were built by the actual local `ops/mobile/main.ts` builder from clean source, frozen root/client installations, CNG regeneration and reviewed native input pins. Both complete seals were reverified without installing or executing their payloads. Full native logs/selections and installation-specific paths remain in ignored local records. Source is retained in Git; native binaries remain local build artifacts.

Each build extracted and verified the same immutable Git archive into a separate fresh private source tree: SHA-256 `fc210382a762ab21adfcd4f5af358e0c73c45f82d45b55dce999c740a3843ef8`, 1,639 files / 44,286,692 bytes. Every extracted file's Git blob identity, size and mode matched the selected commit before frozen installation and `expo prebuild --clean`. Existing ignored native projects were excluded and preserved. Each distribution includes sealed `build-source.json` provenance under `s16-mobile-build-source/v1`.

| Payload | Build facts | SHA-256 / seal |
| --- | --- | --- |
| Android Release arm64, unsigned APK | 26,322,901 bytes; 23 files in the complete distribution; minimum API 24, target 36, compile 37 | APK `a81c39f45a4a3e8d8dd3a698346c7dae88250e3cd5cc47c902738c06f9b9ceb7`; seal `1b95b60d20ac977704791adad0834ae265d51e67dc6bd82a134a70fdf667ef0a` |
| iOS Release arm64 simulator distribution | 216 files; deployment target 16.4; Xcode's normal simulator entitlement pipeline; `codesign --verify --deep --strict` passed | Seal `b3bc716fd7ba909f3177226f4c8dd2a5d00cb3929d6b8c366dc0b77dc15aab8f` |
| iOS app executable | 2,988,864 bytes | `032f1de19f84de4e8544a5ebd11b672b17ca9739238762c4d76a6a39ccabca3a` |
| iOS bundled Hermes JS | 6,164,912 bytes, including the actual original notice inventory | `fb31c2a4846eaed7301f4b905de9c491daacf84b82db22bfaf54538d65a95702` |

The manifest labels each distribution `acceptance: build-only`. Node 24.22.3 executable hash is `ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854`; Bun is 1.4.2. iOS used Xcode 27.2 build 27B52, simulator SDK 27.2 and CocoaPods 1.16.2. Android used Temurin 21.0.13.1+2, build tools 37.0.0 and NDK 27.1.12297006; the manifest also hashes the Java launcher, SDK package and NDK properties. Root/client locks, CocoaPods lock, Apple/Android inputs, Gradle verification and notice index hashes are in each complete manifest.

Strict Gradle verification initially refused the unpinned AAPT2 resource compiler/POM. Only those exact Google Maven artifacts were checked against their published first-party checksums and added as SHA-256 pins; verification was not relaxed. The final Android build passed strict verification and exact runtime inventory comparison. The final iOS build passed deployment-mode CocoaPods selection and exact downloaded framework input comparison. Earlier source generations are retained separately and are not substituted for this source.

Search delivery #472 is included in this runtime. The combined owning composition retains both Search and native notification routes/capabilities; native-file recovery, Work polling and retirement guards remain intact. The native locale snapshot was regenerated from the merged English/Thai dictionaries before final config evaluation and both clean builds. The stale-snapshot guard remains enforced.

## What was executed

| Area | Actual evidence and boundary |
| --- | --- |
| Protected service/session and mutations | Real composed service/shared client tests cover actual S14 password/session ingress, full-origin custody, redirect/body lifetime limits, stale generations/targets, immutable Send/decision identities, original receipt recovery, file hashes, changed exact approvals and one controlled effect. Native keystore/network ports are controlled fixtures; this is not a packaged renderer test. |
| Unknown upload creation | The owning service reads the original create receipt by request identity and exact current owner/conversation/generation. Mobile checks are read-only even without an upload ID. An explicitly selected same-name/size/hash file may resume only a confirmed empty original upload; lost byte replies do not recreate or replay. Older services without creation lookup receive no unsupported request. No file bytes or picker URI are retained for recovery. |
| Work polling and replacement | The owning mobile session composes 64 delayed snapshot reads across repeated real bootstrap polls without starvation, filters removed conversations, and aborts a dismissed batch without invalidating a healthy session. Authentication failures still fence. Replaced service handles are permanently retired, so late OS picker callbacks cannot restore them or write bytes; current-session OS sheets retain reversible background handling. |
| Fresh native source | Actual Git/filesystem regressions reject dirty/reused destinations, symlinks, archive-attribute omissions and mode changes; ignored edited native projects remain untouched and excluded. Both release builds used the verified fresh snapshot and frozen local Expo template. |
| Native notification service | Actual owning routes, journal and producer tests exercise opt-in inventory, Host/session/Origin/CSRF, reset during streaming, generic held-work notices, token-hash recovery, bounded retry/expiry, real child SIGKILL recovery, cursor atomicity and preserving installed policy/journal adoption after manifest rollback. ES256/RS256 and HTTP/2 provider protocol fixtures do not establish physical delivery. |
| Subscription controller | Explicit OS permission/token adapters, unavailable native setup before permission, denied/provisional/rotation, persist-before-POST, unknown reply and restart lookup, original-token removal and A → B → A barriers. No automatic registration/replay or VM work. SDK configuration failure is unavailable; an uncertain subscription stays uncertain. |
| Finite voice | Native Swift/Kotlin capture code compiled in both actual releases. Owning VOICE16/controller fixtures cover permission denial, finite canonical PCM, background/cancel/late-lease fences, editable draft only and original-ID recovery without recreating lost audio/transcript. Physical capture/Thai quality was not tested. |
| Actual Darwin exclusive export writer | Opt-in fixture compiles and invokes the same authored POSIX writer: an existing file/symlink stays unchanged; concurrent writers produce exactly one new winning file; invalid names and a linked directory refuse. This is a Darwin filesystem fixture, not an iOS picker run. |
| Actual Expo public configuration | Pinned Node/Expo config evaluation with a synthetic public Android client file confirms its validated snapshot is present only for explicit prebuild, absent from runtime public config, and no build-machine path appears there. Provider/service-account/private-key input, source-file substitution and symlink cases refuse. No real Google setup occurred. |
| Actual APK inspection | `apkanalyzer`/AAPT2 inspect the compiled binary manifest and its resolved, optimized network resource. Backup and default cleartext are false; FCM auto-init/default collection are false; analytics is deactivated; ad-ID/screen collection are false. Advertising, overlay and broad external-storage permissions are absent. The network resource permits cleartext only for literal `127.0.0.1`/`::1`, without subdomains. Release signing is not replaced with the template's public debug key. |
| Merged-source real browser regression | The actual protected S16 React bundle passes Search and exact approval in English at width 1440 and Thai at width 390: current source navigation/labels/recovery, complete exact card, keyboard approval, one decision/effect, no external requests or page errors. This is browser regression evidence, not native UI evidence. |
| Licenses/input provenance | Shipped 239 component records/47 original unique texts, corresponding MPL public-suffix source, immutable native license references, 178 Maven components/162 artifacts and seven downloaded iOS XCFrameworks/1,193 files. SDK/LLVM notices and Android SDK terms are retained; the distribution is not MIT-only. No new Rakazo app/runtime source is imported. |

## Commands and results

Both root and client `bun install --frozen-lockfile`, root/native `bun run typecheck`, upstream provenance verification (two files / six licenses) and `git diff --check` passed. The following affected suite passed **154 tests, zero failures, no skips, 3,622 assertions across 23 files** with native fixture opt-in and an explicitly selected verified Node binary:

```sh
JIT_MOBILE_NATIVE_TESTS=1 JIT_MOBILE_NODE=<verified-node-24.22.3> \
bun test --timeout 60000 \
  tests/s16-mobile-*.test.ts tests/s16-native-notifications*.test.ts \
  tests/s16-native-push-providers.test.ts tests/s16-file-store.test.ts \
  tests/s16-files-composed.test.ts tests/s16-client.test.ts \
  tests/s15-web-i18n.test.ts tests/s16-search.test.ts

JIT_S16_BROWSER_TESTS=1 bun test --timeout 30000 tests/s16-search.browser.test.ts tests/s16-approval.browser.test.ts
bun ops/mobile/main.ts build <ignored-versioned-build-selection>
bun ops/mobile/main.ts verify <complete-local-distribution>
```

The merged-source browser regression passed four tests/62 assertions. The native builder invoked actual Release Xcode/Gradle compilation, not Metro-only previews. Public commands intentionally omit machine/device/account addresses and credential locations. GitHub required checks/latest-head primary review and the pending packaged native UI checklist remain merge gates; this record does not certify either.

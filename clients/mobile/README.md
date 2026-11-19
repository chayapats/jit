# Jit native mobile client

This is the authored React Native client of the existing protected Jit service, governed by [ADR 0100](../../docs/adr/0100-s16-packaged-native-mobile-client.md) and [s16-mobile/v1](../../docs/contracts/s16-mobile-v1.md). It shares `JitClient` and owning CHAT/POLICY/FILE/VOICE contracts. It contains no Bot runtime, host enrollment, service credential, automatic work queue, Expo Push relay, EAS account or remote JS updater.

The selected release lane builds arm64 on macOS arm64: iOS 16.4+ simulator and Android API 24+ (compile 37, target 36). Physical devices, signing, live APNs/FCM and owner-host cutover have separate acceptance. Builds alone are not native UI or device evidence.

## Build a new local artifact

Use Bun 1.4.2, Node 24.22.3 and the frozen root/client locks. iOS needs the recorded Xcode/SDK and CocoaPods. Android needs JDK 21, Android SDK platform 37, build tools 37.0.0, NDK 27.1.12297006 and CMake 3.22.1. Installation-specific paths belong in ignored `.local` selections. Do not replace a global Node/JDK/SDK for this project.

1. Run the relevant root tests and `bun run typecheck`; commit the implementation. The builder refuses dirty source.
2. Create a new artifact selection in `.local`. Its output parent must exist; the output itself must not exist. Example shape, replacing the tool/output paths locally:

```json
{
  "contract": "s16-mobile-build/v1",
  "platform": "ios-simulator",
  "output": "/absolute/new-output",
  "node": "/absolute/node-24.22.3/bin/node"
}
```

For Android, use `platform: "android"` and add exactly:

```json
{
  "android": {
    "javaHome": "/absolute/jdk-21/Contents/Home",
    "sdk": "/absolute/android-sdk",
    "gradleHome": "/absolute/private-gradle-cache"
  }
}
```

3. From the repository root run `bun ops/mobile/main.ts build .local/mobile-build.json`. Logs stay in `.local/mobile-builds/`. The builder uses frozen installations, locale generation, CNG, deployment-mode CocoaPods or strict Gradle verification, and compares actual Android runtime artifacts/POMs with `native-inputs/android.json`.
4. Run `bun ops/mobile/main.ts verify /absolute/new-output` and retain its manifest ID, source commit, lock/toolchain hashes and payload hashes in the run receipt. Keep the preceding compatible artifact. This integrity seal is not a publisher signature.

CNG regenerates its ignored native directories. The reviewed `native-inputs/Podfile.lock` and Gradle verification metadata are restored by the authored plugin; generated native source changes have prominent Jit modification notices. Use Xcode's normal simulator signing/entitlement pipeline. Do not manually add restricted entitlements with ad hoc `codesign`. Android release artifacts are unsigned; the template's public debug key never signs a release. No CLI command installs, signs, publishes or deploys anything.

## Public build configuration

`JIT_MOBILE_APPLICATION_ID` selects a reverse-DNS application ID (default `io.jit.mobile`), and `JIT_MOBILE_BUILD_NUMBER` selects a positive build number (default `1`). Keep the same application ID and protected signing identity when updating an installed app. An OS may require a newer build number or refuse a downgrade; do not uninstall or clear data as a silent rollback workaround.

Android's optional `JIT_MOBILE_GOOGLE_SERVICES` is an absolute path to the **public Android client** `google-services.json` for the selected application ID. It is validated, bounded and snapshotted under ignored `.local/public-build/` before CNG copies it. Provider/service-account JSON, private keys, secrets and tokens are refused. No real Google configuration is bundled by default. This client configuration is distinct from the protected service's FCM signing file. APNs credentials never enter a native build. Actual account/signing setup remains a separately authorized #431 step.

Firebase messaging auto-init and data collection are disabled before startup; analytics is permanently deactivated and advertising permissions are removed. Explicit Enable/current-token verification uses the platform token API without enabling auto-init. The service's capability and actual OS permission/subscription remain authoritative. Missing configuration is an unavailable state, not a successful delivery claim. See [Firebase initialization control](https://firebase.google.com/docs/cloud-messaging/android/get-started) and [Analytics collection control](https://firebase.google.com/docs/analytics/android/configure-data-collection).

Enter the existing Jit service address and password in the app. HTTPS and normal TLS validation are required remotely; literal loopback HTTP is for disposable fixtures. The full origin, including port, binds SecureStore session/subscription records. Service/session/target changes and native lifecycle epochs fence private projections. Notifications/deep links select registered targets and reauthenticate; they never approve or start work.

## Input provenance and notices

`bun.lock`, `native-inputs/Podfile.lock`, exact Maven artifact/POM hashes and Gradle verification metadata pin reviewed inputs. `notices/index.json` contains original notices embedded in More; long texts are paged without changing their contents. `notices/provenance.json` records frozen npm integrity and immutable license references. `native-inputs/notices.json` retains native sources/licenses, Android SDK terms and LLVM runtime exceptions. Some dependencies are Apache/BSD/MPL or governed by Android SDK terms; this is not an MIT-only distribution. Toolchain notices are retained as supplemental context, separately from the exact shipping component inventory.

`native-inputs/public-suffix-list.txt` is the corresponding MPL-2.0 rule source reconstructed from the exact OkHttp 4.12.0 compressed data, with its prominent modification notice and compressed/artifact/source hashes. License-reference-only snapshots are labelled as such; they do not claim a different artifact source version. The root Jit LICENSE/NOTICE and retained Apache-2.0 Rakazo provenance ship beside the native payload. No new Rakazo app/runtime source was imported.

To review a dependency update, regenerate both release source maps, actual native dependency resolution and notices; inspect changed sources/licenses, then update the input pins in a dedicated commit. The offline `tools/licenses.ts` accepts exactly the iOS and Android Hermes source-map paths. `tools/native-inventory.gradle` inventories actual release resolution, including inherited POM licenses and shipped notices; it neither signs nor deploys. Do not use `--write-verification-metadata` in the sealed release lane to accept unreviewed inputs.

## Acceptance and rollback

Use the [native acceptance checklist](../../docs/operations/s16-mobile-acceptance.md) against an immutable artifact. Record actual English/Thai UI, keyboard/safe-area/accessibility, owning file/result/approval paths and lifecycle barriers. Keep simulator, controlled protocol/OS-adapter fixtures and physical evidence labelled separately. Installation grants no host enrollment or additional execution authority.

Rollback selects a preceding compatible signed client under the OS's installation rules; it does not roll back protected service journals, installed policy, owner generation, revocations or decisions. Reconnect performs fresh protected reads. A new native store is additive opt-in inventory; disabling its selection leaves existing facts dormant rather than deleting or converting them. Never restore old client caches or clear real device data to manufacture acceptance.

# Install and recover the existing-service desktop client

Owner: DESKTOP16-01 (#425). [ADR 0099](../adr/0099-s16-installed-desktop-client.md) and [s16-desktop/v1](../contracts/s16-desktop-v1.md) define the boundary. This is a client of an already configured protected Jit service. It does not install a service, change runtime selection, migrate history, enroll a computer or deploy to an owner host.

## Inputs and platform evidence

Use Bun **1.4.2**, the frozen **playwright-core 1.64.1** dependency and an existing vendor Chrome executable. Build from the recorded source revision and retain the emitted manifest, source/lock hash and applicable LICENSE/NOTICE/third_party files. Chrome and Bun are not redistributed. No Electron runtime, updater, native messaging host or new provider protocol is installed.

| Platform | Current delivery and evidence |
| --- | --- |
| macOS | Authored local `Jit.app` entry plus actual vendor Chrome standalone/profile conformance. The complete browser signature must validate as Google Chrome, Apple-anchored, team `EQHXZ8M8AV`. Physical Finder/Gatekeeper, OS keychain and device/account acceptance remain explicit #431 checks. |
| Linux | Authored `Jit.desktop` entry, deterministic path/argument escaping and sealed package checks. Actual desktop/keyring/runtime acceptance remains pending #431; a basic secret-store fallback is not strong encryption. |
| Windows | Native launcher currently refuses with `desktop_platform_unsupported`; no Windows delivery is claimed. |

The launcher retains Chrome's platform credential store, sandbox, native audio and background networking. It removes Playwright's testing shortcuts, uses only a private debugging pipe and verifies that no debug TCP port or `--no-sandbox` is present. It neither imports the person's everyday Chrome profile nor copies Jit sessions into the working VM. A signature failure refuses launch; repair/reinstall through the browser vendor, never disable the check or alter the person's application to make a receipt pass. Headless conformance is not physical OS/device acceptance.

## Build, verify and install

Run from the Jit checkout. Choose a fresh artifact directory and an owner-only installation root with an existing private parent. Paths below are examples, not installation-specific defaults.

```sh
bun install --frozen-lockfile
mkdir -p .local/desktop
artifact="$PWD/.local/desktop/native-001"
install_root="/absolute/private/path/jit-desktop"
bun run ops:desktop build --source "$PWD" --output "$artifact"
bun run ops:desktop verify --artifact "$artifact"
bun run ops:desktop install --artifact "$artifact" --root "$install_root" \
  --bun /absolute/canonical/path/to/bun \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --locale th
bun run ops:desktop status --root "$install_root"
```

Install emits `Jit.app` on macOS or `Jit.desktop` on Linux inside that root. Open that authored entry. Its fixed arguments load only the verified private bootstrap/current package. An optional `--service https://jit.example.test` can select the canonical existing service during installation. Otherwise the credential-free connection window asks for that service, then closes before the authenticated profile opens. Remote services require HTTPS; HTTP development accepts literal loopback only. Credentials, query strings, arbitrary schemes, browser flags and generic commands are not connection inputs.

Sign in through the service's own protected login. The app uses that service for Bots, work, files, artifacts, exact approval cards, computers and current permission/connection state. Installation itself grants no permission or execution authority. The browser's file picker exposes only selected files; downloads use the browser's ordinary user-visible destination. Microphone and notification controls request their respective browser/OS permissions explicitly. Restore a denied permission in browser/OS settings, then reconnect/refresh the app. No shell fallback is offered.

OAuth opens only from a receipt captured from the actual owning connection command and a fresh authorized source/revision check. The separate disposable provider browser has no Jit session or native binding. The person performs login/2FA manually. The controller consumes the exact one-use callback without redirects, disconnects that browser and reloads the original authenticated Connections page for the service's PKCE completion/tool review. A provider window opening does not mean signed in, connected or approved. Fixed GitHub token help also opens separately, only from a real user activation.

## Update and recover

There are two separate delivery lifecycles:

* **Public client bytes:** The service supplies an immutable hash inventory. The worker validates every exact public member before its completion marker. A corrupt/truncated/interrupted update leaves the current complete package usable and is reported honestly. A complete waiting update activates after all app windows close. Reopen the app; no work or approval is replayed. Only public assets and neutral shells enter this cache. Private APIs, files, results, downloads, screenshots and effect requests never do. Storage eviction may require a network connection to rebuild it.
* **Native launcher bytes:** Build a fresh sealed artifact, verify it and update explicitly. The installer copies and fsyncs a complete stage, revalidates/renames it, then atomically replaces the current pointer. An interruption retains the previous pointer/profile. Rollback swaps verified launcher releases only; it cannot roll back service journals, policy, withdrawals, budgets or actions.

```sh
bun run ops:desktop verify --artifact /absolute/path/to/new-artifact
bun run ops:desktop update --artifact /absolute/path/to/new-artifact --root "$install_root"
bun run ops:desktop status --root "$install_root"
bun run ops:desktop rollback --root "$install_root"
```

There is no remote unattended native update feed. Ordinary updates must retain the v1 bootstrap digest/runtime/service selection. A changed bootstrap requires a separately reviewed migration; runtime/service mismatches refuse. At most eight sealed native releases are retained before explicit maintenance. Do not remove profiles, service records or the last valid release to bypass an error. Package hash verification detects corruption against the selected manifest; obtain that manifest/artifact through the trusted source/review channel, not an arbitrary download link. It is not a publisher signature.

Only one native launcher may own a profile. A live/stale-but-reused PID refuses; the installer never kills a foreign process. Close the existing app before reopening. An invalid profile/record, missing runtime, signature mismatch, corrupt release or unavailable browser is a visible failure. Fix the exact input or restore a verified preceding artifact; never import another browser profile or weaken origin/session checks.

Offline/disconnect hides private projections that cannot be revalidated. Reconnect reads the current service/owner facts. An uncertain send retains only its request identity and recovers its existing durable receipt; there is no offline effect queue. Signing in again does not silently resend a command.

## Verification and receipts

Run deterministic desktop package/worker/storage/lease/install/distribution/owner-link suites plus affected client, notification, local API and authority regressions. For rendered/installed proof, set `JIT_S16_DESKTOP_TESTS=1`, `JIT_BROWSER_EXECUTABLE` to the explicit verified browser and `JIT_S16_DESKTOP_ARTIFACT` to the absolute sealed package path, then run:

```sh
bun test --timeout 30000 tests/s16-desktop.browser.test.ts \
  tests/s16-desktop-oauth.browser.test.ts \
  tests/s16-desktop-workflow.browser.test.ts \
  tests/s16-desktop-lifecycle.browser.test.ts
```

These opt-in suites use real Chrome, the installed compiled native package, actual protected HTTP/client/worker paths and controlled model/provider/VM fixtures. They check exact downloaded bytes, single-use OAuth/PKCE, single admission recovery, one exact approved fixture effect, no install-induced host calls, permission denial and closed-window update activation. Record source/native/public package IDs, OS/browser/Bun/lock revisions, commands/counts and remaining physical/live inputs. Do not export profiles, cookies, OAuth codes/state, private payloads or installation-specific addresses. #431 owns live account/device/push acceptance; #432 owns service/owner-host activation.

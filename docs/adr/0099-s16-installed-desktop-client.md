---
status: implemented with deterministic and installed-package fixture evidence; physical/live acceptance tracked separately
date: 2026-11-19
scope: DESKTOP16-01; S16-AC16; FR-04/10/18/23/24/32/35/38/40; NFR-05/07/08/11/12/13/14
---

# Install the shared protected client as a desktop app

## Decision

Deliver a narrowly controlled Chrome desktop window from the owner's existing S15/S16 service, launched by authored Bun/TypeScript through the existing Playwright public API. Use an isolated exact-service profile, the existing Bun-built React client, native file picker/downloads, browser microphone permission and RFC Web Push. Add a versioned public client package, integrity-checked atomic service-worker installation, recoverable updates, install/recovery controls and actual installed-window conformance evidence. A manifest or a launcher without that lifecycle and evidence is insufficient.

This is a desktop client, never an execution host. Installation creates no computer, shell listener, native messaging host, custom protocol, privileged IPC, preload bridge, local API token or new backend. Authentication and every action continue through the same protected service. Installing on another origin creates another browser app/session rather than transferring credentials. S14 defaults, S15 selection, installed policy, private history and owner-host acceptance do not change.

The [v1 contract](../contracts/s16-desktop-v1.md) is selected before implementation. It retains S16-D10 and [ADR 0085](0085-remove-telegram-web-push-notifications.md). No native notification transport replaces Web Push.

## Alternatives and material costs

| Choice | Benefits | Costs and decision |
| --- | --- | --- |
| Installed shared Web app alone | Original receipts and Web Push; OS app window and launcher; browser-owned security updates and permission UI | Actual controlled reproduction forwarded a test HttpOnly SameSite=Strict cookie to the same hostname on another port. Browser app scope alone does not prevent that navigation. Insufficient for this ticket's malicious-navigation guarantee. |
| Bun-controlled existing Chrome app | Standard Web Push plus browser-owned native permissions; isolated per-service profile; public Playwright/CDP pipe with an exact-service network boundary; existing dependency pin | Requires the selected Chrome runtime and a small protected launcher lifecycle. No browser binary redistribution. Selected after the browser-only counterexample. |
| Narrow Electron wrapper | Controlled window chrome and independently packaged executable; familiar upstream desktop concepts | Electron 45.4.1 alone adds roughly 121–125 MB per inspected platform before client assets, platform signing/updater custody and a privileged main process. Its documented pushNotifications API is APNS-specific; standard Web Push support remains an open upstream issue. A separate push receiver or companion browser would add another device/session and notification integration. Not selected. |
| Import Rakazo desktop wholesale | Existing packaging implementation | Imports Electron updater, native FFI, logging/telemetry and dependencies tied to a competing core/runtime. Would require a replacement authority/state contract. Not selected. |

Read-only upstream comparison used Rakazo commit `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`: `apps/desktop/src/window-options.ts` SHA-256 `721f78eae6e50040b01da4f4bd409689659c1f8af43229b7e7e4ad1a50b78c6d` and desktop `package.json` SHA-256 `081a7c03eab52ef1055a85a8e30704a114b30faf7d6c45cb793c3911aa43e881`. Its window/packaging concepts informed the comparison; no new upstream source, binary, branding or dependencies are imported. Existing adapted client files retain their Apache-2.0 notices and immutable inventory. Existing browser bundle/package license checks still apply.

Primary sources checked on 2026-11-19: [desktop PWA installation](https://web.dev/learn/pwa/installation), [installed navigation management](https://developer.chrome.com/docs/capabilities/pwa-navigation-management), [Electron notification API](https://www.electronjs.org/docs/latest/api/push-notifications), [upstream Web Push issue](https://github.com/electron/electron/issues/6697), [Electron release](https://github.com/electron/electron/releases/tag/v45.4.1). Installation on Chrome/Edge desktop is documented for macOS, Windows and Linux; that support statement is separate from this project's exact tested OS/browser receipts.

## Navigation counterexample and revised selection

Before declaring the prototype complete, an actual temporary Chrome profile navigated from one controlled loopback service to a second controlled port on the same hostname. The destination received the fixture cookie; no real credential was used or printed. This matches [RFC 6265 section 8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5): cookies do not isolate ports. The initial browser-only selection is therefore superseded before release.

The launcher owns a dedicated profile identified by the canonical complete service origin and communicates with Chrome through Playwright's private debugging pipe, never an open debugging port. It does not import an owner default profile. Before navigation it installs exact-origin request/redirect and websocket guards covering new windows too. Outbound redirects are examined without following them; no automatic retry or private response logging. Local file/protocol/deep-link inputs cannot invoke an executable, choose another origin or transfer a session. Connection selection occurs in a separate credential-free local window, which is destroyed before the authenticated service profile is opened; its narrowly validated connection callback is never installed in service windows.

Supported native packaging starts with macOS/Linux and the exact installed Bun/Chrome inputs recorded in receipts. Browser distribution/signing stays with its vendor; a Chrome-for-Testing binary is not redistributed as a consumer runtime. Windows/Edge and physical-device/live-push acceptance require their own evidence. This matrix is distinct from ordinary Web/PWA compatibility.

## Lifecycle and authority

Only explicitly inventoried, content-addressed public code, styles, icons, licenses and neutral shell documents may enter the client cache. No authenticated response, conversation, CSRF value, credential, file, artifact, approval or original receipt is cached. All API/effect traffic remains network-only, exact-origin and subject to current service guards. An offline shell conveys inability to connect and cannot replay work.

A new worker installs a complete bounded package before it becomes eligible to activate. Missing, redirected, truncated or hash-mismatched assets reject installation and leave the existing active package intact. Existing windows retain their active package. A waiting update activates after those windows close; there is no forced reload that discards an unsent draft or replays an uncertain send. Retain the preceding complete public package for recovery; never roll back service authority or private state with client code. An operator may restore a compatible prior service/client release through the existing reviewed package procedure. This is client-code recovery, not permission for an owner-host cutover or a database rollback.

The notification worker gains this narrowly bounded public-asset lifecycle. Its existing push payload, subscription, permission, authenticated-click and deduplication contracts remain intact. The previous claim that this worker has no fetch handler is superseded only for the public package and validated S16 navigation shell; private responses remain excluded.

## Preserve owner OAuth without sharing the client session

Integration found that `ConnectionsView` navigates to the exact authorization URL returned by the protected connection command. The native service-origin boundary correctly refuses that URL; permitting arbitrary external navigation in the authenticated profile would reintroduce the demonstrated cookie leak. Select a single bounded `jitDesktopOwnerLink` callback instead. The native proxy captures only a successful actual `s16-connection-receipt/v1` for the same main-frame `source.add`/`source.oauth_begin`/OAuth `source.reconnect` request, with matching request identity, authorizing OAuth source/revision, exact authorization URL, state and this installation's redirect URI. Model text, page messages and arbitrary links create no capability.

The callback consumes that page-bound, finite, one-use capability after a fresh current-owner/source read. It opens a separate disposable signed/sandboxed browser with no Jit cookies, imported profile or host binding. The person performs provider sign-in there; no model reads or operates the login page. Only an observed response from the actual Jit single-use OAuth callback, with matching state and exact source return, resumes the original authenticated client. The ordinary protected service still owns PKCE, generation checks, token exchange and tool review. Opening a browser reports only `opened`, never connected or approved.

The only receipt-free link is the authored fixed GitHub token-help URL, from the Connections main frame under a real current browser user activation. That check uses CDP with `userGesture:false`; a Playwright evaluation must not manufacture activation. It too opens an empty separate browser, never the Jit profile. There is no open-anything, shell, file, eval or approval callback. A provider browser is a manual owner handoff with normal provider redirects, not a Bot-controlled execution browser. It receives no Jit session; non-callback Jit requests are refused/closed and all protected service operations retain authentication/CSRF. Real credentials/device acceptance remain #431.

The [handoff contract](../contracts/s16-desktop-v1.md#bounded-owner-link-handoff) supersedes the initial engineering proposal of zero service-window bindings, while retaining no generic native bridge and exact-service isolation.

## Required proof

Deterministic package/worker tests cover incomplete install, corruption, redirects, stale packages, activation/recovery and strict cache exclusions. Actual installed Chromium windows use the real bundled client and owning protected service for file-to-result, original receipt/reconnect, exact approval, Bots and computer views. Adversarial origins/navigation and deep links cannot obtain a session or invoke native execution. Browser permissions are requested only by their actual owner controls; install requests none. Local API Host/Origin/token rejection and inspect-versus-execute regressions remain required.

macOS/Linux/Windows support claims are bounded by actual receipts; missing physical-device, signed-browser, live Web Push/account and owner-host proof remain honestly tracked under #431/#432. No deterministic fixture is described as live acceptance, and parent #392 remains open.

Implementation and immutable build/acceptance receipts: [DESKTOP16-01 proof](../evidence/s16-desktop-proof.md). Physical/live/cutover inputs remain explicitly separate.

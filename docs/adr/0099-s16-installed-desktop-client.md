---
status: selected for DESKTOP16-01 implementation; acceptance evidence pending
date: 2026-11-19
scope: DESKTOP16-01; S16-AC16; FR-04/10/18/23/24/32/35/38/40; NFR-05/07/08/11/12/13/14
---

# Install the shared protected client as a desktop app

## Decision

Deliver a standalone installed Web app from the owner's existing S15/S16 service. Use the existing Bun-built React client, browser origin/session isolation, native file picker/downloads, browser microphone permission and RFC Web Push. Add a versioned public client package, integrity-checked atomic service-worker installation, recoverable updates, install/recovery controls and actual installed-window conformance evidence. A manifest or a launcher without that lifecycle and evidence is insufficient.

This is a desktop client, never an execution host. Installation creates no computer, shell listener, native messaging host, custom protocol, privileged IPC, preload bridge, local API token or new backend. Authentication and every action continue through the same protected service. Installing on another origin creates another browser app/session rather than transferring credentials. S14 defaults, S15 selection, installed policy, private history and owner-host acceptance do not change.

The [v1 contract](../contracts/s16-desktop-v1.md) is selected before implementation. It retains S16-D10 and [ADR 0085](0085-remove-telegram-web-push-notifications.md). No native notification transport replaces Web Push.

## Alternatives and material costs

| Choice | Benefits | Costs and decision |
| --- | --- | --- |
| Installed shared Web app | Existing owner session, original receipts and Web Push; OS app window and launcher; browser-owned security updates and permission UI; no native dependency or second authority | Requires a supported installed browser and HTTPS for remote services. Browser controls installation, permission presentation and app integration. Selected, with an actual versioned package/update lifecycle rather than a shortcut. |
| Narrow Electron wrapper | Controlled window chrome and independently packaged executable; familiar upstream desktop concepts | Electron 45.4.1 alone adds roughly 121–125 MB per inspected platform before client assets, platform signing/updater custody and a privileged main process. Its documented pushNotifications API is APNS-specific; standard Web Push support remains an open upstream issue. A separate push receiver or companion browser would add another device/session and notification integration. Not selected. |
| Import Rakazo desktop wholesale | Existing packaging implementation | Imports Electron updater, native FFI, logging/telemetry and dependencies tied to a competing core/runtime. Would require a replacement authority/state contract. Not selected. |

Read-only upstream comparison used Rakazo commit `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`: `apps/desktop/src/window-options.ts` SHA-256 `721f78eae6e50040b01da4f4bd409689659c1f8af43229b7e7e4ad1a50b78c6d` and desktop `package.json` SHA-256 `081a7c03eab52ef1055a85a8e30704a114b30faf7d6c45cb793c3911aa43e881`. Its window/packaging concepts informed the comparison; no new upstream source, binary, branding or dependencies are imported. Existing adapted client files retain their Apache-2.0 notices and immutable inventory. Existing browser bundle/package license checks still apply.

Primary sources checked on 2026-11-19: [desktop PWA installation](https://web.dev/learn/pwa/installation), [installed navigation management](https://developer.chrome.com/docs/capabilities/pwa-navigation-management), [Electron notification API](https://www.electronjs.org/docs/latest/api/push-notifications), [upstream Web Push issue](https://github.com/electron/electron/issues/6697), [Electron release](https://github.com/electron/electron/releases/tag/v45.4.1). Installation on Chrome/Edge desktop is documented for macOS, Windows and Linux; that support statement is separate from this project's exact tested OS/browser receipts.

## Lifecycle and authority

Only explicitly inventoried, content-addressed public code, styles, icons, licenses and neutral shell documents may enter the client cache. No authenticated response, conversation, CSRF value, credential, file, artifact, approval or original receipt is cached. All API/effect traffic remains network-only, exact-origin and subject to current service guards. An offline shell conveys inability to connect and cannot replay work.

A new worker installs a complete bounded package before it becomes eligible to activate. Missing, redirected, truncated or hash-mismatched assets reject installation and leave the existing active package intact. Existing windows retain their active package. A waiting update activates after those windows close; there is no forced reload that discards an unsent draft or replays an uncertain send. Retain the preceding complete public package for recovery; never roll back service authority or private state with client code. An operator may restore a compatible prior service/client release through the existing reviewed package procedure. This is client-code recovery, not permission for an owner-host cutover or a database rollback.

The notification worker gains this narrowly bounded public-asset lifecycle. Its existing push payload, subscription, permission, authenticated-click and deduplication contracts remain intact. The previous claim that this worker has no fetch handler is superseded only for the public package and validated S16 navigation shell; private responses remain excluded.

## Required proof

Deterministic package/worker tests cover incomplete install, corruption, redirects, stale packages, activation/recovery and strict cache exclusions. Actual installed Chromium windows use the real bundled client and owning protected service for file-to-result, original receipt/reconnect, exact approval, Bots and computer views. Adversarial origins/navigation and deep links cannot obtain a session or invoke native execution. Browser permissions are requested only by their actual owner controls; install requests none. Local API Host/Origin/token rejection and inspect-versus-execute regressions remain required.

macOS/Linux/Windows support claims are bounded by actual receipts; missing physical-device, signed-browser, live Web Push/account and owner-host proof remain honestly tracked under #431/#432. No deterministic fixture is described as live acceptance, and parent #392 remains open.

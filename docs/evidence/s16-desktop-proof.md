# DESKTOP16-01 existing-service installed desktop proof

Date: 2026-11-19. Runtime source: `3deb106cf43e9b2e631f5ac04a8a1982c827b7d1`, clean native build including the four PR #470 review fixes. Scope: #425; S16-AC16; FR-04/10/18/23/24/32/35/38/40; NFR-05/07/08/11/12/13/14. Decision and versioned contract preceded implementation: [ADR 0099](../adr/0099-s16-installed-desktop-client.md), [s16-desktop/v1](../contracts/s16-desktop-v1.md). Build/install/recovery and platform limits: [runbook](../runbooks/s16-desktop.md).

The opt-in proof installs the sealed native package into fresh private roots and imports its actual compiled `main.js`; it launches actual signed vendor Chrome and the real protected Jit composition over loopback HTTP. React, service worker, native sandbox/private-pipe boundary, file picker/download, current owner/CSRF/receipts, OAuth/PKCE and exact actions are real owning paths. Models, MCP/OAuth provider, Gmail and working computers are controlled fixtures. No live account login, physical microphone, private recording, paid service, production deployment or owner-host activation occurs. Full private receipts, executable paths and profiles are excluded from this public record.

## Immutable build inputs

| Input | Receipt |
| --- | --- |
| Runtime source | `3deb106cf43e9b2e631f5ac04a8a1982c827b7d1`, dirty `false` |
| Native contract / release | `s16-desktop-native-release/v1` / `65e0ab662f414b3025e8c262a84cedebfb132b9a7c085f72c207e44baeb33311` |
| Native inventory | 130 regular files, 15,669,297 bytes; full hashes/modes verified at install/launch |
| Public client contract / release | `s16-desktop-release/v1` / `262a67f97244687f2dc4220bdab4c9f7d2e08e3c5c42cb4abb67cc063955fe8d` |
| Public inventory | 8 members, 1,876,728 bytes; full hashes/types/lengths verified before completion |
| Bun | `1.4.2` (`43848b5a7`) |
| Playwright | Existing frozen `playwright-core 1.64.1`; no added dependency or browser download |
| Lock SHA-256 | `05901663c7a3f9c3fd8e75b26adb6cb147313f41ffdb5417f9531a21ebce3076` |
| Actual platform/browser | macOS `27.2`, ARM64; Google Chrome `157.0.8103.79` |
| Browser custody | Complete vendor signature verified strictly; Apple anchor, Google identifier/team; sandbox/private pipe, no debug TCP port |

The person's original browser application was not modified. A private metadata-clean vendor copy passed the complete signature check for conformance. No Google/Bun binary is shipped in the native package. Existing Apache/MIT and Playwright LICENSE/NOTICE/ThirdPartyNotices plus Jit's root/third_party records ship; browser bundles retain the existing dependency/provenance header. Rakazo comparison pins and the demonstrated bare-PWA cross-port cookie counterexample are recorded in ADR 0099; no new Rakazo source, assets, competing runtime or branding were imported.

## Observed owning outcomes

| Acceptance | Evidence and result |
| --- | --- |
| Native launch and boundary | Actual standalone app identity/display mode; sandbox and private pipe verified from Chrome's real command line. A second origin on the same hostname/different port receives zero requests after direct/redirect navigation attempts. No `require`/Electron host bridge; only the receipt-bound owner-link callback exists. Unit/CDP cases reject adversarial service/deep links, foreign/opaque initiators, WebSockets and unchecked redirects. |
| File → result → native download | EN 1440 px and TH 390 px use the actual installed client picker/upload, guarded `file_read`/`file_create`, committed preview and ordinary Chrome download destination. Downloaded bytes and SHA-256 match the committed artifact. Script-like input remains inert. Keyboard Escape restores preview-button focus; no horizontal overflow. |
| Unknown send and full reconnect | Fault injection loses the browser response only after actual HTTP 202 admission. The client keeps the original identity, reloads/read-backs that receipt and never posts it again. Complete native session close/reopen retains its same protected profile/session and committed artifact, with one message POST total. No private API/file/result response enters Cache Storage. |
| Exact approval and existing views | EN/TH execute one prepared fixture email only after keyboard activation of its exact current in-chat approval. Before activation the effect count is zero; after activation/reload it is one with one decision POST. Existing Bots/computer views use that same service. All installed workflows report zero install-induced working-VM calls. |
| Manual OAuth and public help | Invented/replayed URLs refuse. Fixed GitHub help refuses with no real activation (CDP `userGesture:false`) and opens only after a real owner click. Provider browsers have zero Jit cookies and no native binding. Actual protected registration, one-use state, callback and PKCE exchange produce `needs_review`, never an invented connected state. A subsequent OAuth `source.reconnect` opens a new session-free provider window and completes its own one-use exchange under the same source/revision checks. Declining returns `reconnect_required` with zero token exchanges/catalog reads. Provider callbacks carry no cookie. |
| Public update lifecycle | Real Chrome rejects a truncated next package, removes its incomplete cache and preserves the active package. A subsequently complete package remains waiting while the old window is open; it activates after complete native close/reopen. Both complete package generations remain cached, and current profile authentication survives. No message, decision or VM call accompanies updating. |
| Native update/rollback | Deterministic installer cases interrupt real local stage/rename/pointer boundaries and reject malformed, corrupt, unlisted, linked or unsupported artifacts. A real generated distribution is installed/imported, updated and rolled back with verified bytes; preceding release/profile markers survive. Stable bootstrap/runtime/service mismatch gates remain enforced. |
| Native permissions/offline | Installing grants neither microphone nor notification permission. Actual Chrome permission denial appears as blocked notification settings; restoring prompt state makes the explicit enable control available. Going offline removes the private committed artifact projection; reconnect restores it from the service with no second send or decision. Physical capture/push delivery remains separately labelled. |
| Last-window close/reopen | Close the first of two real owned pages: the managed profile remains leased. Close the actual last page, without calling the harness's session-close method: `session.closed` settles, the lease disappears and the same profile reopens. The standalone handoff keeps its already-open app page. |
| Private child-view revalidation | Actual Bots and Connections views unmount offline. Another authenticated fixture device renames a Bot or removes the source while disconnected. A barrier holds fresh owning reads after reconnect: old labels never reappear, then only current facts render after release. OAuth return hashes are consumed once. Root refresh withholds unsent text/file chips while bootstrap is pending; the same validated scope restores them, while a different valid cookie sharing the same CSRF discards them. |
| Bounded slow connection | Actual MCP initialization takes twenty seconds and tools/list another twenty. The installed native request returns one owning `needs_review` receipt after more than thirty seconds, with one command POST, no provider cookie and no VM call. The finite fifteen-minute whole-response budget covers the owning multi-page bounds; protocol cases retain zero redirects/retries, exact origins/WebSockets, opaque-initiator denial and the 128 MiB response limit. |

## Commands and results

```sh
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 30000
git diff --check
bun run ops:desktop build --source <clean-checkout> --output <fresh-artifact>
JIT_S16_DESKTOP_ARTIFACT=<absolute-sealed-artifact> \
JIT_BROWSER_EXECUTABLE=<verified-vendor-browser> JIT_S16_DESKTOP_TESTS=1 \
bun test --timeout 30000 tests/s16-desktop.browser.test.ts \
  tests/s16-desktop-oauth.browser.test.ts \
  tests/s16-desktop-workflow.browser.test.ts \
  tests/s16-desktop-lifecycle.browser.test.ts \
  tests/s16-desktop-connections.browser.test.ts
```

Installed/browser run on the clean runtime above: **16 passed, 0 failed, 185 assertions, 5 files, 200.35 seconds**. Fourteen cases load the installed compiled runtime; the two EN/TH connection-window cases exercise its owning source module directly. All controlled apps/browsers/services are closed and temporary native roots removed.

Review-regression suites on that runtime:

- Client/boundary/owner-link: **38 passed / 236 assertions** (`tests/s16-client.test.ts`, `tests/s16-desktop-boundary.test.ts`, `tests/s16-desktop-owner-links.test.ts`).
- Affected deterministic: **114 passed / 1,073 assertions / 11 files** (client, desktop installation/distribution/owner-link/boundary, notifications, voice call, connections, Bots, steering and artifacts).
- Desktop/composed: **96 passed, 2 explicit real-guest skips, 0 failed / 839 assertions / 12 files** (desktop package/worker/CDP/storage/lease/installation/distribution/owner-link/boundary, notification worker/composition and files composition).
- Rendered regressions: **45 passed / 671 assertions / 11 files, 244.09 seconds** (`s16-connections`, `s16-bots`, `s16-files`, `s16-memory`, `s16-artifacts`, `s16-routines`, `s16-protected-browser`, `s16-voice-call`, `s16-approval`, `s16-steering`, `s16-needs-you` browser test files), with the actual current React bundle and controlled protected service.

The earlier full local repository run completed with **5,285 passed, 133 skipped and one failed stale screen-CSP assertion**, across 333 files / 279,894 assertions. The old assertion required only `img-src blob:`; desktop public icons intentionally also require exactly `'self'`. It was updated to enforce the finite `[img-src, 'self', blob:]` list, retaining rejection of remote/data sources. Its focused screen/package/CDP rerun passed **35 tests, 2 opt-in skips, 0 failures, 318 assertions**; all fourteen required checks subsequently passed on `bc2e6ab63c443d0b912b4dd5eefca811832aa1ae`. That older green head does not authorize merging the later review fixes: required CI must pass again on the final head. Live/opt-in cases remain explicitly skipped by the default command. Frozen installation, typecheck, whitespace and upstream provenance checks passed again (2 inventoried upstream files / 6 licenses).

## Compatibility and limits

The selected client/native/profile/current/install schemas are v1. They add delivery/profile records only; no service journal migration, S14 default, S15 opt-in selection, installed policy, private historical scope or owner-host configuration changes. Ordinary browser S16 and local API authority/receipt consumers remain compatible. A native code rollback cannot roll back service facts or approve/dispatch work. Source contracts and dependency pinning remain on supported public APIs.

Physical Finder/Gatekeeper, OS credential-store custody, actual Linux desktop/keyring, physical microphone, live provider account/2FA and live Web Push receipts remain **#431**. Windows native launch is unsupported. Owner-host/service cutover remains **#432**. No headless or scripted fixture is promoted into those receipts, and parent #392 stays open. Native packages use trusted local artifact/manifest selection rather than an unattended remote updater or publisher signature.

The follow-up proof commit changes this evidence record only: the shipped runtime/public bytes remain exactly the clean source pin above. The four valid review findings are fixed there, including the additive non-credential bootstrap continuity hash documented in `s16-client/v1`; it cannot authenticate or satisfy CSRF. Primary review checks the final patch against that pin and requires all registered latest-head checks before merge.

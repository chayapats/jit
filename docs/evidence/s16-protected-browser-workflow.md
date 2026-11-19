# S16 protected modern-browser workflow evidence

Date: 2026-11-19. Scope: #409 / BROW16-01B; S16-AC06; FR-07/17/37/38/40/41 and NFR-07/10/14. Contracts: [ADR 0097](../adr/0097-s16-protected-input-intents-and-client-workflow.md), [s16-modern-browser/v1](../contracts/s16-modern-browser-v1.md), existing POLICY/DATA15 and unchanged `s15-browser-request/v1` actions. This extends the [#408 isolation/reference record](s16-protected-browser-reference.md).

Protected native-suite source: `1d357a5e8976c4a836f11174c4cbac37b8ff9e19`. Final client/card source: `191259865aa81dbf944d35ff5bf23c5eda846825`. Working-VM runner source: `02d181903cbd4256ad54d3da114afe8d01f96634`; the later lease fix changes no working-VM/browser/screen implementation. Each result below retains its tested source; later documentation commits are not new native runs. Installation addresses, profile paths, TLS keys, frames and raw receipts stay in ignored `.local` records.

## Protected actual-service/client workflow

The tests use the production S15 composition, POLICY/DATA15, authenticated shared HTTP client, actual bundled React application and separate real Chromium profiles. Models are scripted; login uses an ephemeral synthetic password and a TOTP fixture clock. No live account, paid inference, payment or production deployment runs.

`tests/s16-protected-browser.browser.test.ts` completes the following at English 1440px and Thai 390px:

1. A Bot navigates to the controlled login site and completes its request, releasing the work lease.
2. The owner opens the distinct protected view, takes control and enters password/2FA through opaque current-document controls. Input goes directly to the protected owner port; no conversation command/draft retains it.
3. A disconnect covers the frame and keeps owner control. Reconnect refreshes current facts; the service records one password submission and one 2FA submission, with no repeated login.
4. Return to Bot enters Checking; an actual protected cookie-bearing session probe verifies Signed in.
5. A real JavaScript application hydrates through fetch and XHR. A Bot edits its message to Unicode text with a literal `+`; its async send is held before service delivery. The in-chat exact card shows readable decoded form fields alongside the original request/body, and a keyboard approval releases one verified effect. Query/form display preserves repeated names, empty values and order without changing payload bytes or the action hash.
6. A second authorized Bot opens a fresh work closure and uses the same protected session without copying cookies or logging in again. Prompts and non-profile stores contain no login password. Mobile has no horizontal overflow; private screenshot artifacts were visually inspected.

The ordinary provisioned read-only browser reports `signIn: false`; displaying the new view does not enable unsupported sign-in or general-mode handlers. Closing the protected view never hands control back. Frame/control responses are no-store and generation-bound; HTTP reauthenticates after asynchronous waits.

## Request, authority and recovery cases

`tests/s16-browser-intents.test.ts` and `tests/s15-disclosure-browser.test.ts` exercise actual POLICY and HTTP service bytes behind deterministic engines/barriers. They cover exact approval, missing/guessed nonces, changed body/URL/navigation/content type, duplicate mutation, unknown semantics before input, changed trusted meaning before dispatch, resource/recipient/source withdrawal, changed source ancestry, private async GET disclosure, cancellation and expiry. Neither an unknown payload nor a changed semantic/source ceiling becomes a new approval silently.

`tests/s16-browser-intents.native.test.ts` repeats actual fetch/XHR/deferred requests, duplicate delivery attempts and submit-time recipient substitution in Chromium. Its SPA case reads the actual renderer URL before claiming an observation and refuses secret-route text/screenshots. Agent images retain secret-surface checks. Input acknowledgement is not a verified effect.

A lifetime regression was reproduced before fixing it: work release during owner control threw `input_busy`; release during Checking advanced the session-probe generation. Completed Bot scopes now release without changing independent owner control/probes, while unfinished agent scopes still retain custody. Deterministic overlap and native owner input/session-response barriers verify this; a fresh work lease then resumes normal browsing.

`tests/s16-browser-crash.test.ts` runs both native-form and async-intent SIGKILL cases. A separate real service first receives the approved POST and withholds its response. Controller/browser loss retains the original action as unknown; reconnect, resume and an owner statement cannot replay or clear it. A protected read-only verifier checks the exact body hash and count of one before continuity clears. This is process-loss evidence, not hardware power-loss attestation.

## Completed checks

The following run at protected source `1d357a5e8976c4a836f11174c4cbac37b8ff9e19` on both macOS arm64 and a separate Linux arm64 controller:

| Suite | Each platform |
| --- | --- |
| `s16-browser-conformance`, `s16-browser-crash`, `s16-browser-intents.native` | 16 pass, 0 fail, 182 assertions |
| Controlled `s15-browser-live` (`actual navigation\|approved name`) | 4 pass, 0 fail, 134 assertions |
| Actual bundled `s16-protected-browser.browser` + `s16-voice.browser` | 9 pass, 0 fail, 197 assertions |
| Protected owner/client, intents, browser/egress/DATA15, Parallel/Web settings and voice regression (12 files) | 217 pass, 0 fail, 1,205 assertions |

Frozen install, typecheck and upstream provenance checks pass. Package/runtime/installer/upstream coverage at `02d181903cbd4256ad54d3da114afe8d01f96634` passes 218 tests with 1,344 assertions. PR checks/review record the final head. The old external protected-browser Excalidraw case is filtered out; the public task below uses the working VM as S16-D09 requires.

Final client/card source `191259865aa81dbf944d35ff5bf23c5eda846825` also passes `bun run typecheck`; `bun test --timeout 30000 tests/s16-action-card.test.ts tests/s16-protected-browser.test.ts tests/s16-client.test.ts` (**33 pass, 0 fail, 188 assertions**); and `JIT_S16_BROWSER_TESTS=1 bun test --timeout 30000 tests/s16-protected-browser.browser.test.ts tests/s16-approval.browser.test.ts` (**4 pass, 0 fail, 164 assertions**). The latter uses the actual bundle at English 1440px and Thai 390px, with keyboard approval and no horizontal overflow. Entry, owner and readable Unicode-card screenshots were visually inspected. Two concurrent-response barriers verify that a 401/403 frame clears client authority and withholds another private frame whose body arrives later.

| Component | Observed version / SHA-256 |
| --- | --- |
| macOS Google Chrome | `157.0.8103.79`; `23010a3aeff294b54c6e8dc9a88e61388ec4655e2c10216c8a4ae2c050bfcb1b` |
| Linux controller | aarch64, kernel `6.8.0-149-generic` |
| Linux controller Chrome for Testing | `156.0.8078.4`; `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65` |
| Linux Bun | `1.4.2`; `616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1` |
| Playwright | `1.64.1` |

## Actual working-VM public and trusted tasks

`ops/evidence/s16-working-browser.ts` completed at source `02d181903cbd4256ad54d3da114afe8d01f96634`, from `2026-11-19T07:23:48.556Z` to `07:24:13.180Z`. It uses the production pinned desktop installer, Chrome pipe relay/attach, finite `ComputerBrowser`, POLICY fixture grants, `ScreenControl` and actual QMP frames/input. The Linux arm64 guest is a separate root-administrable Lima/QEMU working VM. External manager inspection verifies proxy-only restricted networking, IPv6 off and no exports; a reference-only wrapper adds the fixed virtual GPU/input devices. This is an optional reference topology, not the default nested Linux KVM deployment.

The public task opens the real [TypeScript documentation](https://www.typescriptlang.org/docs/), selects the observed “Everyday Types” control and reads the actual [destination](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html). It waits for a fresh observation after the SPA acknowledgement, without repeating the input. The bounded observed-text SHA-256 is `f0103c11025a98d6b85b6c35683270aba3de630fb34f7f470d214d4370b56af1`. No custom business API or site integration supplies the result.

The owner then takes the actual working screen, types into one synthetic trusted site's login through QMP and returns control. Two distinct authorized Bots create new browser runs, select fresh tab handles and read the authenticated team record. The actual service records **one login**, with no cookie copy. Serialized protected screen/POLICY stores contain neither the input password nor its SHA-256. This intentionally demonstrates the trusted-session residual inside the working guest; sensitive-site credentials use the separate protected path above.

The fixture alone uses explicit DNS/fixed-dial injection and a synthetic TLS trust anchor in the disposable guest. Public-site traffic keeps ordinary public-address checks. The runner removes its trust anchor, stops the working VM and verifies all baseline snapshots remain. The separate protected Linux controller is also stopped after receipts are copied out.

| Working-VM component | Observed build |
| --- | --- |
| Linux guest | aarch64, kernel `6.8.0-142-generic` |
| Chrome for Testing | `157.0.8103.50`; binary SHA-256 `7dd16848bc590256b092cab459ddf5d54c780f918bb0a1e6bec98f9fe3a1cc0e` |
| Pinned arm64 archive | SHA-256 `9539c1612121eb09c4b787f4f9d0c732357772eb22583620ffed64d50dd6c4cc` |
| Desktop session | `157.0.8103.50+session.cdp-2` |
| QEMU / management Bun | `11.1.3` / `1.4.2` |
| Tested reference wrapper | SHA-256 `b901aa8652b176cdf148a8cb1ce9962516af5504142b14e81c148cac4aa6f5b0` |

## Compatibility, research and remaining acceptance

FR-41's existing anonymous/free-first Parallel owner and bounded query/URL audit remain unchanged. Its real protocol fixtures verify anonymous discovery/search/fetch, current evidence/correlation, credential/private-address refusal, untrusted framing, withdrawal/deadline handling and no silent vendor/account/billing fallback. Browser evidence separately binds current document URL, generation, actual bytes and current authority; the public task uses observed source content rather than model prose as proof. No S14/S15 authority records are combined or migrated by this change.

S14 default, S15 opt-in, installed policy, existing private scopes and owner-host configuration remain unchanged. There is no new dependency, copied Rakazo code/asset, competing runtime or private Schway import; existing immutable provenance/licenses remain. Unknown site semantics and unsupported credential/hidden/CSRF/header formats require a supported protected contract, not timing permits or guessed approval cards. Guarded file transfer stays with its existing contracts.

The reproduction commands and private-artifact requirements are in [the runner guide](../../ops/evidence/README.md). Live accounts/devices and exact owner-reviewed host adoption/rollback remain #431/#432; parent #392 requires the rest of S16. These fixtures do not attest against browser/hypervisor exploits, all websites, another installation or hardware power loss.

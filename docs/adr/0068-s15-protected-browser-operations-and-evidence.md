---
status: accepted
date: 2026-11-03
scope: BROW15-01 (#322); FR-07/17/18/29/36/37/38/40; NFR-04/07/10/14
---

# Protected browser operations, actual dispatch and observed evidence

## Implemented record-effect refinement (2026-11-03)

[s15-effects/v1](../contracts/s15-effects-v1.md) adds a controlled native-form document/task/business reference service over the existing gateway. Its independent remote CAS and operation journal bind observed versions and actual consequences. An optional protected read-only site verifier supports charged reconciliation; the owner hook clears only matching uncertainty on conclusive evidence. CHAT's additive host dispatcher resumes the original pending browser request after approval. No arbitrary website writes, generic reconciliation, real CRM, new credentials or visual UI are implied.

## Decision and scope

Implement the bounded [protected-browser contract revision 2](../contracts/s15-protected-browser-v1.md) through the actual host API in `src/s15/browser`. S14 remains the default. This accepts the implementation choices below, not universal website support or S15 host adoption. The owner's RT15-01 option B places valuable data, sessions, credentials and real external effects outside the root-administrable expendable working VM (ADR 0064).

The earlier documentation-only ports, support manifests, framing, synthetic worlds and hash catalogs were proposals. They are not required runtime machinery. Reuse the real S15 policy service for authority, exact actions, approvals, claims, read budgets and publication. Keep only a minimal separate current-continuity record for browser generation and uncertain effect fencing; do not store cookies or payloads there. No Schway change/private import is needed: the public custom-tool interface composes the protected work closure.

## Browser and effects

Provide both JavaScript-disabled static mode and JavaScript-enabled general mode. Chromium runs on the protected host with a private pipe, a deny-only proxy, no loopback proxy bypass, disabled DNS/QUIC/nonproxied WebRTC, blocked service workers and disabled extensions. Intercept HTTP requests before release; the protected broker alone opens outbound sockets, injects private origin-scoped session cookies and fulfills the original paused request. An interception callback without the deny-only fallback would leave unobserved routes; a generic authenticated browser in the working VM would expose reusable session authority.

Protected installed semantics classify exact actual requests, not labels, model declarations or GET alone. Public credential-free GET/HEAD reads to approved destinations have no per-page approval. Known main-document form effects enter real policy prepare/evaluate/dispatch with immutable method, URL, body bytes and recipient/transaction semantics. Ordinary reversible edits may match standing policy. Sends, financial transactions, publication, production, private disclosure/new egress and major changes encounter their applicable gates. Cookies, passwords and 2FA never enter action payloads or work observations.

Use a conservative support boundary: no arbitrary agent JS/CDP/BiDi, file chooser/upload/download/clipboard, frames, popups, workers, WebSocket/EventSource/streaming or automatic redirects. Unknown effects refuse. JavaScript fetch/timer/beacon mutations lack proven input causality and are denied, even inside an input timing window. General public JavaScript rendering remains supported without a bespoke business API. Authenticated effect/observation semantics require actual trusted proof; no claim every website works is made.

The broker uses manual redirects and denies 3xx before a next request or browser auto-follow. Host-broker sending is chosen over `route.continue`: it makes the entire application HTTP emitter and credential projection explicit. This has compatibility costs, including some cross-origin/authenticated applications. Missing request/secret/causality proof remains unavailable rather than repaired by approval. It does not protect against a browser-engine or host compromise.

## Input, login and uncertainty

Input completion is tied to real native acknowledgement, navigation/frame-stop and intercepted-request settlement, with a finite 30-second deadline that reports uncertainty. Propagate tool cancellation through every final input/release/publication guard. A released broker effect survives operation cancellation/deadline under its original claim and retained capacity; it is never aborted or retried by input cleanup. Preserve each Set-Cookie field with getSetCookie through private fulfillment, including independent attributes and Expires commas.

Finite native operations use fixed observed element handles and generation checks. Mutations, takeover, hand-back and restart advance protected generations. Takeover fences pending work and waits for prior native input settlement. Authenticated owner frames/transient named-field input are restricted to configured login/2FA documents. No visual UI is designed in this slice; #339 owns the presentation.

Hand-back reports `checking`. Only a configured protected session observation with an origin-scoped HttpOnly cookie and the expected nonredirecting response establishes signed-in state. Otherwise report not_signed_in, cancelled or unknown. Signing in grants no send/payment authority. Secret surfaces are withheld; generic field masking cannot prove arbitrary pages safe.

Arm exact effect references in protected current continuity before dispatch. Missing responses or unverified business outcomes remain unknown and block fresh effect retries, including across browser restart/profile restoration. HTTP 200 alone is not business success. Lost contexts cannot dispatch; owner statements cannot clear uncertainty. The policy ledger independently retains claims, usage, approvals and observations outside browser/VM snapshots.

## Evidence and remaining gates

Deterministic Bun tests exercise real policy decisions, exact request bytes, session/owner fences, late publication, secret suppression, denial paths and crash continuity. Opt-in real Chromium tests on a disposable Linux arm64 container exercise both modes against a controlled login/TOTP/message/checkout/query/redirect/popup/download site. A separate public task reads client-rendered Excalidraw controls. Installation-specific logs and screenshots remain ignored `.local` evidence; the PR records tested SHA and counts.

This evidence advances RF15-G03/G04 for the stated browser surface. It does not certify full VM/root egress isolation, Linux x64, every site/session mechanism, protected process resource enforcement, generic business reconciliation, cross-resource team scheduling or owner-host adoption. Those remain integration/activation obligations under ADR 0064 and their owning slices. No existing installed Jit state is modified by these tests.

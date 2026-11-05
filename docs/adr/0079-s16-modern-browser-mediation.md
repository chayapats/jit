---
status: selected for bounded prototype; physical guest-root and product activation acceptance pending
date: 2026-11-05
scope: BROW16-01A; S16-AC06/07; FR-07/10/17/18/35/36/37/38/40/41; NFR-07/10/11/14
---

# Modern browser mediation on the protected host

Keep the existing protected Chromium `general` engine and request broker as the first S16 candidate. Demonstrate an authenticated task whose UI requires real JavaScript, fetch and XMLHttpRequest before a native form exists. Compare its actual server effects with a static-mode negative control. The prototype uses production engine/POLICY ports, disposable profiles and controlled HTTP, not an offline DOM or a screenshot-only mock.

## Alternatives and source audit

| Candidate | Useful capability | Boundary/cost | Decision |
| --- | --- | --- | --- |
| Existing protected general Chromium + host broker | JS rendering, opaque observed targets, actual request bytes, immutable POLICY action/approval/claim, transient owner login, unknown/reconcile continuity | Provisioned runtime is still static; asynchronous mutation attribution, generic safe authenticated observations, downloads and guest-root placement need additional proof | Select for bounded conformance before #409 rollout |
| Rakazo live computer browser | Shared graphical Chrome and CDP page operations on the Bot computer, with explicit fallback to computer input | Jit's root-administrable guest cannot receive a sensitive reusable session/CDP endpoint. Moving the endpoint alone supplies no request semantics or protected approval proof | Reuse experience/adapter ideas; do not copy the guest CDP/session placement |
| Separate remote browser service | Explicit process/VM/host boundary and centralized lifecycle | Adds authentication, network protocol, deployment and recovery ownership while still needing request/effect semantics; does not itself solve JS mutation attribution | Retain as a placement alternative if real host proof rejects protected local custody |

Audit pin: Rakazo `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`, tree `f8ca5adc96366b722bb60186c21cb29cec0f5390`. Inspected `packages/adapters/src/browser-provider-factory.ts` (SHA-256 `343ad996311ed876ad5cf45e6fbb89bd92f3de294362e207f7a282b9452a78f2`), `computer-browser.ts` (`cc2af645eb07279565022895d9d6702242b9b0954e70d8ba02dc18aa9491f8e5`) and `page-browser-session.ts` (`b4ff3805784ef91cbac8c60b71d56248d266713b35b7a6c268eae4b74a0fcdd4`). These are immutable source observations, not an upstream security finding or a claim that Rakazo promises Jit's root/approval boundary. Root license Apache-2.0; this prototype imports no upstream source/assets/dependencies and needs no new redistribution notice. Future imports follow ADR 0074/#405.

## Selected public contract and custody

[s16-modern-browser/v1](../contracts/s16-modern-browser-v1.md) profiles the existing exported `BrowserRegistration`, `BrowserWork`, `BrowserOwner`, `BrowserOperation`, `BrowserResult` and `s15-browser-request/v1`; it introduces no alternate authority or speculative implemented API. Schway's public `ToolDefinition` callback binds only a current host-owned work closure. Engine-owned Playwright handles, cookie access and fixed DOM evaluation stay private. No missing public Schway capability has been reproduced.

Both Chromium modes use the same deny-only proxy, public-address/fixed-dial broker, protected source/recipient checks and current POLICY guards. General mode enables page scripts, not direct egress, raw protocols or sensitive-session access from guest tools. Profiles, continuity and controller pipes must remain outside guest mounts/network/API capabilities; local fixture permissions alone cannot establish guest-root isolation.

The prototype reproduces initial fetch/XHR being refused when explicit navigation ends at `DOMContentLoaded` before their intercepted callbacks arrive. Select the existing native-click navigation's bounded `networkidle` readiness barrier for explicit general-mode navigation too; static behavior stays unchanged. Every read still requires its own real current policy claim. The readiness window is not effect attribution or task/business success. Persistent polling can exhaust the existing deadline and remains a supported-limit diagnostic; delayed requests after the operation have no borrowed authority. No arbitrary sleep, extra permission or background session lease is added.

The exact selected native form/anchor request may become an immutable held effect. Approved resume releases that paused request once, never repeats the input. Changed recipient/body, JS substitution, stale generation, takeover or process loss cannot borrow the old approval. Requests lacking a supported causal/semantic binding refuse before a socket. HTTP 200 is not business success: a trusted exact response verifier and actual service state are separate proof.

## Required extension and replacement evidence

The current native binding does not attribute non-document fetch/XHR mutation, even when its endpoint semantics are known. An input timing window cannot supply that authority. #409 must deliver a reviewed protected intent-to-request binding for representative asynchronous applications, or a simpler alternative with equivalent semantics; copying a raw CDP tool is not that contract. Until implemented, report the exact unsupported reason rather than offering an approval that could not make the request safe. This is an unresolved delivery requirement, not a scope reduction of S16.

Protected handlers must classify exact URL/query/body, private data, actual recipient and action class; unknown methods/paths/effects refuse. Generic public rendering can use reviewed destination/content rules without a custom business API, but safe authenticated observation and business outcomes need evidence. #433/#407 own guarded file transfer/collection; browser downloads are not silently enabled. #410 owns authored graphical takeover/client lifecycle; this prototype exercises the existing real transient owner port, with no new UI design.

## Recovery, compatibility and acceptance

Keep current continuity armed before dispatch. A crash or lost response remains unknown and reconcile-only until protected service evidence resolves the exact action. Restart cannot reconstruct a callable paused request or retry the input. Cancellation/takeover fences new input but cannot claim to recall a released transport. Owner statements do not verify remote outcomes.

This slice changes no runtime default, installed policy, profile/store schema, existing receipts or owner-host configuration. #402's independent memory worktree is untouched. The controlled probe supplies no live account/physical Linux proof. #408 remains open until its review and remaining acceptance evidence are satisfied; #397/#392 cannot close from this bounded result. Exact conformance results and physical proof obligations belong in the linked contract and implementation PR.

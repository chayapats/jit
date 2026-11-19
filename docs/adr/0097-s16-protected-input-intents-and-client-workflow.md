---
status: selected engineering contract for implementation; no new browser capability claimed yet
date: 2026-11-18
scope: BROW16-01B (#409); S16-AC06; FR-07/17/37/38/40/41; NFR-07/10/14
---

# Protected input intents and the client website workflow

## Required outcome and baseline

#409 requires an actual composed client-to-site workflow: protected login/2FA, approved team session reuse, a held external action, current resource/recipient/source checks, one dispatch across approval retry/reconnect, honest unknown recovery, and representative public/trusted work without a custom business integration. Its #408/#395 prerequisites are merged/closed. Main `7431400a7d1d462c70d9a457d476d270f86f8d59` includes #408's reference isolation/crash proof. Issue ownership and branches/PRs were rechecked; #409 was unassigned and has no competing implementation branch/PR. It is now owned on `jit/409-modern-browser` in its own worktree.

[ADR 0079](0079-s16-modern-browser-mediation.md) / [s16-modern-browser/v1](../contracts/s16-modern-browser-v1.md) prove authenticated fetch/XHR reads and exact native-form effects, but refuse non-document mutations. The native form expectation is not an asynchronous input contract. The provisioned anonymous protected browser remains static; no owner host is activated by these changes. S16-D09 / [ADR 0084](0084-s16-grok-style-default-autonomy.md) keep public and explicitly trusted sites in the working VM browser, with their accepted custody residual. Sensitive sessions remain outside guest control. [ADR 0064](0064-conversational-authority-and-protected-control-plane.md) still owns installation-specific enforcement gates.

## Alternatives

| Approach | Assessment |
| --- | --- |
| Treat every request shortly after a click as attributable | Reject: timing supplies no exact action or private-source ceiling |
| Give page/VM/model code a request permit or raw CDP/session access | Reject: content cannot issue authority; sensitive sessions/control stay protected |
| Reimplement each application as a business connector | Useful when its API is reviewed, but does not deliver a website workflow or general public browsing |
| Protected pre-input semantic intent plus exact actual-wire matching | Select: the host freezes a supported request from a bounded input snapshot, and only its one matching actual request may reach existing POLICY/DATA15 dispatch |

Reuse the authored S16 Computer/Approvals handoff and existing Mobbin research. Primary owns UI/UX. Retain ADR 0079's immutable Rakazo comparison at `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`, tree `f8ca5adc96366b722bb60186c21cb29cec0f5390`; no copied source/assets or new dependency is selected. No private Schway import or competing loop is needed: the existing public host tool callback can carry the current work closure.

## Selected binding

Add an optional **trusted host** input-intent callback to `BrowserSitePolicy`. This is installed with the existing semantic handler, not imported from a page, a model/tool payload or a guest package. Before an actual supported click/submit/edit, fixed protected capture obtains a finite snapshot of the selected control, current document and ordinary visible form values. It excludes credential/file/hidden values and never returns this internal snapshot to an agent or history. Source data remains untrusted. The callback maps only reviewed known input/request semantics to a complete credential-free `BrowserRequest`, or returns no intent.

The host validates the proposed request and its existing `classify` result before input. A supported effect must have known classes, recipients and finite scope; a generic HTTP method, label or incomplete payload cannot become an approvable action. A fresh process-private nonce binds the exact request, originating work, input generation, current source/recipient ceiling, selected operation and finite operation expiry. No new authority comes from that nonce. The engine can attach it only to one intercepted request whose complete method/URL/content type/body/navigation match the protected expectation. The gateway independently checks/consumes the binding and runs the existing exact semantic, POLICY, DATA15, destination and final commit guards.

The actual intercepted request supplies the immutable existing `s15-browser-request/v1` action payload. Existing readable exact cards show its actual content/destination; approval decides the exact action reference/hash once. A changed request/recipient/body/source/generation needs new authority; a second matching mutation cannot reuse the binding. Unknown request semantics still refuse. Native document binding remains compatible when no new intent is configured. The model's closed browser operation union gains no raw HTTP/JS/cookie/header argument.

This is an **exact-effect equivalence** contract, not a claim to trace JavaScript call stacks through arbitrary asynchronous tasks. If another task emits the identical fully reviewed request while this intent is active, it cannot widen the effect: at most one exact matching request can dispatch. A workflow that needs a distinguishable initiator beyond exact effect identity is unsupported until a stronger contract exists. This limitation is explicit rather than inferred from an input timing window.

The operation waits for its intended request/response or finite refusal/expiry, so a non-navigating click acknowledgement cannot become a completed website action before its fetch/XHR occurs. Ordinary reads still need their own current policy claims. Cancellation returns a fenced result while retaining native input/network custody until real browser scopes settle; takeover cannot release an old target or response. A binding never reconstructs or clicks again after process loss.

Credential-bearing login bodies keep the existing transient owner-only native path; sensitive cookies remain protected engine/broker material. A new intent's body must be credential-free under its reviewed semantic handler. Unsupported authentication/CSRF/header formats must identify the missing contract; they cannot be put into ordinary action/history/export payloads or guessed from hidden fields. Actual account/profile support and broader authenticated-site coverage remain evidence obligations, not authority granted by an origin allowlist.

## Composed owner workflow

Expose the existing protected browser registration through additive shared-client owner operations for current status, generation-bound takeover/frame/input/hand-back and read-only reconciliation. Reuse the actual host registration/POLICY session; do not introduce a second browser state/approval store. Requests require the current owner, origin/CSRF, no-store responses, bounded bodies and reauthentication after waits. Raw input values go directly to the transient owner port and never into conversation commands, local drafts, logs or exports.

Owner sign-in must remain usable after a completed conversation has released its work lease. Bind transient owner input to the existing current POLICY `OwnerActor`, not a completed Bot's authority and not a fabricated work grant. The fixed engine still accepts input only on exact configured login documents; only native attributed login requests and known read subresources on those documents can run in that owner scope. It cannot prepare or approve ordinary effects or export Bot work. The current owner is rechecked after readiness waits and immediately before each socket. Bot scopes retain all existing work, source, recipient and budget guards. Owner controls use opaque generation/document-bound handles and visible labels without entered values; closing a view preserves owner control. This is direct protected owner sign-in under the existing owner principal, not new agent authority.

A completed Bot can release its agent lease while the owner holds control or the protected session probe is checking. First require that Bot's native/network scopes and paused requests to have settled; then clear only its work binding. Do not advance the owner's generation, cancel owner input or invalidate an in-flight session probe. Takeover/hand-back already fenced the old agent targets, and owner control/checking continue to refuse all agent input. Ordinary agent-owned release keeps its existing generation advance.

The authored protected-browser surface is visibly distinct from the working-computer screen. It shows Taking control, fresh frame/owner control, Return to Bot, Checking session, actual signed-in/unknown state, and a stale/disconnected cover. Agent frames/observations are withheld on secret surfaces. Closing/disconnecting preserves the protected hold, never silently returns agent control. Team reuse depends on current resource/work/input leases and protected observed session facts, without copying cookies or a second per-Bot login ceremony. A held external action uses the existing in-chat exact card; browser control itself does not approve it.

Owner control discovery preserves opaque IDs for the same actual DOM controls, document and generation across concurrent views. Discovery is serialized and remains bounded; a new document or takeover invalidates earlier handles. Background status polling cannot discard an in-flight full owner refresh; a missing frame is retried from current facts rather than left covered indefinitely.

Public and trusted-site proof continues through the working VM browser, with a real public website task and one owner-authenticated trusted-site fixture. Sensitive proof uses a controlled modern website and actual protected ports/native Chromium with synthetic login/TOTP, asynchronous mutations, exact holds and read-back. No live private account is required for independent implementation. Preserve anonymous/free-first Parallel research, bounded query/URL audit and untrusted provenance; a browser failure never selects a different account/vendor/billing route.

## Durability, compatibility and evidence

There is no new approval principal, policy meaning, historical-scope migration or automatic host activation. Existing action payloads, continuity, work receipts and unknown reconciliation remain the owners. Bindings are ephemeral and expire with their original scope. Continuity arms before the actual broker send; a crash after dispatch remains unknown/reconcile-only until protected service evidence resolves the exact bytes/count. Owner statements, page text and reconnect cannot verify or replay an effect. A crash before a usable live binding cannot reconstruct input from an approved card.

Before claiming delivery, run deterministic barriers and actual composed/native/browser scenarios for matching and mismatching requests, duplicate/background attempts, source/recipient/resource withdrawal during waits, takeover/cancel/expiry, login secrecy, session reuse, approved once, response loss/crash and read-only recovery. Exercise English/Thai, keyboard/mobile and actual current service facts. Repeat relevant #408 native regressions so denied/late navigation cannot affect a newer generation. Record exact builds, upstream/artifact provenance and honest unsupported paths. Preserve S14 default, S15 opt-in, omitted-runtime compatibility, current installed policy and existing private lineage. #431/#432 retain real device/account/owner-host acceptance; parent #397/#392 stay open until their complete outcomes are proven.

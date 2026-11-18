# s16-modern-browser/v1

Status: selected bounded feasibility profile for #408, with [reference evidence](../evidence/s16-protected-browser-reference.md); selected by [ADR 0079](../adr/0079-s16-modern-browser-mediation.md). It extends the evidence for [s15-protected-browser/v1](s15-protected-browser-v1.md), revision 2, without adding an implemented wire API or enabling the provisioned runtime's general mode. This is not full S16-AC06/07 acceptance. Under S16-D09 this contract applies to sensitive sites; public and owner-marked trusted sites use the working VM browser and its explicitly accepted session-custody residual ([ADR 0084](../adr/0084-s16-grok-style-default-autonomy.md), [ADR 0092](../adr/0092-s16-agent-use-of-the-working-computer-browser.md)).

## Owning interfaces

| Operation | Existing public owner and actual data | Final authority/evidence |
| --- | --- | --- |
| Register/open | `registerProtectedBrowser(BrowserOptions)`, `attach(S15PolicyService)`, `open(WorkActor)` | Trusted host composition; process-local current actor, approved resource, finite budget and input lease |
| Work interaction | `BrowserWork.execute(BrowserOperation)` | Closed JSON union with current generation and opaque observed target; no agent JS, selector, cookie or raw CDP |
| Actual HTTP request | `BrowserSitePolicy.classify(Readonly<BrowserRequest>, mode)` | Protected semantic handler over exact method/URL/content type/body/navigation; no page/model-issued permits |
| Exact effect | POLICY prepare/evaluate/dispatch and `DispatchContext.commit` | Immutable `s15-browser-request/v1`, current resources/source/recipient/fences, unique claim before socket creation |
| Resume | `BrowserWork.resume(ActionRef)` | Only original paused context, exact approved revision, current guards; single dispatch, no repeated click |
| Owner login | `BrowserOwner.takeover/frame/input/handBack/checkSession` | Authenticated owner only, exact configured login documents, transient secret input, observed session probe |
| Recovery | protected continuity + POLICY reconciliation | Armed action survives restart, missing response remains unknown, read-only service verification before clearing |

`BrowserRequest` contains only `method`, `url`, `contentType`, canonical `bodyBase64` and `navigation`. Session cookies/headers remain inside the protected engine/broker; neither action payload nor work tool gets them. `BrowserResult` distinguishes observed/image/held/unsupported/denied/unknown/ok. Input acknowledgement is not business success. Existing finite input/body/output/network/deadline bounds remain; no new permit or serialized principal is added.

Explicit general-mode navigation now uses the same bounded `networkidle` readiness barrier already used by native-click navigation. Ending at `DOMContentLoaded` or `load` can close the operation before initial fetch/XHR callbacks arrive, causing supported reads to be refused. The barrier keeps those initial requests under the current finite scope; each still needs its own exact real policy claim and final guard. It does not authorize a mutation, certify business success or create an ongoing background lease. Late requests still refuse, and continuous polling can reach the existing timeout.

## Channel trace and conformance target

| Channel | Current enforcement | Required evidence |
| --- | --- | --- |
| JS scripts and fetch/XHR reads | Intercept actual requests, classify exact read semantics, strip session cookies for public reads; private reads keep current source/resource scope | Actual JS creates task controls only after real fetch and XHR responses; static mode cannot complete |
| Native form/anchor | Protected fixed code captures selected request serialization; exact single matching document request may consume input | Hold before service receives bytes; approval releases exact recipient/body once; changed request needs new authority |
| JS fetch/XHR mutations | No native document binding; deny before send, including during a real input; active unsupported binding reports `unattributable_request` | Explicit real-browser negative probe records the actual intercepted request and refusal. A non-navigating click may acknowledge input before the async attempt, which is not business success; #409 must supply reviewed causal/semantic extension |
| JS form substitution | Actual wire bytes differ from selected form expectation | Refuse before outbound mutation; page text cannot turn it into success |
| Timers/beacons/background | No inherited input authority; unknown/private egress cannot use public-read labels | Controlled attack fixture reaches no mutation endpoint |
| WebSocket/EventSource/service workers/frames/workers | WebSocket close, SW block, restrictive CSP and broker/no active request support | Existing actual-engine attack suite plus deterministic schema/network cases |
| Redirect/download/upload | Broker refuses redirects/downloads; engine refuses file input, popup target and download attribute | No follow-up destination, file/partial candidate or alternate uncontrolled input |
| Raw CDP/BiDi/cookies/protocol/socket | No such work API; Chromium control is a host-private pipe; fallback proxy never forwards | Actual reference guest-root file/mount/process/socket attempts plus external manager/network inventory passed; repeat for the actual installation before activation |
| Crash after dispatch | Protected continuity armed first, unknown retains ledger claim/budget; no reconstructed paused request | Actual controller/browser SIGKILL after a separate service receives the POST; restart stays unknown until protected HTTP read-back verifies exact bytes/count, without replay |

Current JS mutations are an implementation gap, not a decision to exclude modern apps from the product. A proposed next contract must bind selected intent, exact request bytes/recipient, current private-source ceiling, generation, one-use nonce, expiry and final commit outside the page/guest. Its semantics cannot be issued by the page/model, inferred from timing or authorized by an unknown payload card. This paragraph is **PROPOSED** input for #409, not an exported method/schema accepted by the current engine.

## Isolation proof and activation gate

The controlled HTTP fixture uses a test-only DNS/dial seam: the loopback site resolves to a public-classified stand-in, and only that checked address dials back to the local server. Production refuses loopback/private destinations. Real Chromium, HTTP bytes, protected cookies, POLICY holds and resulting server state are actual; the fixture is not a public website/account. Separate physical guest-root attempts and their external inventory basis are recorded in the linked reference evidence.

Before enabling authenticated general browsing on an owner host, record the exact shipped controller/VM/browser builds and prove from guest root: no profile/cookie or continuity path is mounted/exported; no raw control port/pipe or owner endpoint is reachable; direct shell/socket/proxy/alternate DNS/IPv6/QUIC/WebRTC routes cannot bypass the external boundary; all mediated new-recipient requests receive final DATA15/POLICY checks. Destroy/restart the guest and browser at dispatch barriers and resolve unknown outcomes only through protected service read-back. Capture hashes/outcomes, never sessions or login input. #409/#431 own implementation/live evidence and #432 exact host adoption. Do not infer these facts from this fixture or controller file mode 0700.

Cancellation returns a fenced work result promptly, but retains the native input lease until original browser I/O and any started navigation finish. Stale targets cannot resume after takeover. Browser closure begins before waiting for those input scopes, so actual renderer shutdown can settle them; broker/continuity ownership remains until its scopes finish. This is distinct from remote effect settlement. Missing/unsupported reconciliation semantics return a settled unknown read, leaving original effect uncertainty and charges intact so a later protected read-only verifier can run. Owner statements, page text and controller restart cannot clear it.

## Compatibility and evidence status

The bounded candidate changes no schema, runtime default, standing policy or owner-host configuration. Existing static provisioned behavior remains. No private Schway import, replacement provider loop, live credential, new dependency or copied upstream code is introduced. #410 delivered the working-computer/takeover UI; #409 retains protected modern-browser product integration. This non-UI probe uses actual host ports and keeps current product loading/unsupported/unknown facts intact.

`tests/s16-browser-conformance.test.ts` runs eight opt-in real Chromium cases: both modes' immediate navigation after denied download/redirect and cancelled held navigation; static negative control; actual authenticated fetch/XHR hydration and edited exact single-dispatch form with changed recipient/new action; actual intercepted JS mutation/submit-time substitution refusal; and a dispatched but unverified result remaining unknown. `tests/s16-browser-crash.test.ts` adds actual process SIGKILL and read-back. Test-only traces record paths/navigation/send-or-deny, never cookies or login input. The controlled service receives the exact approved body once.

At source revision `9b5a31e1d007001415b7d91cb6c38bcfcb0f8bad`, these nine cases passed on macOS arm64 and Linux arm64 (104 assertions each). Four controlled existing real-engine regressions also passed on each platform (134 assertions each), covering both modes, owner login/TOTP, exact effect holds, background/redirect/download/popup denial and DNS/loopback rebinding. The external public Excalidraw case was filtered out. The paired reference-host runner passed all nine physical cases, including live authenticated dynamic work and guest-root attempts while its protected profile/cookies were present. See the evidence record for exact builds, hashes, commands and limits; final PR checks record any later revision. General-browser product parity, live account/device acceptance and exact owner-host adoption remain pending.

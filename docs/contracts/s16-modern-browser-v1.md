# s16-modern-browser/v1

Status: bounded conformance profile for #408; selected by [ADR 0079](../adr/0079-s16-modern-browser-mediation.md). It extends the evidence for [s15-protected-browser/v1](s15-protected-browser-v1.md), revision 2, without adding an implemented wire API or enabling the provisioned runtime's general mode. This is not full S16-AC06/07 acceptance.

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
| Raw CDP/BiDi/cookies/protocol/socket | No such work API; Chromium control is a host-private pipe; fallback proxy never forwards | Finite-tool/API tests; **physical guest-root/network/mount attempts remain mandatory before activation** |
| Crash after dispatch | Protected continuity armed first, unknown retains ledger claim/budget; no reconstructed paused request | Existing continuity/reconcile fixtures; physical crash at dispatch and real read-back remain pending |

Current JS mutations are an implementation gap, not a decision to exclude modern apps from the product. A proposed next contract must bind selected intent, exact request bytes/recipient, current private-source ceiling, generation, one-use nonce, expiry and final commit outside the page/guest. Its semantics cannot be issued by the page/model, inferred from timing or authorized by an unknown payload card. This paragraph is **PROPOSED** input for #409, not an exported method/schema accepted by the current engine.

## Isolation proof and activation gate

The controlled HTTP fixture uses a test-only DNS/dial seam: the loopback site resolves to a public-classified stand-in, and only that checked address dials back to the local server. Production refuses loopback/private destinations. Real Chromium, HTTP bytes, protected cookies, POLICY holds and resulting server state are actual; the fixture is not a public website/account or Linux guest-root demonstration.

Before enabling authenticated general browsing on an owner host, record the exact shipped controller/VM/browser builds and prove from guest root: no profile/cookie or continuity path is mounted/exported; no raw control port/pipe or owner endpoint is reachable; direct shell/socket/proxy/alternate DNS/IPv6/QUIC/WebRTC routes cannot bypass the external boundary; all mediated new-recipient requests receive final DATA15/POLICY checks. Destroy/restart the guest and browser at dispatch barriers and resolve unknown outcomes only through protected service read-back. Capture hashes/outcomes, never sessions or login input. #409/#431 own implementation/live evidence and #432 exact host adoption. Do not infer these facts from this fixture or controller file mode 0700.

## Compatibility and evidence status

The bounded candidate changes no schema, runtime default, standing policy or owner-host configuration. Existing static provisioned behavior remains. No private Schway import, replacement provider loop, live credential, new dependency or copied upstream code is introduced. The authored S16 computer/takeover UI remains #409/#410; this non-UI probe uses actual host ports and keeps current product loading/unsupported/unknown facts intact.

`tests/s16-browser-conformance.test.ts` runs four opt-in real Chromium cases: static negative control, actual authenticated fetch/XHR hydration and edited exact single-dispatch form, changed recipient/new action, actual intercepted JS mutation and submit-time substitution refusal, and an actual dispatched but unverified result staying unknown without replay. Test-only traces record paths/navigation/send-or-deny, never cookies or login input. The controlled service receives the exact approved body once.

Local engine evidence: macOS arm64, Google Chrome `156.0.8078.80`, Playwright `1.64.1`, Bun `1.4.2`. The four cases passed (56 assertions), together with four existing controlled real-engine regressions (134 assertions) covering both modes, owner login/TOTP, exact effect holds, background/redirect/download/popup denial and DNS/loopback rebinding. The external public Excalidraw case was filtered out. This installed Chrome evidence is not the provisioned Linux Chromium release or physical guest proof.

Commands: `JIT_BROWSER_LIVE=1 JIT_BROWSER_EXECUTABLE=<installed-chromium> bun test tests/s16-browser-conformance.test.ts --timeout 60000`; existing controlled regression: `JIT_BROWSER_LIVE=1 JIT_BROWSER_EXECUTABLE=<installed-chromium> bun test tests/s15-browser-live.test.ts -t 'actual navigation|approved name' --timeout 60000`. Deterministic suite/package/typecheck results and tested head are recorded in the PR. General-browser product parity, physical guest-root isolation, crash/read-back on a real managed host and live account/device acceptance remain unproven here.

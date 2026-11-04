# S15 premium Web follow-up

Status: owner-approved presentation follow-up, 2026-11-04. This implements the approved premium mockup and motion direction in the existing opt-in S15 Web handler. It does not activate S15 on an installation, replace the S14 default, or change any product authority contract.

This follows the consolidated UX milestones [#338](https://github.com/chayapats/jit/issues/338) and [#339](https://github.com/chayapats/jit/issues/339), the [S15 experience handoff](S15-conversational-experience.md), [S15 spec](../specs/S15-conversational-autonomy.md) and [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md). FR/NFR identifiers and protected gates remain unchanged. Progressive enhancement follows [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md); browser restoration follows [ADR 0062](../adr/0062-s14-browser-navigation-and-drafts.md).

## Presentation and real bindings

| Approved experience | Production binding |
| --- | --- |
| Quiet navigation, owner message bubbles, Jit identity, result hierarchy and composer | Existing S15 server-rendered shell and CHAT projections; warm S14 palette, self-hosted fonts and shared scale tokens |
| Conversation, work, memory, resources, recovery and rules feel connected | Same-document GET navigation over fresh authorized HTML; ordinary links remain native fallbacks |
| Search in place | Current conversation titles and navigation labels, already authorized by the owner projection; `/search?q=` works without JavaScript |
| Return to a draft or reading position | Text-only browser-local drafts with existing credential screening and expiry; caret and scroll positions remain in tab memory |
| Result and evidence detail | `/library` reads current conversation results and recorded tool evidence; selected detail requires both conversation and request identity |
| Quote a result | Visible answer copied as `>`-prefixed data into the composer; native link prefills from a currently readable answer. Nothing is submitted by quoting |
| Exact action review in a centered modal | Every open, nested return and forward reads the server again; the existing complete slip and native protected POST forms are imported unchanged |
| Mobile composer | Responsive input sizing, intrinsic text-area growth, safe-area padding and visual viewport adjustment while the composer owns focus |

The result library is a bounded recent projection, not a new immutable artifact store. It reads the existing recent conversation list and bounded conversation views, displays up to 100 entries and up to 64 evidence rows per detail. It has no synthetic artifact hashes, artifact acceptance command, export promise or background execution. An item outside these windows is not claimed to be recoverable through the library.

The current S15 conversation command accepts text only. The attachment control explains that uploads are unavailable here; it does not select a file, store bytes or call the legacy project/topic upload boundary. Full composer uploads from the fixture need a separately scoped S15 ingestion contract. Existing exact action attachments retain their existing protected download route.

## Motion and state custody

- Shared motion tokens remain the source: 160 ms UI and 240 ms panel transitions. The reading region fades and moves a few pixels; the shell and composer stay outside its snapshots.
- Detail panels enter and return in place; closing restores focus to the opener. Opening an approval focuses its heading, never a decision. Browser Back/Forward re-reads detail HTML and does not restore cached authority controls.
- Owner refinement on 2026-11-04: exact action reviews are centered horizontally and vertically, with a restrained fade and scale. Narrow screens retain viewport gutters and scrolling for complete content.
- GET navigation is interruptible. The newest request wins; an aborted detail load cannot revive a dismissed panel. Forms retain the existing explicit POST lifecycle. A slow composer response cannot overwrite another conversation.
- `X-Jit-Enhanced: 1` negotiates HTML responses for new-chat GETs and explicit composer POSTs, with a server-owned `Content-Location`. It avoids a redirect round trip without changing authentication, CSRF, admission, idempotency or the native 303 fallback. Exact approval forms retain their native POST/redirect behavior.
- History contains destination URLs and panel depth only. It contains no HTML, action hash, revision, CSRF field, grant, input lease or approval. Only draft text and edit time enter local storage. Failed storage is visible and does not prevent navigation.
- An explicitly submitted composer with a pending or unknown receipt stays in tab memory. Returning to that conversation retains the original submitted form and idempotency key; it cannot turn the restored text into a second command. It is not persisted, never restored across sessions and never includes an action-approval form.
- A browser page-cache restoration reloads from the server. Sensitive connection inputs, protected browser takeover and active VM provisioning retain their native document lifecycle. Those views are not included in transition snapshots.
- Live `prefers-reduced-motion` changes cancel motion; missing View Transitions falls back to immediate updates. Motion never starts, retries, approves, dispatches, settles or claims completion of work.

Task receipt, execution intent, standing-policy scope, progress versus evidence, fact versus inference, waiting versus stalled, stopping versus settled, unknown-effect reconciliation, default versus personal GitHub rules and production gates continue to come from existing services and renderers. The current setup/computer projection still determines whether automatic single-host KVM provisioning or another supported setup path is available; this UI does not impose an owner-supplied VM step.

## Research provenance

The original `Jit-Premium-Experience-Research-2026-11-04` handoff and both approved fixture directories remain outside the repository and are preserved. Source IDs, original images and annotation links remain in those artifacts. The selected motion references are from the owner's [Mobbin collection](https://mobbin.com/collections/602d1058-2be4-4e6d-8d13-c34faad312d9):

| Recorded reference | Source ID and link | Applied principle |
| --- | --- | --- |
| Linear: Creating an issue | [b49200b2-cfac-4c16-aae9-55aecdb91d09](https://mobbin.com/flows/b49200b2-cfac-4c16-aae9-55aecdb91d09) | Keep creation close to its originating context |
| Linear: Issue details | [c3a5e094-420e-4732-bf9f-3c865dc8728f](https://mobbin.com/flows/c3a5e094-420e-4732-bf9f-3c865dc8728f) | Reversible detail depth with the underlying work retained |
| ChatGPT: Uploading files | [03c56987-d6ce-4097-a881-7ad4e67bdb4a](https://mobbin.com/flows/03c56987-d6ce-4097-a881-7ad4e67bdb4a) | Keep input state within the composer; upload behavior remains unavailable until an S15 port exists |
| Notion: Creating page | [6c9a76df-6890-432e-99f4-559e6fe5324b](https://mobbin.com/flows/6c9a76df-6890-432e-99f4-559e6fe5324b) | Continuous input context and restrained chrome |

These were inspected as static frames: they support layout and state-continuity observations, not measured easing or duration. Timing and interpolation are Jit presentation choices using existing tokens. The implementation also follows [Apple motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion) and [same-document View Transitions guidance](https://developer.chrome.com/docs/web-platform/view-transitions/same-document).

## Verification

- `bun run typecheck`
- `bun test --timeout 30000`
- `git diff --check`
- `JIT_S15_BROWSER_TESTS=1 bun test tests/s15-web-experience.browser.test.ts --timeout 30000`

The opt-in browser suite uses the production handler, hashed assets, real CHAT application and real protected POLICY service with deterministic scripted models and fixture effect adapters. Playwright intercepts all requests in process; no HTTP server or external destination is needed. Chrome is selected by `JIT_BROWSER_EXECUTABLE` or the local macOS Chrome path. Optional `JIT_S15_SCREENSHOTS` writes visual evidence to an operator-selected directory outside the tracked repository.

Coverage includes exact current revision/hash on detail return, one native approval dispatch, cancellation while reopening, latest-navigation wins, draft/caret recovery, blocked storage, missing View Transitions, live reduced motion, mobile width and typography, no-script search and quoting, current result access and no unsolicited commands or external requests. Existing tests retain policy, unknown outcomes, privacy, account and production-gate checks.

Live owner-host activation, Safari/iOS hardware keyboard behavior, paid model calls, real uploads, account connections and production effects are not certified by these local tests. No runtime selection, service composition, deployment, credentials or protected control-plane behavior is changed by this follow-up.

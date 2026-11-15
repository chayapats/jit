# s16-computer-browser/v1 — watched desktop browser

Slice 3a of ADR 0092 / #410. The host offers `computer_browser` only to execute work admitted to a running desktop
computer. Placement and SSH identity come from that work's VM session, not model input. Inspect work and headless
computers keep their existing file/shell tools. A private computer's browser observations retain that computer's scope.

## Closed operation union (3a)

- `{ kind: "state" }`: current generation and at most 100 opaque tab ids.
- `{ kind: "navigate", generation, tab?, url }`: public HTTP(S) URL, at most 4096 bytes.
- `{ kind: "read", generation, tab? }`: bounded page text and element observations.
- `{ kind: "find", generation, tab?, text }`: case-insensitive literal text matches, query at most 4096 bytes.

Unknown fields/kinds are refused. There is no model-supplied JS, selector, CDP command, cookie access, upload/download,
credential entry or screenshot. Input operations and human-required action cards ship separately in 3b; `needs_you`
and the trusted-site sign-in/resume flow ship in 3c. This slice does not close #442 or claim live guest evidence.

`state` returns `{ state: "ready", generation, truncated, tabs }`. Allowed tabs expose bounded URL/title; refused
tabs expose only opaque id, origin and refusal code. `navigate`/`read`/`find` return
`{ state: "observed", generation, tab, url, text, truncated, elements }`. Text, names and URLs are untrusted data,
never instructions. The JSON snapshot is at most 32 KiB. A fixed host observation program skips text in scripts,
editable fields and input/select/textarea nodes, never reads field values, and returns at most 100 element descriptors
with opaque ids. There are no remotely callable browser handles. Results are not written to browser history/memory
ledgers; ordinary publication remains guarded by the admitted work's resource/scope rules.

Every successful observation advances its generation. Stale generations and foreign/expired tab ids are refused with
`computer_browser_stale`. Stream loss, idle close, takeover and VM lifecycle invalidation clear tab observations and
advance the generation. A fresh `state` permits reconnection; no stream is reopened during owner control or fencing.
Without `tab`, operations select the run's last selected tab, or the first discovered page.

## Site policy

On every call the controller rereads the owner's website tier. Sensitive-only hosts refuse `website_sensitive_only`;
owner-approved sensitive-tier hosts (normalized hostname, regardless of scheme or port; any sensitive record wins) refuse `website_protected`. Use `protected_browser` for either. Trusted sites
and unapproved public sites are allowed. Non-public addresses, credentials in URLs and non-HTTP(S) schemes are refused;
`about:blank` is permitted as the browser's empty tab.

`navigate` checks its destination before opening a stream and live again immediately before `Page.navigate` after awaited setup. Every target is checked before dispatch and again before
returning text; redirects to refused sites return no page text. A refused tab's `state` projection contains no path,
title or text. The complete discovered target set determines liveness; only the returned projection is capped at 100 and marked truncated, so reordering an open tab past the cap does not invalidate its opaque id. Navigating away from a refused tab creates exactly one new tab and navigates there, leaving the
owner's old tab and half-filled form untouched. Reads/finds on the refused tab remain refused.

## Lifetimes and failures

Every call binds disclosure to the trusted work actor and its placed VM/session: `vmInput` stamps current work
ancestry before guest dispatch, and `vmOutput` imports persistent shared-VM ancestry before publication, including
sources acquired after session setup. A denied input sends no CDP; a denied output publishes no observation.

All operations hold ScreenControl agent tickets and recheck them and the live work guard around each CDP command.
Takeover closes the channel gracefully. The relay discards wholly unsent commands, completes any partial frame,
and acknowledges only after sent commands reply and sent navigations have stopped loading (`Page.stopLoading` reply). The host waits for that positive guest-drain acknowledgement,
not just rejected host promises, before releasing the agent ticket. Unproven settlement fails closed with
`computer_browser_unsettled`: the ticket stays held and owner input remains blocked. Generation transitions,
VM stop/restore/fence, run completion/cancel and shutdown close streams. A browser restart or five-minute idle close
permits a later fresh `state` to reopen. Other runs on the same VM refuse `computer_browser_busy` while a stream is held.

Each call has a 60 s deadline (`computer_browser_timeout`), each CDP command 15 s, the attach handshake 10 s.
Neither work-shell command/session timeout applies to this dedicated stream. The model tool wraps refusals as
`{ state: "denied", code }` with `isError`; unexpected transport errors are `computer_browser_unavailable`.
There is no autonomous retry of an operation whose outcome may be uncertain.

## Verification

`tests/s16-computer-browser.test.ts` exercises handshake parsing, split/coalesced frames, site rules, opaque generations,
read/find/navigate, redirects, bounding, one stream, idle/restart and takeover/deadline settlement using fake CDP. It also executes the unchanged observation program on a linkedom DOM fixture (test-only dependency) to check editable self/descendant text exclusion from both text and element names, and runs real disclosure-service ancestry/denial regressions.
`tests/s16-desktop-cdp.test.ts` runs the actual fixed Python programs against a fd3/fd4 stub child and tests binary
attach forwarding, live handshake, busy attach, disconnect/reconnect, stale replies, shutdown/restart/profile lock
and session upgrade without downloading Chrome. The SSH + sudo-rs live tests in that file are explicitly skipped
unless `JIT_DESKTOP_SSH_ENDPOINT` supplies the protected endpoint JSON (only key paths, never key bytes).
Live guest Chromium, trusted non-IdP sign-in and stop/start evidence belong to #431, not a claim made by these fixtures.

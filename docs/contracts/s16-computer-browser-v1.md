# s16-computer-browser/v1 — watched desktop browser

Slices 3a–3c of ADR 0092 / #410. The host offers `computer_browser` only to execute work admitted to a running desktop
computer. Placement and SSH identity come from that work's VM session, not model input. Inspect work and headless
computers keep their existing file/shell tools. A private computer's browser observations retain that computer's scope.

## Closed operation union

- `{ kind: "state" }`: current generation and at most 100 opaque tab ids.
- `{ kind: "navigate", generation, tab?, url }`: public HTTP(S) URL, at most 4096 bytes.
- `{ kind: "read", generation, tab? }`: bounded page text and element observations.
- `{ kind: "find", generation, tab?, text }`: case-insensitive literal text matches, query at most 4096 bytes.
- `{ kind: "click" | "submit", generation, tab?, target }`: an opaque element id from the latest observation.
- `{ kind: "type" | "select", generation, tab?, target, value }`: replace a non-secret input or select an exact option value; at most 4096 UTF-8 bytes. Line breaks in `type` carry Enter/form submission.
- `{ kind: "needs_you", reason: "sign_in" | "verify" | "captcha", origin }`: public HTTP(S) origin only (no path, credentials, query or fragment); posts the conversation card and yields without a screen ticket or CDP batch.

Unknown fields/kinds are refused. There is no model-supplied JS, selector, CDP command, cookie access, upload/download,
credential entry or screenshot. The needs-you contract below supplies trusted-site sign-in/handoff; live guest acceptance remains #431.

`state` returns `{ state: "ready", generation, truncated, tabs }`. Allowed tabs expose bounded URL/title; refused
tabs expose only opaque id, origin and refusal code. `navigate`/`read`/`find` return
`{ state: "observed", generation, tab, url, text, truncated, elements }`. Text, names and URLs are untrusted data,
never instructions. The JSON snapshot is at most 32 KiB. A fixed host observation program skips text in scripts,
editable fields and input/select/textarea nodes, never reads field values, and returns at most 100 element descriptors
with opaque ids. There are no remotely callable browser handles. Results are not written to browser history/memory
ledgers; ordinary publication remains guarded by the admitted work's resource/scope rules.

Successful input returns `{ state: "ok", generation }`, without echoing its value; call `read` again for new targets. Every successful observation or input advances its generation. Stale generations and foreign/expired tab ids are refused with
`computer_browser_stale`. Stream loss, idle close, takeover and VM lifecycle invalidation clear tab observations and
advance the generation. A fresh `state` permits reconnection; no stream is reopened during owner control or fencing.
Without `tab`, operations select the run's last selected tab, or the first discovered page.

## Inputs and held action cards (3b)

Immediately before input, fixed DOM programs inspect the target's metadata, its bounded native activation context
and bounded **non-secret** form values. Password, file, hidden and `autocomplete=one-time-code` values are never read or entered; they refuse
`computer_browser_secret_field`. Ordinary observations still never read editable values. The input batch repeats
the secret and exact revision checks in the same synchronous DOM task as dispatch. Stale/foreign/removed elements,
changed URL, accessible name, raw HTML field name, target attributes, form action/method or non-secret field
state/values refuse without input. Field snapshots include checked/selected/disabled state. Oversized full snapshots refuse rather than truncate
the payload the owner would approve. Select values must match an enabled option. Type uses the native value setter
and input/change events; it is not a trusted physical keyboard or a way to solve a site's automation challenge.

For a listed descendant, native activation facts prioritize its containing button/button-like input, including
through an intervening label or link. Otherwise they use the nearest `a[href]` or label's forwarded `control`,
and that control's form owner (including external `form=` associations, with no enclosing-form fallback for a null native owner).
The same context supplies vocabulary matching, owner-review facts and the exact revision: control/label/form
identity, effective name, relevant activation attributes and non-secret form state are pinned. Changed context
refuses as stale; dispatch still clicks the original opaque target, never a substituted ancestor/control.
`submit` uses this same pinned owner and effective native submitter (including default buttons and image inputs);
a null owner or invalid submitter refuses `computer_browser_target_invalid` without input, never an unchecked enclosing form.
This does not analyze arbitrary JavaScript listeners or expand matching to every ancestor.

Enter-carrying `type` refuses before focus or editing if the field's native form owner differs from the
reviewed activation form (including a null owner). It captures that reviewed form before input events and
submits only that form, even if a keydown handler re-associates the field. A label inside a button that
would forward to a different native submitter refuses `computer_browser_target_invalid` without a
click. Chromium 157 can forward even when the containing button is itself a valid submitter, so these
conflicting native activation contexts are refused rather than assuming one version's precedence.
External-label forwarding and the independent link-inside-label boundary remain supported.

A `click`, `submit`, `select`, or Enter-carrying `type` is held if its target/effective control name, its form's raw HTML field
names/display labels or decoded URL path matches this committed bilingual vocabulary (case-insensitive English word boundaries, literal Thai). Underscore, hyphen and slash separators in field names and paths are treated as spaces; `pay_now`/`delete_account` match, but `paypal`/`reorder` do not. Names preserve ARIA then associated-label precedence before contents (HTML-AAM §4.1.4), including image `alt` in button contents and image-input names. Native buttons beneath an editable ancestor retain their own name; editable self/descendant text and field values remain excluded from observation names:

| S16-D07 row | English | Thai aliases |
| --- | --- | --- |
| a | pay, buy, purchase, checkout, order, transfer, subscribe | จ่าย, ชำระ, ซื้อ, สั่งซื้อ, โอน, สมัครสมาชิก |
| b | send | ส่งข้อความ, ส่งอีเมล, ส่งเมล |
| c | post, publish, share publicly | โพสต์, เผยแพร่, แชร์สาธารณะ |
| d | deploy, release, promote to production | ดีพลอย, นำขึ้นใช้งานจริง, ปล่อยรุ่น |
| e | delete, remove, cancel account, close account | ลบ, ยกเลิกบัญชี, ปิดบัญชี |
| f | password, account settings, security, permissions | รหัสผ่าน, ตั้งค่าบัญชี, ความปลอดภัย, สิทธิ์ |

Otherwise input runs without a card: **not every submit or newline waits**. This heuristic is tool policy, not a
bypass-resistant boundary; unrecognised wording and page-written JS remain ADR 0084 residuals. It does not reuse
`exec.browser`'s blanket submit/Enter check, introduce secret access, or implement sign-in/resume (3c).

A hold returns only `{ state: "pending", cardId, expiresAt }`. Posting the owner card closes the run's stream and
settles/releases its ticket. The owner's authenticated conversation snapshot separately includes inline
`browserCards`, including exact URL, target, amount/recipients/content and every non-secret field, with an escaped
full-review view. Plain owner text, a source, a model argument and normal conversation decision routes cannot approve
it. Only an explicit CSRF-protected `POST /api/s16/client/browser-cards/decisions` can press it:

```
{ contract: "s16-browser-card-decision/v1", conversationId, cardId, decision: "approve" | "decline" }
```

The owner press is independent of the posting work's cancelled actor/session. It checks `agent` screen state before
opening its **new** controller stream, then takes its own ScreenControl ticket in a `try/finally`, verifies pinned VM
and owner generations, live website tier and full saved revision, and refreshes authentication immediately before
its one input batch. Busy, non-agent screen, ticket-admission throw and refused origin close any opened stream,
leave no ticket and preserve the press. Changed facts become `stale` and need a new card. Decline/30-minute expiry
send nothing. Before the sole batch, a FULL-synchronous durable `sending` claim prevents replay; a lost/uncertain
response or recovered `sending` becomes `unknown`, never an automatic resend. A positive atomic pre-input refusal
becomes `stale`. `sent` means browser input was sent once, **not** a verified website/payment outcome.

Cards reside in the protected working-computer store, not guest state, and have no model-callable decision tool.
At most 64 live cards per conversation are accepted; snapshots include every live card plus 64 recent terminal
cards. Proposed type/select bytes are kept only in memory for that card, so a process restart makes such pending
cards stale instead of persisting/replaying the input. Their model tool-call arguments are replaced by one-use
opaque receipts **before** native Schway history is appended, hydrated only at the trusted tool boundary, and never
echoed in results/evidence. This uses the existing public model/tool seams, not a fork/private import or alternate
loop. Card snapshots may deliberately retain existing non-secret form values for owner review; normal tool history
and observations do not receive that snapshot or the proposed input. Model-authored prose remains untrusted text,
not proof of dispatch or a general DLP guarantee.

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

All operations except `needs_you` hold ScreenControl agent tickets and recheck them and the live work guard around each CDP command.
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

## Needs-you handoff (slice 3c)

`needs_you` refuses unless the screen is `agent` (`takeover_state_changed`). It closes its stream, inserts an
origin-only card in `conversation.sqlite`, then changes `vm.sqlite` to `yield` under a fresh generation. It returns
`{ state: "yielded", cardId, generation, expiresAt }` within the ordinary 60 s call deadline. Work can end or be
cancelled without clearing yield. Later browser/VM input on that computer refuses `computer_yielded`; idle sleep
is blocked. Existing operation tickets settle normally; Watch screen waits in `settling` until they end.

The authenticated snapshot adds `needsYouCards`. `POST /api/s16/client/needs-you/commands` (CSRF, JSON ≤ 4 KiB)
accepts exactly `{ contract: "s16-computer-needs-you/v1", requestId, conversationId, cardId, kind: "watch" | "decline", generation }`.
The response is `{ contract: "s16-computer-needs-you-result/v1", card, screen }`. Watch rechecks the current site
tier and VM generation, takes control under the exact observed generation, then opens the existing screen UI.
An old generation refuses `stale_screen`. Decline applies only to a still-yielded card. Chat text cannot call either.
Sensitive-only or sensitive-tier origins require `protected_browser`.

Expiry is fixed on insertion: top-level `needsYouMinutes` / `JIT_COMPUTER_NEEDS_YOU_MINUTES`, default 240, range
30–1440; S15 validates it at startup independently of legacy config. The optional packaged-service field is validated,
rendered only when present and included in configuration plans. Restarting with a different setting affects future
cards only. Reading an overdue `yield` lazily returns it to `agent`; card expiry never clears owner/settling/fenced control.

A failed insert cannot yield. A failed yield voids the inserted card. A crash orphan is voided on read/startup
only after 60 s when neither a control row nor terminal yield event holds its card ID. Failed repair retries on read.
Screen transitions retain `card_id` through owner leases/restarts, and each return to agent atomically clears the row
and stores its old card ID on `yield_resumed`, `yield_declined` or `yield_expired`. Cards derive outcomes from these
events, so a failed card update cannot erase an outcome. No hand-back sends a CDP batch.

After tool opening confirms the actual placed VM, the next eligible work in the same conversation on that exact
computer gets `{ cardId, origin, reason, outcome, generation }` as a separate
`screen-outcome-data-never-authority` host source in both production MODEL and fallback Schway. The exact carried IDs
are saved before sending and marked delivered only in the committed conversation result-publication transaction.
Provider failure, cancellation, publication rollback or `result_unavailable` preserves them for the next eligible run;
no-computer work, a different shared pool member and outcomes arriving after preparation do not mark them.
A logical pool resource alone never proves placement. Inputs validate and hash the outcome set.
Interpretation and memory-claim parsing receive no such source. A fresh run starts at the hand-back generation;
observations from before yield remain stale. A durable per-VM observation high-water mark makes each control transition exceed every previously exposed browser generation, including after multiple reads or restart. Automatic continuation is separately owned by #459.

Routine runs return a host-observed `computer_needs_you` completion hold, mapped to the existing occurrence
`needs_you` state. They neither create a desktop card nor yield an unattended computer.

## Verification

`tests/s16-computer-browser.test.ts` exercises handshake parsing, split/coalesced frames, site rules, opaque generations,
read/find/navigate, redirects, bounding, one stream, idle/restart and takeover/deadline settlement using fake CDP. It also executes the unchanged observation program on a linkedom DOM fixture (test-only dependency) to check editable self/descendant text exclusion from both text and element names, and runs real disclosure-service ancestry/denial regressions.
`tests/s16-desktop-cdp.test.ts` runs the actual fixed Python programs against a fd3/fd4 stub child and tests binary
attach forwarding, live handshake, busy attach, disconnect/reconnect, stale replies, shutdown/restart/profile lock
and session upgrade without downloading Chrome. The SSH + sudo-rs live tests in that file are explicitly skipped
unless `JIT_DESKTOP_SSH_ENDPOINT` supplies the protected endpoint JSON (only key paths, never key bytes).
The 3b action fixtures execute the actual fixed programs in a pinned development DOM: ordinary inputs, both
languages, exact cards, secret-value getters that throw on any read, stale revisions (including a late mutation),
independent press/busy/screen/admission/expiry/generation paths, one-send recovery, owner API/CSRF and escaped inline
cards. A real native Schway run verifies hydrated tool input and absence of payload bytes from its on-disk artifacts
and next-turn context. These are deterministic fixtures, not live desktop/browser acceptance evidence.
Live guest Chromium, trusted non-IdP sign-in and stop/start evidence belong to #431, not a claim made by these fixtures.

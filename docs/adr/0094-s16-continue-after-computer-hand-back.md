---
status: scoped implementation for CONT16-01 (#459); owner outcome confirmed by the issue; review and required CI pending
date: 2026-11-18
scope: CONT16-01 (#459); S16-AC06/AC07/AC11; FR-10/14/15/35/38/40; NFR-07/14
---

# Continue the existing work after a computer hand-back

## Confirmed target and retained boundaries

The owner requests an automatic Bot run after handing back a `needs_you` takeover (#459). There is at most one
automatic continuation per card, no routine continuation, and the run uses ADR 0092's existing outcome source.
The owner need not send another message after signing in. Hand-back is a scheduling trigger, not approval of an
effect or permission to change the original task. S16-D07 and the current standing policy still decide every action.

ADR 0092 / PR #463 supplies durable origin-only cards, exact screen outcomes, actual-VM-scoped outcome delivery and
publication-only delivery marks. Jit already owns durable CHAT requests, work authority, VM attempts and MODEL step
identities. Schway owns each execution loop, retries and native session; Jit must not replay a claimed loop/tool call.

## Alternatives and selected engineering choices

1. Reopen the old native session or replay its claimed request. Rejected: the previous run may already have ended
   or have an uncertain claim, and another request cannot certify native/tool settlement.
2. Submit a synthetic owner message and admit unrelated new work. Rejected: a new work identity loses the original
   workspace affinity, can select a different computer/model, resets per-work allowances and misrepresents the owner.
3. Continue the existing Jit work through a fresh CHAT request, VM session and public MODEL step. Chosen: retain
   the original authority, computer/workspace affinity, model pin, disclosure ancestry and finite charged allowance;
   only the execution attempt and receipt are new. This uses the current Jit services and Schway public surface.

The Rakazo-style outcome is continuity after human control. Importing another continuation worker/authority stack
is unnecessary for that outcome and would require a replacement/state-preservation contract. No upstream runtime,
source, asset or dependency is imported by this choice.

## Contract

1. **Trigger.** Only the durable `yield_resumed` event creates eligibility. Decline and expiry do not request another
   run. An ordinary screen hand-back with no needs-you card creates none. The existing S15 scheduler scans the
   protected events/cards on boot and each wake, even while another conversation keeps the shared drain active; successful owner hand-back also wakes it. Events remain eligible
   across a process loss before scheduling. No model, guest, page, typed reply or notification invokes this ingress.
2. **One durable binding.** An additive conversation-store record binds one card ID to one deterministic continuation
   request ID, source request and original work/root. The binding and CHAT request commit in the same conversation
   transaction. A retry/restart re-registers only a saved queued request with the same binding; completed, held,
   stopped, running-at-crash or otherwise claimed work is never submitted again. Unfinished bindings are not evicted.
3. **Existing authority.** Protected `s16-computer-continuation/v1` metadata identifies the source card/request and
   original task. It is not accepted on the public message API. The continuation keeps the original work ID,
   policy revision, purpose, resources, route/model pin and frozen intent. It does not run another interpretation or
   mint owner authority. Current owner generation, original work/policy, Bot/private scope, source binding and
   parent/delegation restrictions are guarded before admission, every send/tool and publication. An explicit stop,
   withdrawn authority, changed owner or uncertain prior claim prevents execution and remains visible.
4. **Finite budget.** Existing POLICY/MODEL per-work reservations and unknown usage remain charged to the same work.
   CHAT also narrows the new attempt's ceilings to the original task's remaining model/tool allowance, including
   earlier continuation attempts. A new receipt cannot reset or increase a budget. Exhaustion is an honest hold.
   A delegated continuation retains its original parent/slice and runs only while that authority is current; routines
   use their existing occurrence `needs_you` state and never enter this path.
5. **Fresh sessions, persistent state.** `WorkingVmService.openAttempt` creates a fresh session ID/unit and operation
   claims while retaining the original `chat_<workId>` workspace key. The MODEL step ID is domain-separated by the
   continuation receipt/card; earlier loop/tool/session claims remain untouched. The original work's durable pool affinity keeps the browser
   session and workspace on the card's computer, even if another shared member is less loaded. An unavailable/full
   original computer holds the attempt rather than falling back. A changed Bot setting affects new work, not this
   existing work's pin. File receipts retain their original ingress/memory semantics and are rechecked for withdrawal.
6. **Context.** The fresh execution step receives the original task and bounded, labelled prior work evidence so it
   can inspect progress without replaying old calls or trusting a model claim of success. This is data, not authority
   or parsed memory claims. The screen outcome remains solely in `screen-outcome-data-never-authority`; it is selected
   after actual placement and marked only in committed result publication, as in ADR 0092. Source bytes participate
   in MODEL input validation/hash. The newest eight prior requests are ordered deliberately, with the posting source
   last; the bounded byte budget favors their newest observations. Interpretation context is unchanged. Unknown effects require reconciliation.
7. **Serialization and existing progress.** A posting run still running is allowed to finish before a continuation
   starts. Only a live run or a queued request with a process-local authenticated owner blocks that conversation;
   an ordinary stranded queue after restart is not runnable and cannot keep an unrelated original task pending forever. Another run already carrying the same outcome is observed to settlement before another automatic run is
   considered. A committed run that already carried it can cover the binding, avoiding duplicate work; this records
   an existing continuation, not a claim that the original task is complete. A failed/held/unknown such attempt
   remains attention rather than becoming an outer provider/effect retry loop. One conversation continues to run
   only one request at a time. No pending job holds a VM/native session while waiting.
8. **Owner experience.** The card projects actual pending/queued/running/completed/held/stopped/covered/unknown
   continuation facts and the linked request. It does not promise success before publication. The transcript labels
   this as continuation of the existing task, not a new owner message. Model usage maps the exact work and MODEL
   step to its receipt, so sharing the work cannot attribute all earlier usage to the latest request. English/Thai,
   keyboard focus, mobile layout and session-loss withholding use the existing shared client.

## Migration and compatibility

Only additive protected metadata/bindings are needed. Existing cards can become eligible from their terminal
events; delivered/claimed ones are coalesced or held according to the rules above. Old clients ignore additive
projections. The S14 default, S15 opt-in, standing policy, historical private scope and protected-host boundary do not
change. Disabling the relevant computer service must leave retained continuations inert and must not erase/replay
their identities. Real guest/account/device acceptance and owner-host adoption remain #431 and separate cutover gates.

## Required conformance evidence

Use scripted models, protocol fixtures, fake clocks and barriers to prove:

- Real `computer_browser` needs-you → owner takeover/login/hand-back → automatic execution/result with no owner
  `continue` message; the actual MODEL request carries ADR 0092's outcome and fresh generation.
- Two shared members: automatic work keeps the signed-in member/workspace despite load/drain; another member
  cannot consume its outcome. Work prepared before the outcome cannot mark it.
- Source run finishing after a quick hand-back; same-event duplicates; crash before scheduling, between binding
  and request commit, after queue commit and after model/tool claim. No duplicate loop, tool, effect or result.
- No continuation on ordinary takeover, decline, expiry, routine, explicit stop, changed owner, revoked scope,
  archived/private-mismatched Bot, exhausted allowance or uncertain claims; holds/results reflect actual facts.
- Shared logical-task budgets and model pin survive multiple handoffs; previous workspace edits/file semantics
  remain available without silently rewriting original/private state. Withdrawn files and new private recipients
  retain their existing fences; hand-back approves no payment, credential change or other human-required action.
- Current-run/other-run coalescing and failed publication preserve the exact outcome delivery set. Production and
  fallback paths, per-receipt usage attribution, restart recovery and actual English/Thai client flows all conform.

Run affected suites, typecheck, provenance checks and full required CI on the final head. Record actual native
browser fixture evidence separately from guest Chromium/SSH/sudo, subscription, physical-device and live-host proof.

## Local conformance record

The deterministic continuation suite covers automatic production and fallback execution, the original work/workspace
and finite allowance, per-step receipt usage, two-computer affinity, quick hand-back, duplicate events, queued and
claimed-state restart recovery, coalescing, stop/revocation/owner/budget/unknown fences, memory forget before/during/after
the run, queue/publication rollback and refusal of public continuation forgery. Restart tests reopen persisted
journals and explicitly seed an interrupted claim; they do not claim a physical guest/process power-loss test.
The native Chromium English/Thai fixture exercises keyboard takeover, a real password form and cookie reload,
automatic continuation without another owner message, host-labelled transcript, focus restoration, mobile width
and authentication-loss withholding, including opening a retained continuation after 34 newer requests. Guest operations and MODEL are fixtures; no live account, subscription, real
SSH/sudo or owner-host adoption is certified. ADR 0092's separate delivery suite isolates the CONT16 scheduler to
continue testing ordinary next-run delivery and publication rollback. Required final-head CI/review evidence belongs
in the implementation PR.

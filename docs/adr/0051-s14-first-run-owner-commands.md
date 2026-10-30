---
status: accepted
scope: UX14-01 (#265) logic only; FR-01/19/22/23/25, NFR-11/12, S14-AC01/13
---

# S14 first-owner Web bootstrap and explicit recovery commands

## Confirmed scope

Owner orchestration requires reuse of ADR 0042's legacy setup capability with security no weaker than legacy, public `schway/host` device sign-in and provider-derived routes, default browser refusal before legacy writes/workers, typed task/conversation/preference/unpin/recovery/lease commands and safe observed computer activity. UI/UX remains the subsequent Claude Opus 5.5 high-effort agent's work. This ADR records implementation choices inside that scope, not new authority or default-runtime cutover.

## Engineering choices

Generalize only the setup helper's TypeScript store parameter to its path/transaction interface. Preserve its actual randomness, hashed 0600 sibling file, expiry, owner fence and writer serialization unchanged. The clean form moves the capability out of the URL and binds CSRF as in legacy; Argon2id creation rechecks after hashing. Trusted installer issuance is separate from unauthenticated HTTP. Keep the installer/service's legacy default until explicit cutover; an S14 installer must call that helper with the selected S14 store.

Reuse `DeviceSignIns` rather than a second protocol manager. Reserve one safe receipt and increment installation revision before external start; each credential write retains the initiating owner's live-session fence. Approval data is only an initial response value. Provider metadata comes from host capabilities and existing recommended-model logic; a separate local readiness query supplies the account state. An optional exact deployment route override remains explicit, with no route/model/account/billing fallback. Sign-in never starts inference or execution on the owner's behalf.

Owner commands use existing transactional receipts/audit and exact revisions. Conversation creation references an enabled Bot revision and does not change its authority. Preferences use the installation revision and explicit language/theme enums. Rejection retains proposed work with no grant. Unpin keeps a revisioned tombstone/source so a stale revision-zero set cannot recreate the decision. Live packet checks exclude the tombstone and fence prior pinned contexts.

Recovery consumes the original unchanged live grant and remaining reservations. It refuses unsettled/interrupted native calls and held/unknown effects. Retry queues a new bounded internal attempt; it never resubmits an external effect. Evidence-only synthesis has zero tools, retains exact current source refs and selects a bounded amount owned by the grant's first Bot. This avoids inventing cross-Bot citation/report contracts while #251/#252 are being implemented. The trusted scheduler must honor `Work.recovery` mode and source pins. No budget is refunded/extended or route changed.

Owner renewal increments both input/computer revisions under current live authority and caps expiry by idleMs and grant expiry. It fences old inputs and may restart an expired owner lease only while the computer is still running; it cannot restart a stopped process or approve effects. The existing per-computer dispatch mutex remains unchanged.

Record only service-observed event categories/time, retaining 200 per computer. Page identity is process-local and only the observed built-in `about:blank` is exposed, labelled untrusted. Arbitrary target titles/URLs are withheld because they can contain typed secrets. No browser extraction or new website authority is added. Existing owner-selected Bot resource ceilings survive production composition; a read-only query lists existing current receiver memory shares. Source/artifact resource creation and snapshot sharing lack a durable owner-policy source in this base and remain #253 rather than competing schemas.

Schema 7 adds only computer_activity and its index. Previous unreleased S14 schemas refuse unchanged before writable open; no automatic migration is introduced. Default S14 serve retains a read-only refusal listener; `--no-refusal-page` preserves CLI exit. Legacy runtime/store remain untouched.

## Evidence and limits

Deterministic fake secure-store/device protocols, scripted inference, fake clocks and isolated runtime fixtures cover fresh setup through first reply, receipts/stale/replay, authority/source/budget fences, lease renewal/activity and byte-preserving refusal. Full suite/typecheck/diff checks accompany the PR. Actual provider sign-in/inference, Linux container/browser behavior, completed Opus UI and real-device/no-script accessibility acceptance are not inferred from these fixtures. The PR remains draft for the UI handoff.


## 2026-10-31 remaining-gap implementation

Foreground `serve --s14` uses the unchanged capability helper only when stdin/stdout are TTYs and writes directly once to that terminal, outside logging. Service/installer issuance is the trusted local `owner-link --s14 --output-fd 3` command: a dedicated inherited private pipe, no plaintext file or stdout/stderr/log delivery, no runtime host/worker/lock, and the selected store's writer transaction. This permits issuance alongside the running service without relaxing its runtime singleton. CUT14-01 owns installer invocation and terminal delivery; the current default remains legacy.

Owner-only memory inspection returns unpinned tombstones for exact-revision repinning while packets still exclude them. S14 busy device receipts may include only a safe currentFlowId for the existing authenticated cancel command. Chat failures retain a finite public category from Schway safe auth status or the application deadline; raw errors and unclassified failures stay unknown. Existing Opus patterns/copy render these seams; no new screen is introduced.

F4 evidence-only synthesis on stopped work is not delivered: stop revokes the original grant and increments its generation. The existing summarize admission therefore has no still-valid inference authority, and neither unrevoking it nor ignoring the stopped fence is acceptable. A future explicit owner-authorized report grant over exact current evidence must be separate from resuming that work. Committed evidence remains available; stopped work, late publication and old attempts remain fenced.

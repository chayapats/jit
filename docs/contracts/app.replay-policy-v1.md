# app.replay-policy/v1

REC14-01 (#254); FR-14/15/16/18/35/37; NFR-02/05/08/10. `src/s14/replay-policy.ts` exports `replayPolicy(attempt):{replay:ReplayClass,handlerVersion:string}` and `checkpointFingerprint(attempt,graph):string`. The registry is trusted TypeScript, never an HTTP/model/plugin-install surface. See app.work-checkpoints/v1 for checkpoint, native, owner-resolution and HTTP shapes.

| Trusted handler/tools | Version | Replay class |
| --- | --- | --- |
| research, tools subset of web_search/web_fetch (including tool-free) | research-read/v1 | replay_safe |
| synthesis, tools empty under graph validation | synthesis/v1 | replay_safe |
| Any computer/core shell/workspace capability | registered handler version | never_auto |
| Unknown handler, unknown tool or any effect tool | unregistered/v1 or registered version | reconcile_only |

Handler version and exact immutable admission/graph fingerprint are pinned before dispatch and compared at boot. A model plan, tool description, arbitrary shell instruction, readOnlyHint or source text cannot alter classification. Unknown defaults to reconcile_only. Public reads remain bounded service-owned requests under current outbound/privacy/budget guards, not general browser or shell access.

Automatic requeue requires the same live owner/grant generation, enabled Bot/config/capabilities, exact route/model, resource/share snapshot and original source/access/decision revisions; unchanged graph/input and registry version; settled old native transport; no stopped lane/grant or unknown effect; and remaining attempts/steps/calls/output/read/time ceilings. Conservative reservations survive uncertainty and stale application-image restore. No budget is renewed by discovery, cleanup or restart. Known committed results survive rather than repeat. Interrupted tool-free chat is deliberately never auto-replayed. A known returned handler failure remains finished; reboot is not a retry command. Cooperative shutdown/deadline cancellation is re-evaluated under the original expiry and budgets.

Eligible requeue creates a fresh attempt and native context with a new request identity and full new reservations. Old authority remains fenced, including late commit/finalizer callbacks. Pending unadmitted siblings can proceed only under their current grant; unknown-effect work remains waiting. Failed/blocked siblings retain explicit gaps and do not erase independently committed evidence. Missing app checkpoints cannot be reconstructed from native metadata or model intent.

No production external performer or verified remote read-back/idempotency adapter is installed. Unknown effects stay reconcile-only, including after the owner's separately labelled statement. Resolving records a stated outcome and never authorizes or performs a retry. Remote verification and live/paid effect evidence are unrun/out of scope; exact owner receipt idempotency and no-send/read-back refusal fixtures are deterministic.

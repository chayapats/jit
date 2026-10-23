# Team dispatch, v1

Owner: Jit #11 (TEAM02). Contract: `app.team_dispatch/v1`. Implementation: `src/team/dispatch.ts`, `src/team/router.ts`, `src/team/types.ts`, `Application`, Web topic/discussion routes. Requires `app.run_port/v1`, `app.role_configuration/v1`, `app.conversation/v1`, `app.source_records/v1`, `jobs.queue_admission/v1` and `jobs.attempt_fence/v1` in the integration base. FR-01/02/10/13/14/15/17/18, NFR-01/02/05/07/10. Coordinator synthesis and owner decisions remain out of scope (TEAM03/TASK).

## Exact public surface

```ts
type TeamCommand =
  | { kind: "team.dispatch"; requestId: string; projectId: string; expectedRevision: number;
      payload: { topicId: string; purpose: string; sources: SourceReference[];
        include: string[]; exclude: string[]; limits: JobLimits } }
  | { kind: "team.control"; requestId: string; projectId: string; expectedRevision: number;
      payload: { discussionId: string; action: "include" | "exclude" | "skip" | "stop"; roleId: string } }
  // plus TEAM01 role.save / route.save / role.preview

interface Discussion { kind: "discussion"; id; projectId; topicId; purpose; jobId;
  revision; createdAt; updatedAt; manifest; limits; router; participations; coverageGap }
// MEM02: manifest also carries assembled claims and manifest.context (app.memory_context/v1)

Application.execute(actor, TeamCommand): TeamReceipt; // discussion?: Discussion
Application.discussions(actor, projectId, topicId): Discussion[];
Application.discussion(actor, projectId, discussionId): { project; discussion };
```

`team.dispatch` uses the project aggregate revision. `team.control` uses the discussion revision. Both share APP01/02 opaque actor, CSRF/Origin (HTTP), global request-ID receipts and single-writer rollback. Replay returns the original receipt before stale-revision checks. Model/source text never becomes a command.

## Behavior

One owner-authorized purpose plus frozen source snapshot creates exactly one logical discussion. The scripted router selects only enabled, route-configured specialists under finite `JobLimits` (roles/calls/rounds/hops/context/output/retries/wall). It need not call every role or provider. Include/exclude are owner lists validated against configured specialists; unknown, disabled, unconfigured or coordinator identities reject. Router rounds stop visibly at `max_rounds` or role budget exhaustion. Agent/router output cannot recurse into unbounded peer debate or re-dispatch.

Selected roles receive independent interactive `jobs.queue_admission` jobs (`team.specialist-analysis`) and independent managed contexts via `app.run_port`. A bookkeeping `team.discussion` job records the plan without synthesis. Peer outputs are never injected as trusted operator instructions or shared native sessions. Progress observations are provisional until an attempt-fenced app commit publishes attributed output through `app.source_records` + topic messages. Refresh/GET paths only project persisted state and never admit work.

Owner `include` / `exclude` / `skip` / `stop` mutate participation without creating conversations on role disable alone. Stop/exclude uses `jobs.attempt_fence` / `job.stop`; late results after fence cannot change group messages. Quota/login/route waits stay on the original route with `wait_on_original_route`; no billing/provider fallback. Partial failures surface in `coverageGap` beside committed analyses.

## HTTP

| Route | Behavior |
| --- | --- |
| `POST /[api/]projects/PROJECT/team/discussions` | `team.dispatch` fields + receipt/revision; form encodes sources/include/exclude/limits as JSON strings |
| `GET /[api/]projects/PROJECT/team/discussions/ID` | Projected discussion; HTML shows controls and provisional progress |
| `POST /[api/]projects/PROJECT/team/discussions/ID/controls` | `action` + `roleId` + discussion `expectedRevision` |
| Topic HTML | Optional dispatch panel; GET never relaunches analysis |

Deterministic evidence: `tests/team.test.ts` (TEAM02 cases) with scripted adapters, fake clocks and no paid APIs. Exact artifact signatures are those exported above plus [specialist results](specialist-results-v1.md) and [run records](run-records-v1.md).

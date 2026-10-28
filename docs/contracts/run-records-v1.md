# Run records, v1

Owner: Jit #11 (TEAM02). Contract: `app.run_records/v1`. Persistence uses existing schema v4/v5 `team_runs` / `team_contexts` rows (JSON `kind` discriminant) plus JOB02 attempts. No native Schway session format is claimed.

| Record | `kind` | Identity |
| --- | --- | --- |
| Discussion | `discussion` | Discussion UUID; bookkeeping job; frozen `manifest`; router evidence; participations |
| Specialist run | `specialist` | Run UUID; `discussionId`; immutable `ApplicationRunRequest`; optional provisional `progress`; outcome/source |
| Preview (TEAM01) | absent / legacy | Unchanged `RolePreview` shape without `kind` |

Each specialist run owns one managed context generation and one job. Requests capture exact route, configuration revisions, fence, trusted operator/responsibility strings, untrusted manifest and restrictive policy (`genericExecution`/`arbitraryFetch`/`hostedLookup`/`repositoryDiscovery` all false; tools empty). Scripted port retains the last 32 invocation snapshots for leakage inspection: distinct context IDs, identical frozen manifest text across peers, and no peer output inside trusted instructions.

Provisional progress may be persisted on the specialist record while `provisional: true` and must not appear as committed conversation messages. Queries (`Application.discussion`, GET discussion/topic) read these records without invoking `pump` or creating jobs. Retirement/delete and attempt inspection remain on `app.run_port/v1` / `jobs.attempt_fence/v1` / `jobs.session_reconcile/v1`.

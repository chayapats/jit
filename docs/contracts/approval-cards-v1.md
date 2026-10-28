# EXE07 approval cards, effect tools and the effect executor, v1

Owner: Jit #133 (S11 EXE07). Status: implemented on the issue branch. Decision: [ADR 0037](../adr/0037-access-levels-approvals-and-connections.md) § Effect tools and approval cards. Spec: [S11](../specs/S11-execution-access-and-tools.md) (S11-D03, D08; S11-AC05, AC06, AC09). Requirements: FR-37, FR-38, FR-35, FR-17, FR-15, NFR-05, NFR-07, NFR-14.

Uses `exec.run_tools/v1` (EXE05), `app.connections/v1` (EXE08), `app.access_level/v1` and `jobs.attempt_fence/v1`. The Web card UI is EXE09, the Telegram card UI EXE10.

## `app.effect_tools/v1`

`src/exec/effect-tools.ts`. Admitted only to a run whose frozen grant is `full` and whose port has the effect executor; below `full` a call settles as `Unknown tool: effect_…`. Each call is fenced and audited like the core tools (`execution_tool_calls`, subject = remote or target).

| Tool | Card kind | Pinned action |
| --- | --- | --- |
| `effect_git_push { remote, repository?, branches[1..8] { branch, source?, oldSha? } }` | `effect.git_push` | The owner remote (name, URL, revision), the repository directory, every update `refs/heads/<branch>: <oldSha> → <newSha>` with full SHAs read from the box now (`oldSha` from the box's `refs/remotes/<remote>/<branch>` unless given; `"new"` creates the branch) and up to 20 commit summaries. |
| `effect_github_pr_create { remote, base, head, title, body?, draft? }` | `effect.github_pr_create` | The remote and its GitHub repository and API base, plus the request body. |
| `effect_github_comment { remote, issueNumber, body }` | `effect.github_comment` | Same, the issue number and body. |
| `effect_github_pr_merge { remote, pullNumber, headSha, method? }` | `effect.github_pr_merge` | Same, the pull number, the head SHA the merge must match and the method. |
| `effect_deploy { target, ref? }` | `effect.deploy` | The owner deploy target (name, URL, revision) and the ref. |

A call never performs the effect. It inserts a card — only while the run's attempt is still current (`executionCurrent`, checked in the card's own transaction), so a run stopped or fenced during its SHA reads creates no card and starts no auto-approved effect — and returns `{ state: "pending_approval", cardId, kind, digest, expiresAt }` (or `approved` when an auto-approve rule decided it). Box reads for a push run git with hooks and fsmonitor disabled; their output is accepted only as full SHAs.

## `app.approval_cards/v1`

`src/exec/approval-cards.ts`; schema 37 `approval_cards(id, project_id, topic_id, run_id, job_id, role_id, kind, action_json, digest, revision, state, reason, decision_json, receipt_json, telegram_eligible, created_at, expires_at, updated_at, started_at)`.

- `action_json` is the canonical (sorted-key) action and `digest` its SHA-256. Cards expire after 30 minutes. States: `pending`, `denied`, `expired`, `executing`, `succeeded`, `failed`, `unknown` (`approved` is reserved; approval goes straight to `executing`).
- `telegramEligible` is true for a single action (a push with one ref, every other kind).
- **`approval.decide { cardId, digest, decision: "approve" | "deny" }`**, `expectedRevision` = card revision, through `Application.execute` with a receipt and audit row. Web may decide any card, Telegram only an eligible one; the local API never (`approval_requires_web`, 403). A used card is `approval_card_not_pending`, an expired one `approval_card_expired`, a wrong revision `stale_revision`, a wrong digest `approval_digest_mismatch`. Approval needs the proposing role to still have `full` in an unhalted project (`access_level_insufficient`, `execution_halted`) and an effect executor (`effects_not_configured`). Approval moves the card to `executing` in the receipt's transaction; the executor runs it after commit. A replayed request returns the first receipt and runs nothing.
- Read API: `Application.approvalCards(actor, projectId, { state?, limit? })`, `approvalCard(actor, projectId, cardId)` (a pending card past its expiry reads `expired`, and the `state` filter follows that view); a decision first records the expiry of every card past its deadline, `effectSettings(actor, projectId)`.

## Effect targets and `app.auto_approve/v1` (Web only)

- `effect.target.set { target: "git_remote", name, url, github: { owner, repo, apiBase } | null, connectionId }` and `{ target: "deploy", name, url, connectionId }`, `effect.target.remove { target, name }`, revisioned per name in `git_remotes` and `deploy_targets`. URLs are https without credentials, query or fragment. A git remote needs a `github_token` connection and a deploy target a `deploy_secret` (`effect_connection_kind_mismatch`), in scope for the project.
- `approval.rule.set { effectKind, scope, enabled }`, revisioned per effect kind in `auto_approve_rules`. Scopes match exact names: `{ remote, branches[] }` for pushes (every pushed branch must be listed), `{ remote }` for GitHub effects, `{ target }` for deploys. A matching enabled rule decides a new card `approve` with `channel: "auto-rule"` and the rule revision.
- Telegram and the local API are refused for both (`approval_rule_requires_web`, 403).

## Effect executor

`src/exec/effect-executor.ts`, outside every box.

1. **Claim** (one transaction): the card must be `executing` and unstarted; the role must still have `full` (else `failed/access_changed`) and the pinned remote or target must be at its pinned revision and URL (else `failed/target_changed`); the connection is released for `effect:<cardId>` (audited); `started_at` is set.
2. **Effect.**
   - `effect.git_push`: in the box, with hooks and fsmonitor disabled, temporary refs `refs/jit-effect/<cardId>/<i>` name the approved SHAs and `git bundle create` writes them to `/workspace/.jit-effects/<cardId>.bundle` (a SHA the box lost fails `stale`); the bundle is copied out (≤ 256 MiB) and deleted. On the host, with no system or global config, an empty private home and `core.hooksPath=/dev/null`: `git bundle verify`, `git bundle list-heads` must contain every approved `<newSha>` (else `stale`), the refs are fetched into `<execution.directory>/<projectId>/mirror.git` (config rewritten to a fixed bare config, hooks removed, only the file transport allowed), then `git push --porcelain --atomic --no-verify <pinned url> --force-with-lease=refs/heads/<b>:<oldSha|empty> <newSha>:refs/heads/<b>` with only https allowed, `GIT_ASKPASS` and the token in the push's own environment. Exit 0 is `succeeded`; a rejection is `failed` (`lease_rejected` when the remote moved, `push_rejected` otherwise); anything else is `unknown/push_unconfirmed`.
   - GitHub: `POST /repos/{o}/{r}/pulls`, `POST /repos/{o}/{r}/issues/{n}/comments`, `PUT /repos/{o}/{r}/pulls/{n}/merge { sha, merge_method }` on the remote's API base with `Authorization: Bearer`, redirects refused. The expected status is success; `409` on merge is `stale`; another status is `failed/http_<status>`; a transport error is `unknown`.
   - Deploy: `POST` to the target URL with `{ projectId, target, ref, cardId }` and `Authorization: Bearer`.
   - Every external step re-checks `full` and the halt right before it starts (for a push, after the bundle reached the mirror and before the credential is used: `failed/access_changed`). An access command aborts the host work of in-flight effects whose role lost `full` (the outcome is then `unknown`); a service drain claims nothing more, aborts in-flight effects and waits for them within its deadline (`unknown` otherwise).
3. **Outcome**: the card state with a credential-free receipt (endpoint, status, refs, picked fields), and a `jit-effects` service source and message in the card's topic, in the owner's language.

Boot reconciliation (`Application.boot`): a started `executing` card becomes `unknown/interrupted` and an unstarted one `failed/interrupted_before_start`; both are posted to the topic. Nothing is retried.

## Evidence

`tests/approval-cards.test.ts` (state machine, digest and revision mismatch, expiry on a fake clock, replay, auto-approve, channel rules, level and halt, crash → unknown) and `tests/effect-executor.test.ts` (git bundle path against a local bare remote, a commit added after the card, a lost SHA → stale, a moved remote → lease rejection, a new branch, the malicious hook/config fixture, the bundle fetch without the test seam, GitHub REST through protocol fixtures, crash → unknown).

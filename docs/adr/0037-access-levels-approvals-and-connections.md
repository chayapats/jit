---
status: accepted
scope: S11 authority engineering choices; extends ADRs 0010, 0012, 0013, 0015 and 0030
---

# Access levels, kill switch, approval cards, effect tools and connections

S11-D02, D03, D08 and D09 give a project execution power without moving authority off the owner. Model output, retrieved content, MCP results and web pages never widen anything. This is FR-17, and S10-D02's restrict-only rule.

## Selected implementation

### Access levels and the kill switch

- `project_access_revisions(project_id, revision, level, channel, created_at)` is an append-only table. The levels are `read`, `workspace` and `full`. Revision 0 is `read`.
- `role_access_overrides(project_id, role_id, revision, level)` lets a specialist be set lower than its project.
- The effective level is the minimum of the project level, the role override and the halt state. When halted, the effective level is `read` and execution is blocked.
- `access.level.set` is an owner command:
  - Widening is accepted only from the `web` channel, and only with a `confirmToken`. The token is a SHA-256 over `[projectId, fromLevel, toLevel, expectedRevision]` that the Web confirmation page renders.
  - Narrowing is accepted from `web`, `telegram` and `local-api` with no token.
  - `full` additionally requires the operator flag `execution.fullAllowed: true`. EXE06 records Pi evidence before an operator sets it.
- `access.role.restrict` can only lower a role.
- `execution.halt` is the kill switch. It is accepted from any authorized owner channel. It cancels admitted and running execution attempts through `jobs.attempt_fence`, stops the box and blocks new admissions.
- `execution.resume` restores execution and is Web-only.
- Every command goes through `app.command_receipts` and is revisioned.

### Effect tools and approval cards

- A model reaches an external effect only by calling a Jit **effect tool**. Version 1 has `effect.git_push`, `effect.github_pr_create`, `effect.github_comment`, `effect.github_pr_merge` and `effect.deploy`. `effect.deploy` targets are named and configured by the owner.
- Calling an effect tool never performs the effect. It inserts an `approval_cards` row and returns `pending_approval` with the card ID. The model's turn continues or ends normally.
  - The row holds the exact action JSON, its SHA-256 digest, the project, topic and run, `expires_at` (default 30 minutes) and its state: `pending`, `approved`, `denied`, `expired`, `executing`, `succeeded`, `failed` or `unknown`.
- `approval.decide` is an owner command. It needs the card ID, the expected digest and the expected revision.
  - Approval moves the card to `executing` in the same transaction as its receipt.
  - The **effect executor** then runs the action once, outside every box, using the bound connection.
  - The outcome is recorded and a source is posted to the topic.
  - A crash during `executing` reconciles to `unknown`, which needs owner attention. It is never blindly retried, following ADR 0012's rule for unknown outcomes.
- Auto-approve rules live in `auto_approve_rules(project_id, effect_kind, scope_json, revision, enabled)`. Only Web owner commands write them. A matching rule decides the card as `approved` with `channel: "auto-rule"` and the rule revision.
- **Git push safety.** The executor never runs code or configuration from the box. Steps:
  1. It creates a git bundle inside the box through the runner (`git bundle create`, with `core.hooksPath` disabled).
  2. It copies the bundle out and verifies it.
  3. It fetches the bundle into a Jit-owned bare mirror at `<execution.directory>/<projectId>/mirror.git`, which has fixed configuration.
  4. It pushes from the mirror with `-c core.hooksPath=/dev/null` and a credential from `GIT_ASKPASS`.
- **GitHub API effects** call the REST API with the connection token. Only the endpoints the card names are allowed.
- **Telegram.** Approval cards can be answered from Telegram through `telegram_callback_refs`, with new actions `approval.approve` and `approval.deny`. The bound owner chat is required and the ref expiry is never longer than the card's.
  - Telegram is refused for anything that widens power: widening a level, resume, auto-approve rules, MCP install acceptance, connection secrets and takeover.

### Connections

- `connections(id, kind, label, project_scope_json, revision, created_at, rotated_at)` stores metadata only. The kinds are `github_token`, `deploy_secret` and `mcp_env`.
- Secret values live in `<execution.secretsDirectory>/<id>`. The directory is mode 0700 and each file is 0600, owned by the service user. That directory is outside the state, backup and execution directories, so managed backups stay credential-free (ADR 0025).
- Values are written only by the Web form. They are never rendered back, logged, exported, put in a prompt or a tool result, or written into a box.
- `redactCredentials` and a per-connection fingerprint guard outgoing text, so a secret echoed by a process is redacted.

## Alternatives and consequences

- Confirming in the model's own words was rejected because it would move authority to model output.
- Blocking tool calls until the owner decides were rejected: runs would hold boxes and budgets for minutes or hours.
- Pushing from inside the box was rejected because it puts a credential in the box.
- Running `git push` on the host directly in the workspace was rejected because repository hooks and configuration could run box-controlled code with the credential.

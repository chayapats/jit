# EXE05 run execution tools, v1

Owner: Jit #130 (S11 EXE05). Status: implemented on the issue branch. Decision: [ADR 0036](../adr/0036-execution-box-and-runner.md) (tools in the box, audit) and [ADR 0037](../adr/0037-access-levels-approvals-and-connections.md) (effective level, kill switch). Spec: [S11](../specs/S11-execution-access-and-tools.md) (S11-D01, D02, D04; S11-AC01, AC04). Requirements: FR-36, FR-35, FR-19, FR-02, FR-15, NFR-01, NFR-14.

Uses `schway.host.core-tools/v1`, `exec.box_runtime/v1` and `exec.box_backend/v1` (EXE03), `app.access_level/v1` (EXE01), `app.run_port/v1` and `jobs.attempt_fence/v1`. Effect tools and approval cards are EXE07 ([approval-cards-v1](approval-cards-v1.md)): a `full` grant with an effect executor also admits the effect tools.

## `exec.run_tools/v1`

`src/exec/run-tools.ts`.

- **Grant.** `ApplicationRunRequest.execution: { level: "workspace" | "full", boxProjectId } | null`. A Jit reply (`team.jit-reply`) or specialist run (`team.specialist-analysis`) computes it in `prepare`, inside queue admission, from the effective level of the project and the run's role (`executionGrant`: the project level capped by the role override; `read` or a halt is `null`), and freezes it in the attempt snapshot. Only a port with boxes (`ApplicationRunPort.execution`) grants anything. A request stored before EXE05 has no field and reads as `null`. Model output, sources and tool results never change it.
- **Tools.** `null` is the empty registry: the model is offered no tool and a call to `bash` settles as `Unknown tool: bash`, without any box being ensured. A grant opens the project's box for the run's role through `BoxManager.open` (which re-checks the level) and admits exactly Schway's core tools — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` — over the box backend. The `bash` environment is always the box's own: an environment from the host or Schway's tool context is dropped before the runner.
- **Turns and budget.** A run without a grant keeps the single-turn bridge. A granted run may take `runMaxTurns(request)` model turns (the run's call budget divided over every attempt and host retry, 1–16); the Schway port reserves `schwayMaxCalls = attempts × turns` calls before dispatch, and a reply admitted while Jit may execute gets that call budget in its limits.
- **Trusted statement.** The Schway port adds one `execution` context section, rendered from the frozen grant only: the level, where the tools run and that external effects happen only through Jit effect tools at `full` after an approval card.
- **Admission and fencing.**
  - A job whose next attempt gets a grant (`WorkDefinition.executes`) is execution work for that admission: it waits as `box_capacity` when no box is free, carries the durable `execution` flag (the kill switch fences it, box capacity counts it and box reset refuses while it is admitted), and its attempt records `execution: { level, roleId }`.
  - Every reservation, the dispatch check and the result commit re-check `assertExecutionAllowed(level)` for that role: a level lowered or a halt between admission and attempt start, or during the run, ends the attempt as `authorization_changed` (shown on the reply with `send_again`). `access.level.set` and `access.role.restrict` fence admitted attempts granted more than their role now has in the command's transaction (`AccessReceipt.narrowed.fencedJobIds`) and abort their transports after commit; the halt fences them as before.
  - Each tool call re-checks the run before it starts and after it returns (`executionCurrent`: job authority generation, owner generation, admitted job, active context, level). A refused call never reaches the box; a result that arrives after a halt, stop, narrowing or another process's fence is turned into a cancellation and is never published. The box manager also refuses runner calls (except `kill`) below the box's mode, and binds each session to the container it opened: once another open recreated the box (for example at `full` for another role), the older session's commands are refused.
- **Audit.** Schema 36 `execution_tool_calls(sequence, id, project_id, run_id, job_id, role_id, box, level, tool, subject, status, exit_code, started_at, duration_ms)`. One row per call, written `running` (or `refused`) before the call and settled as `success`, `error` or `cancelled` with the exit code and duration. `subject` is the first 2 KiB of the command, path or pattern, redacted by the connection fingerprints and the credential patterns; file content and output are never stored. At most 2000 rows are kept per project.

## Read API

`Application.toolCalls(actor, projectId, { before?, limit?, runId? }): ToolCallView[]` — newest first, `limit` 1–100 (default 50), `before` a sequence for older pages, `runId` for one run. Any authenticated owner channel may read it; EXE04, EXE09 and EXE15 render it.

## Evidence

`tests/run-execution.test.ts`: scripted models with `FakeBoxRuntime` running the real `ops/box/runner` against a local directory (no Podman) — per-level tool sets on both the scripted and the concrete Schway port, role overrides, mid-run narrowing and halt, owner stop, a late callback after a foreign fence, narrowing between admission and attempt start, box capacity, and the bounded audit read API.

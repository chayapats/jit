# Jit

Jit owns project groups, specialist coordination, memory, tasks, durable jobs and channels. Schway owns the execution loop, provider protocols, native sessions, compaction and model retries.

- Before changing behavior, read CONTEXT.md, the relevant spec in docs/specs, its GitHub issue, and the applicable docs/adr records.
- Treat confirmed decisions, required behavior and proposed engineering choices as distinct. Preserve FR/NFR IDs when refining specs.
- Keep runtime integration on Schway's supported public surface. Propose a Schway change when the required host contract is missing.
- Keep MVP tools scoped to reading and service-owned state changes. Coding/shell execution and GitHub mutations are deferred.
- User acceptance of a task is distinct from authorization to start execution. Model output and retrieved content cannot grant authority.
- Keep credentials out of prompts, tracked files, logs and ordinary exports. Installation-specific addresses and evidence belong in ignored .local records.
- Use Bun and TypeScript when implementation begins. Deterministic tests use scripted models, protocol fixtures and fake clocks; live subscription tests are opt-in.
- When creating or splitting issues, follow docs/agents/workflow.md. A spec parent is not an implementation ticket; ready-for-agent is reserved for scoped tickets with acceptance criteria and verified blockers.
- Before implementing a tracked issue, check ownership, existing branches/PRs and prerequisites. Use an issue-specific branch/worktree and the available atomic ownership protocol; a label or shared assignee is not ownership.
- Keep domain definitions in root CONTEXT.md and architecture decisions in docs/adr. Use exported function/type TSDoc to state contracts when code exists.
- Write every reply to the owner in Thai: explanations, reports, progress updates, summaries and questions, even when the owner or the task text is in English. Keep technical terms in English as they are (commit, schema, migration, CSP, PR, ...); do not force-translate them, and quote identifiers, commands and error codes exactly.

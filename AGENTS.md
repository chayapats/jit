# Jit

Jit owns persistent Bots, work grants, conversations, memory, tasks, computers, artifacts, durable jobs and channels. Schway owns the execution loop, provider protocols, native sessions, compaction and model retries. S14 is the owner-confirmed target; the current runtime still implements the legacy project-centric store until its replacement tickets land.

- Before changing behavior, read CONTEXT.md, the relevant spec in docs/specs, its GitHub issue, and the applicable docs/adr records.
- Treat confirmed decisions, required behavior and proposed engineering choices as distinct. Preserve FR/NFR IDs when refining specs.
- Keep runtime integration on Schway's supported public surface. Propose a Schway change when the required host contract is missing.
- Keep research MVP capabilities narrow. S14 execution intersects owner, Bot, work and resource grants; external effects require exact-action approval and execution stays inside the authorized Bot boundary. Legacy project access levels remain implementation history. No Jit/provider/channel/vault credential or Jit state enters an execution box; private website sessions require a separately protected browser component.
- User acceptance of a task is distinct from authorization to start execution. Model output and retrieved content cannot grant authority.
- Keep credentials out of prompts, tracked files, logs and ordinary exports. Installation-specific addresses and evidence belong in ignored .local records.
- Use Bun and TypeScript when implementation begins. Deterministic tests use scripted models, protocol fixtures and fake clocks; live subscription tests are opt-in.
- When creating or splitting issues, follow docs/agents/workflow.md. A spec parent is not an implementation ticket; ready-for-agent is reserved for scoped tickets with acceptance criteria and verified blockers; titles carry a `[Frontier]`/`[Standard]` model-tier prefix.
- Before implementing a tracked issue, check ownership, existing branches/PRs and prerequisites. Use an issue-specific branch/worktree and respect existing work.
- Do not use the `implement-parallel` skill or its coordinator/claim workflow in this repository. The owner disabled it for Jit on 2026-10-30. This does not disable the owner's explicitly requested UI/UX delegation to Claude Opus 5.5 at high effort.
- All UI/UX design must be authored by a Claude Opus 5.5 subagent with `effort: high`. The primary agent owns architecture, logic, code and contract review, not UI/UX design.
- Keep domain definitions in root CONTEXT.md and architecture decisions in docs/adr. Use exported function/type TSDoc to state contracts when code exists.
- Write every reply to the owner in Thai: explanations, reports, progress updates, summaries and questions, even when the owner or the task text is in English. Keep technical terms in English as they are (commit, schema, migration, CSP, PR, ...); do not force-translate them, and quote identifiers, commands and error codes exactly.
- Write everything stored in the repository or on GitHub in English: commit messages, PR titles and bodies, issues, review replies, code comments, docs and ADRs. Thai is only for replies to the owner and for product copy in `src/i18n/th.ts`.
- Never add a "Generated with Claude Code" line to PR bodies, issues, commits or any other repository or GitHub text.

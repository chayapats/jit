# Specs and implementation tickets

Owner instruction, 2026-10-30: do not use `implement-parallel` or its coordinator/claim workflow for Jit. Continue checking existing ownership, branches/PRs and prerequisites, and use issue-specific branches/worktrees. Explicitly requested UI/UX delegation to Claude Opus 5.5 at high effort remains required.

Tracker: GitHub Issues for chayapats/jit, using gh. Engine changes belong to chayapats/schway and reference the Jit parent spec.

## Write a spec

Read the product baseline, glossary and relevant ADRs. Define observable behavior, actors, scope, requirements, test seams, failure states and unresolved feasibility gates. Publish a design parent with the spec label and link its repository document. The ready-for-agent label belongs to implementation tickets rather than a broad design parent.

Use an existing issue when its scope already matches; inspect its body/comments before updating. Keep the issue and repository spec synchronized and record which revision is current.

## Split tickets

Create narrow end-to-end slices that demonstrate an observable outcome. Each ticket names its parent, acceptance criteria, test evidence, out-of-scope work and genuine blockers. Avoid splitting into schema-only/API-only/UI-only tickets when a complete vertical slice fits.

Use native GitHub blocking relations where supported; otherwise include explicit Blocked by issue links. Cross-repository prerequisites must identify the supported contract/version required, not merely a closed issue.

Apply ready-for-agent only to scoped implementation work whose decisions are sufficient for unattended work. Human login, physical reboot or subscription validation uses ready-for-human where human participation is required. Preserve claims and existing ownership.

## Model tier prefixes

Every implementation ticket title starts with a model tier, then the ticket key: `[Frontier] [EXE01] <outcome>` or `[Standard] [EXE04] <outcome>`.

- `[Frontier]`: security or isolation boundaries, authority and approval semantics, credential handling, concurrency/fencing/reconciliation, cross-repository contract design, or any slice whose implementer must make non-trivial design decisions.
- `[Standard]`: everything else, but only when the body removes judgment. It names the exact files to create or modify (checked against current `main`), function and type signatures, data shapes and schema/migration steps, existing helpers to reuse with paths, an ordered list of implementation steps, exact test files with enumerated cases (input → expected output), the commands to run, the dictionary keys to add in both `th` and `en`, and an explicit "Do not" list.
- When a slice mixes both, split it: keep the Standard part as large as possible and make it depend on the Frontier part's contract.

Every ticket body, in both tiers, has: Parent, Model tier with a one-line justification, Context to read, Deliverable, Implementation steps, Acceptance criteria (checkboxes), Tests and evidence (enumerated), Requirements, Blocked by, Contracts used/delivered, Out of scope, Do not, and Definition of done (commands that must pass; PR body `Closes #n`; no merge by the implementer).

## Label roles

| Label | Meaning |
| --- | --- |
| spec | Design parent for ticket breakdown |
| needs-triage | Maintainer evaluation or technical review is pending |
| needs-info | A named missing decision/evidence blocks progress |
| ready-for-agent | Scoped implementation can start after its prerequisites and ownership checks pass |
| ready-for-human | Requires human implementation or verification |

## Implement and review

Before implementation, inspect the ticket, blockers, ownership and existing PRs. Use an owned issue branch/worktree. Keep implementation within the approved slice and report unexpected contract changes.

Validate observable behavior with deterministic fixtures. Use live provider/host checks only as explicit opt-in evidence. Link each PR to its issue and record tested revision, remaining risks and review results. A completed model response or passing transport request does not prove product success.

# Specs and implementation tickets

Tracker: GitHub Issues for chayapats/jit, using gh. Engine changes belong to chayapats/schway and reference the Jit parent spec.

## Write a spec

Read the product baseline, glossary and relevant ADRs. Define observable behavior, actors, scope, requirements, test seams, failure states and unresolved feasibility gates. Publish a design parent with the spec label and link its repository document. The ready-for-agent label belongs to implementation tickets rather than a broad design parent.

Use an existing issue when its scope already matches; inspect its body/comments before updating. Keep the issue and repository spec synchronized and record which revision is current.

## Split tickets

Create narrow end-to-end slices that demonstrate an observable outcome. Each ticket names its parent, acceptance criteria, test evidence, out-of-scope work and genuine blockers. Avoid splitting into schema-only/API-only/UI-only tickets when a complete vertical slice fits.

Use native GitHub blocking relations where supported; otherwise include explicit Blocked by issue links. Cross-repository prerequisites must identify the supported contract/version required, not merely a closed issue.

Apply ready-for-agent only to scoped implementation work whose decisions are sufficient for unattended work. Human login, physical reboot or subscription validation uses ready-for-human where human participation is required. Preserve claims and existing ownership.

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

---
status: accepted
scope: S10 team engineering choices; extends ADRs 0011, 0015, 0029 and 0030
---

# Deterministic-first routing, a specialist result contract and a communication policy

FR-27, FR-29 and FR-30 make team work cheaper, more predictable and easier to act on. ADR 0030's allowance and ADR 0015's recommendation-only synthesis stay authoritative. The concepts come from openbot's channel lead routing, blocked-reply format and agent communication policy ([nightly-labs/openbot](https://github.com/nightly-labs/openbot)). No code was reused.

## Selected implementation

- **Deterministic rules first, in a fixed order, with no model call:**
  1. A role the owner named explicitly: an `@name` that exactly matches one enabled, routed specialist.
  2. A reply attached to an existing participation.
  3. A clear follow-up to the only open discussion in the topic.
  4. A project with exactly one eligible specialist.

  Each rule records `selection: { rule, roleIds }`.

  **Revised 2026-10-29 (#169, owner instruction "fix it at the root").** Rules 3 and 4 decided *whether* to call the team, not only *who*. On the Pi, a leftover pilot role was called on every owner message under rule 4. Only rules 1 and 2, which are explicit owner intent, now call specialists without Jit. Rule 3 becomes context for Jit's own proposal: a proposal for the same team continues that discussion. Rule 4 is removed. Jit answers by default and proposes a dispatch only when the owner asks for the team or the question clearly needs separate specialist analysis. This matches openbot's orchestrator rule "answer yourself; delegate only when a teammate's tools, accounts or long work are needed".
- **Model selection otherwise.** The existing Jit reply proposes dispatch as described in ADR 0030. That run has no tools. Its output must match a closed schema of roles plus a short `why` of at most 160 characters. The service still validates names against configuration and against the allowance. An invalid or stale selection becomes a held proposal and never broadcasts.
- **Visible reason.** A selection made by the model adds one line to the team card: "Jit chose X because …". The `why` text is shown escaped, as untrusted data. From the same card the owner can skip, add or re-dispatch. A deterministic selection shows only the rule name.
- **Result contract `app.specialist_results/v2`.**
  - Every specialist's normalized output is `{ status: done | partial | blocked | failed, result, evidence: SourceReference[] | "none", unblock? }`.
  - `unblock` is required when status is `blocked`, and it names a single action.
  - Output that does not parse is stored as `incomplete`, with its raw text kept for inspection. It never counts as done.
  - Synthesis treats `blocked` as a coverage gap and surfaces the unblock action to the owner. Jit does not re-dispatch the same role for the same request while it stays blocked.
- **Communication policy.** `teamCommunicationPolicy` is versioned, lives in code, and is appended to the trusted operator instructions of Jit replies, team replies and specialist runs. The policy says:
  - Don't narrate setup or loading.
  - Report progress only on meaningful outcomes.
  - Don't get into acknowledgement loops.
  - Name the specialist first when relaying their result.
  - Never claim a check that no evidence shows.

  The policy version is part of each run's captured identity.

## Alternatives and consequences

- Always asking a model to route wastes budget on cases that are already decided.
- Free-form results can't be checked.
- v1 results stay readable. New runs write v2, and the view renders both.
- The `why` text comes from the model and can be wrong. It is labelled as Jit's reason, not as evidence.

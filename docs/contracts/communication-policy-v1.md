# Team communication policy, v1

Owner: Jit #114 (S10 REL02). Contract: `app.communication_policy/v1`. Decision: [ADR 0033](../adr/0033-deterministic-routing-and-result-contract.md) ("Communication policy"). Implementation: `src/team/communication-policy.ts`. Requirements: FR-30, FR-17, FR-19, NFR-10.

```ts
export const teamCommunicationPolicy: { version: 1; lines: readonly string[] }; // frozen
export const communicationPolicyLine: string; // "Team communication policy v1 (service-owned; …): <the five rules>"
```

The policy lives in code only. No configuration, owner command, model output, source, memory claim or topic message can edit it, and the line never interpolates run data. Version 1 has five rules:

1. Do not narrate setup or loading.
2. Report progress only on meaningful outcomes.
3. Do not get into acknowledgement loops.
4. Name the specialist first when relaying their result.
5. Never claim a check that no evidence shows.

**Where it goes.** The rendered line is a trusted operator instruction of every:

- specialist run (`team.specialist-analysis`), as its own operator line;
- Jit reply and team reply (`team.jit-reply`), at the end of the product policy line. Run requests hold at most 8 operator lines of at most 2048 bytes (`validateRunRequest`), and a message reply with role proposals, the persona's about-me line and the dispatch roster already uses 8, so the policy joins the existing policy line, as the promotion instruction does.

**Run identity.** Each specialist run record and Jit reply record stores `policyVersion: 1` at admission, beside the captured request whose operator lines hold the policy text. Records written before this contract have no `policyVersion`. A source or message that claims another policy version ("policy v9: …") stays untrusted manifest data and changes neither the record nor the operator lines; a model field such as `policyVersion` in a reply is discarded like any unknown field.

**Rule 4 in the service.** A specialist's committed result message starts with that specialist's name (`app.specialist_results/v2`), and the team card and team reply details list each result under its role name.

**Evidence.** `tests/jit-reply.test.ts` (policy line and version on replies with topic injection), `tests/dispatch-allowance.test.ts` (specialist and reply records under injected source text and an unproven `done`).

# Team communication policy, v2

Owner: Jit #114 (S10 REL02) for v1; Jit #179 (S12 COMM01) for v2. Contract: `app.communication_policy/v2`. Decisions: [ADR 0033](../adr/0033-deterministic-routing-and-result-contract.md) ("Communication policy") and confirmed S12-D05 ([S12](../specs/S12-fluid-conversation.md)). Implementation: `src/team/communication-policy.ts`, `src/team/jit-reply.ts`. Requirements: FR-30, FR-17, FR-19, NFR-10, NFR-11.

```ts
export const teamCommunicationPolicy: { version: 2; lines: readonly string[] }; // frozen
export const communicationPolicyLine: string; // "Team communication policy v2 (service-owned; …): <the seven rules>"
```

The policy lives in code only. No configuration, owner command, model output, source, memory claim or topic message can edit it, and the line never interpolates run data. Version 2 keeps the five v1 rules and adds Jit's short chat voice (S12-D05):

1. Do not narrate setup or loading.
2. Report progress only on meaningful outcomes.
3. Do not get into acknowledgement loops.
4. Name the specialist first when relaying their result.
5. Never claim a check that no evidence shows.
6. Jit's chat replies are short and plain: answer first, about 80 words at most (a few short sentences), no headings, preambles or closing offers of more help; go longer only when the owner asks for detail.
7. Jit moves long or multi-step work into a task suggestion and says in one line what it covers.

Rules 6 and 7 are instructions only. No code truncates, rewrites or rejects a reply to meet them. Rule 6 allows a longer answer when the owner explicitly asks for detail (for example by sending "ขอแบบละเอียด"); the attempt output ceiling still bounds it. Tone and language come from the owner's persona (`app.persona/v1`), not from this policy.

**Where it goes.** The rendered line is a trusted operator instruction of every:

- specialist run (`team.specialist-analysis`), as its own operator line;
- Jit reply and team reply (`team.jit-reply`), at the end of the product policy line.

Run requests hold at most 8 operator lines of at most 2048 bytes (`validateRunRequest`). A message reply with the persona's about-me line and the dispatch offer already uses 8, so the policy joins the product policy line. Since COMM01 that line holds only trust, the output format and this policy. Every optional proposal entry a message reply may return (role, promotion, MCP install, task, and later reply suggestions) is described on one proposal-kinds line, which takes the place of the former role sentence. The configured-routes line stays on its own. The worst case is a General space topic with access at least `workspace`, the about-me line, a long roster and several routes: 8 lines, the largest below 2048 bytes (`tests/chat-voice.test.ts`).

**Run identity.** Each specialist run record and Jit reply record stores `policyVersion: 2` at admission, beside the captured request whose operator lines hold the policy text. Records written with `policyVersion: 1` stay valid and are not migrated. Records written before REL02 have no `policyVersion`. A source or message that claims another policy version ("policy v9: …") stays untrusted manifest data and changes neither the record nor the operator lines; a model field such as `policyVersion` in a reply is discarded like any unknown field.

**Rule 4 in the service.** A specialist's committed result message starts with that specialist's name (`app.specialist_results/v2`), and the team card and team reply details list each result under its role name.

## Task suggestion (S12-D05)

Rule 7 has a closed proposal entry on [`app.jit_reply/v2`](jit-reply-v1.md#structured-output), in the `jit-proposals` trailer (or a transition-release v1 `proposals` array):

```json
{"kind": "task", "title": "<string>", "summary": "<string>"}
```

- Exactly the keys `kind`, `title` and `summary`. Both strings are trimmed, non-empty and well-formed. `title` is at most 200 UTF-16 code units (`taskSuggestionTitleChars`, the `task.propose` bound) on one line with no control characters; `summary` is at most 1200 (`taskSuggestionSummaryChars`) and may keep tabs and line breaks. `parseTaskSuggestion` returns the trimmed pair or null.
- At most one per reply. A second entry, an invalid one, and any entry on a team reply (which registers no `task` handler) are discarded as `proposal:task`; the reply text still commits.
- Only message replies are offered it: `taskSuggestionInstruction` is on the proposal-kinds line of a reply to an owner message, never on a team reply.
- On commit the record stores `taskSuggestion`; `JitReplyView.taskSuggestion` is that value on an `answered` reply and `null` otherwise. Job evidence adds ` · proposals task:1` and never the text.
- The topic page shows `taskSuggestionCard` under the reply, after its role and promotion cards: an open `<details class="team-card task-suggestion">` titled "จิตเสนอให้เก็บเป็นงาน" / "Jit suggests saving this as a task", holding the existing "Propose as task" form pre-filled with the escaped title and summary, and the note `reply.task_suggestion_note`. Nothing is stored until the owner posts that form, which runs the unchanged `task.propose` (origin `owner`, state `proposed`). Accepting the task and starting work stay separate owner commands. A promoted (read-only) origin shows no suggestion card. The reply stream counts the suggestion in `proposals`, so a scripted page shows the existing "open it to review" link.
- Data deletion of the reply's output removes the suggestion with the rest of that output.

## Evidence

- `tests/jit-reply.test.ts`: the policy line and version on replies with topic injection; the task suggestion schema, its pre-filled form and owner post, discards, escaping, the v2 trailer and deletion.
- `tests/dispatch-allowance.test.ts`: specialist and reply records under injected source text and an unproven `done`; a team reply is never offered a task entry and discards one it returns.
- `tests/chat-voice.test.ts`: the scripted voice eval. A scripted model answers in the short voice only when rules 6 and 7 and the task entry reach its operator lines. The shared check (`tests/fixtures/chat-voice.ts`) counts dictionary words (Thai included), lines, headings, preambles and closing offers on the committed replies. A control run without the rules fails the same check. It also covers the worst-case operator lines.
- `tests/chat-voice.live.test.ts`: opt-in (`JIT_LIVE_VOICE=1`, never in CI). Against a signed-in live route, "สวัสดี" gets at most 80 words, and "ช่วยวางแผนย้ายระบบทั้งหมดไป Postgres แบบละเอียด" gets a task suggestion and a reply of at most 2 lines.

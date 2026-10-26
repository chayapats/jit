---
status: accepted
scope: S09 general space and promotion engineering choices
---

# General space as a system project, and promotion without moving identity

FR-22 asks for chat without choosing a project, and for promoting a conversation into a project. CONTEXT.md says a topic retains its project identity, and memory claims keep their project of origin.

## Selected implementation

- Setup creates one ordinary project with the reserved system kind `general` (displayed "ทั่วไป" / "General"). It reuses every existing project rule for memory, tasks, jobs, dispatch allowance and deletion. It cannot be deleted or renamed into another kind, and there is exactly one per installation.
- A `promotion` proposal from Jit names a suggested project name. `topic.promote.accept` requires the current proposal revision. It then creates the new project and a new topic in that project. The new topic's first record is a committed source reference to the origin topic, at the exact conversation revision. The origin topic is marked promoted with a link to its successor and becomes read-only.
- Nothing is moved or rewritten. Sources, memory claims and obligations keep their original project. Cross-project memory reaches the new project through the existing provenance rules (ADR 0003, 0019, 0020). Open tasks stay where they are, and the owner can re-propose them in the new project.
- In the UI, the new topic shows the prior conversation as an expandable "continued from General" block, so the owner experiences it as the same conversation.

## Alternatives and consequences

Physically moving the topic would break project identity, memory lineage and deletion-ledger assumptions. A project-less chat would put the model in charge of scope. Owner-visible difference: the history is linked and quoted rather than relocated.

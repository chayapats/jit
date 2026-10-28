# ADR 0008: Committed conversation and source references

Status: accepted for APP02 (Jit #4).

## Context

FR-01/04 require project-scoped topics and durable history. FR-10/17 require provenance without treating retrieved or owner-authored text as authority. NFR-05/07/10/11 require attribution, safe rendering, bounded reads and deterministic evidence. APP01 supplies authenticated actors, stable projects/groups, transactional state and global command receipts. Schway sessions are execution context, not the canonical application conversation.

## Decision

Store topic/message identity, project/group scope, attribution, commit time and serialized sequence in application tables. Store their immutable text in source versions and retain the exact source ID/revision/generation on each conversation record. Topic metadata source revision and mutable conversation revision are separate: appending a message advances the topic conversation revision without rewriting its title source.

Creating a topic requires the current project revision; sending a message requires the current topic revision and both project/topic IDs. Names never select scope. The same owner/request receipt namespace spans project, topic and message commands. Validate the actor inside the writer transaction, return an exact replay before checking current revisions, and commit source/state/receipt/audit together. Different payloads under one request ID fail. Sequence cursors order bounded committed pages independently of clock precision.

The source registry separates current availability/revision/generation from requested immutable references. Lookup checks the authorized project and current generation, then resolves only the exact version. Missing content returns an explicit unavailable result. It never guesses a replacement, imports an external resource or invokes a model. External descriptors carry service identity and no fetched content. Trusted output producers supply verified participant/run references; they cannot infer human attribution from text. Those transaction ports are internal producer seams, not new owner HTTP capabilities or run authorization.

Only committed records enter canonical history. Future team slices must keep provisional progress outside this history and commit attributed answers through an authorized producer. No run, extraction, task acceptance or authorization is implied by reading history or submitting literal owner text.

Schema v2 adds source and conversation relations with scoped foreign keys. Migration snapshots existing v0/v1 state before DDL and advances the version in one transaction. A frozen APP01 schema fixture checks real v1 upgrades. Presentation escapes every text fragment and supports only fenced-code display; URLs remain literal text. Web mutations retain APP01's Origin/session/CSRF boundary.

## Consequences

APP02 works without Schway or provider dependencies and preserves source links after restart. Source records establish the reference vocabulary for subsequent memory/tasks/team work. Correction, forget/delete, redaction of historical receipts/exports, retention and external import are later slices; this ADR does not claim their lifecycle enforcement. A future lifecycle change must fence every content-bearing projection, including durable receipt results, and preserve explicit unavailable states rather than silently retargeting references.

The implemented signatures and finite limits are recorded in [app-conversation-v1](../contracts/app-conversation-v1.md). ADR 0001, 0003, 0004, 0006 and 0007 remain applicable.

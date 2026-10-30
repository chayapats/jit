# Jit Product Vision

Status: owner-confirmed target in [S14](../specs/S14-bot-first-local-assistant.md), 2026-10-30. The current runtime remains S09–S13; the target is not shipped.

## Purpose

Jit is a personal team of persistent Bots that does useful work on a computer the owner controls. The owner talks to Jit, delegates directly to a Bot when useful, and receives results with evidence instead of managing Projects and provider sessions.

The first user is the founder. One installation has one owner. Linux x64/arm64 hosts keep runtime, persistent application state and execution local; relevant content may reach configured inference, web research and delivery services. Local execution is not a promise of local inference or no external recipients.

## What must be useful first

Research is the MVP: ask a question, let useful Bots work concurrently, search/read with Parallel and receive a persisted report with citations and files. The product must survive interruption and tell the truth about missing evidence.

Coding from a request to reviewable code/tests/PR, and personal assistance with email/calendar, are required subsequent capabilities. They are not optional ideas discarded from the roadmap.

## Product principles

- Persistent Bots and sourced memory give continuity without requiring a Project.
- One main voice synthesizes useful independent work; dispatch is not mandatory on every message.
- A clear authenticated work command starts authorized internal execution. Retaining an obligation alone does not.
- Exact external actions wait on owner approval. Sources/models cannot widen authority.
- Bot computers and private memory are separate. Explicit sharing exposes a named snapshot, not every account/file.
- Proactive work follows a bounded routine the owner enabled.
- Real concurrency, finite resources, visible stop and safe recovery are part of usefulness.
- Facts, inferences, partial coverage, unknown outcomes and future capabilities are labelled honestly.

## Product and engine

Jit owns Bots, grants, conversations, tasks, memory, artifacts, durable jobs and channels. Schway owns loop/provider/session/compaction/model-retry primitives through its supported public host surface. We build Jit itself, taking ideas from OpenBot/OpenDuet/Grok Bot without requiring their platform or memory service.

MIT remains the repository license. Open source does not imply multi-user tenancy or support for every website/model/OS.

## Validation

The owner will judge practical usefulness. No launch date, recall score or claimed superiority of Parallel is invented. Deterministic correctness, live host/account feasibility and real research quality are separate evidence.

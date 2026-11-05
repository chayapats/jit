# Jit Product Vision

Status: retained S14 vision, confirmed 2026-10-30. [S16](../specs/S16-rakazo-experience.md), confirmed 2026-11-05, is the current target: the Rakazo-style experience through selective reuse on Jit + Schway, with stack changes open for improvement. It extends the [S15](../specs/S15-conversational-autonomy.md) authority baseline. S14 remains the default runtime, with opt-in S15; S09–S13 is retained through explicit legacy selection/configuration. See the [current PRD](02-prd.md) and [CONTEXT.md](../../CONTEXT.md).

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

Jit-origin code remains MIT-licensed. Adapted upstream code retains its applicable license and notices; Rakazo's Apache-2.0 source must not be presented as MIT-only. Open source does not imply multi-user tenancy or proven support for every website/model/OS.

## Validation

The owner will judge practical usefulness. No launch date, recall score or claimed superiority of Parallel is invented. Deterministic correctness, live host/account feasibility and real research quality are separate evidence.

# ADR 0010: Bounded application job admission

Status: accepted for JOB01 (Jit #6); FR-07/10/14/15/18, NFR-05/06/10.

Jit queues application work; it does not replace Schway's model/tool loop. A trusted, process-owned registry supplies work definitions, exact route references, input validation and bounded steps. Web/model payloads cannot register handlers, load code or choose fallback billing routes. The first usable work type reads the selected project's current state; scripted definitions exercise the same admission boundary in tests. The enqueue action explicitly authorizes that named work. Task acceptance remains a different command.

Commit a job, immutable input/configuration identity, owner authorization generation, finite limits, receipt and audit in the existing application transaction before acknowledging. Queue and concurrency ceilings are finite development configuration, not measured deployment capacity. Each step reserves its declared usage before invocation; additional reservations also commit before the adapter may spend them. Never refund reservations after an uncertain outcome. Yield appends the job behind peers of the same priority, while interactive queued work precedes background work. An existing call is not preempted by a new arrival.

A SQLite scheduler-owner record permits one local process instance. A live owner (including another instance in the same process) prevents a second scheduler and job acknowledgments. Reclaim only when the recorded process is proven absent; ambiguous identity/PID reuse fails closed. Reclaim preserves queued jobs and marks interrupted admissions waiting for explicit reconciliation/resume. This is single-host admission ownership, not JOB02's native-session attempt fencing or an exactly-once external execution claim.

Deadlines make stalled work visibly failed and request adapter cancellation. Until the adapter settles, it still occupies admission capacity; a timeout does not prove a provider call stopped. Shutdown similarly retains ownership if a worker has not settled. A new process can recover after the old process is absent. Late callbacks check scheduler ownership and cannot publish a result after that owner retires. Cross-store session reconciliation remains JOB02.

Waiting quota/login/unavailable jobs require an explicit owner resume with a current job revision, unchanged work configuration/route and remaining retry budget. There is no automatic job retry loop. Password reset fences old authorization generations. A changed work configuration or source revision blocks admission rather than silently adopting a new route/input. Limits and usage survive restart; exhaustion produces visible blocked/partial/failed state with a fixed reason and next action. Raw adapter exceptions are never returned or retained.

The owner can inspect a bounded job list without connectivity. Reads never start work. Deterministic tests use fake clocks and scripted adapters, covering commit failure, duplicate/revision conflicts, queue contention, ownership, deadline/cancellation, budget exhaustion, waiting and restart. No live model/account, installation, Pi or network probe is part of JOB01.

## S14 refinement status

This record retains its implemented legacy meaning. The owner-confirmed [S14 target](../specs/S14-bot-first-local-assistant.md) and proposed ADRs 0045–0048 refine Project ownership, grants/computers, Parallel default or replay-safe recovery where applicable. They do not claim a new supported API or change this build's behavior. Unchanged authority, fencing, credential and evidence invariants remain.

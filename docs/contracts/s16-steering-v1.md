# S16 steering and concurrent conversations — `s16-conversation-steer/v1`

Status: implemented for CHAT16-02 ([#406](https://github.com/chayapats/jit/issues/406)); deterministic and real-bundle browser evidence; live provider evidence separate ([#431](https://github.com/chayapats/jit/issues/431)). Decision record: [ADR 0086](../adr/0086-s16-live-steering-and-concurrent-conversations.md). Engine contract: Schway `schway.host.steering/v1` ([schway#460](https://github.com/chayapats/schway/issues/460)).

## Command

`POST /api/s16/client/conversations/:id/steers` with exactly:

```json
{ "contract": "s16-conversation-steer/v1", "requestId": "<new id>", "conversationId": "<id>", "target": "<root request id>", "text": "<owner text>" }
```

The authenticated owner, CSRF and Origin rules of the [client contract](s16-client-v1.md) apply. `target` must be a root request of the same conversation owned by the same owner generation. Text follows the ordinary message bounds and credential refusal. The reply is HTTP 202:

```json
{ "contract": "s16-conversation-steer-receipt/v1", "requestId": "…", "conversationId": "…", "target": "…", "state": "sent", "followUp": null }
```

A repeated `requestId` with the same body returns the steer's current disposition; a different body conflicts (`request_id_conflict`).

## Dispositions

| State | Meaning |
| --- | --- |
| `queued` | Stored; the target's work run has not opened its live sink yet. |
| `sent` | Accepted by the live Schway run; applied at its next boundary. |
| `applied` | Committed into the run's native history (Schway reported the entry). |
| `resubmitted` | Delivered instead as exactly one ordinary follow-up message, `followUp`. |
| `unapplied` | Never applied and not resubmitted: the target was stopped, or no live owner registration exists (restart). The owner can send it again. |
| `uncertain` | The run may have recorded it (lost process, unsettled append). Never resubmitted automatically. |

Rules:

- A steer is owner input inside the target's frozen scope. Tools, resources, access, budgets and policy stay as admitted; the work system prompt tells the model to report, not act on, requests outside that scope. Steering text never decides a held action.
- While the target runs, the steer is handed to the run once its first model send is authorized (Schway accepts steers only after the input is durably appended). Schway applies pending steers in acceptance order after the current tool batch commits and before the next model request; a pending steer keeps a final-answer run going for one more round within `maxTurns` and the deadline.
- When the run settles, Schway's exact report decides each handed steer: `applied`, `unapplied` (→ one follow-up) or `uncertain`. A run that ends without a report leaves handed steers `uncertain`. Steers never handed become one follow-up.
- A target that is not running (held for approval, completed, accepted) receives the text at once as one ordinary follow-up. A stopped target only records it as `unapplied`.
- The follow-up ID is derived from the steer ID, so a repeated steer never creates a second follow-up.
- Restart: `sent` steers become `uncertain` and `queued` steers become `unapplied`; neither is resubmitted.

Each transition appends a `steer` control event (`steer_queued`, `steer_sent`, `steer_applied`, `steer_resubmitted`, `steer_unapplied`, `steer_uncertain`) on the target request. Owner rows (`s15.owner-view/v1`) carry `steers`: the owner's own text and disposition, in acceptance order.

## Concurrent conversations

The CHAT drain runs up to `maxConcurrentRuns` requests at once (default 2, at most 8) and never two requests of one conversation. A request that waits for an approval is not running, so other conversations continue. Stopping one request leaves its siblings untouched. Working-computer capacity, policy budgets and exact-effect gates apply per request as before.

## Storage

The conversation journal gains a `steers` table (`id` → command, `request_id`, `state`, `follow_up`, `at`), created in place on open. The steer's text stays in its immutable command row. An older binary ignores the table; rolling back loses only the dispositions of pending steers, never a decided action.

## Limits and residuals

- At most 32 steers per run (Schway `MAX_STEERS_PER_RUN`); later ones are rejected by the engine and resubmitted as follow-ups.
- Applied steers are part of the run's native history; later interpretations see the run's result, not each steer separately.
- Live account behaviour (provider latency between boundaries) is evidenced in #431, not here.

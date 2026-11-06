# S14 Validation and Open Questions

Status: retained S14 validation questions and historical gates. Current owner decisions are [S15-D01–D23](../specs/S15-conversational-autonomy.md#confirmed-decisions); current acceptance is S15-AC01–AC16 with [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md). Items below are not evidence of S15 support. S15 guest-administration, protected-browser/effect, private-disclosure and transition feasibility remain engineering proof obligations, not a reason to ask the owner the accepted product questions again.

## Evidence layers

1. Deterministic: scripted models, protocol/MCP fixtures, fake clocks, barriers and temporary stores. No paid inference.
2. Host/runtime: opt-in Linux x64/arm64 service, resources, reboot, profile/network boundaries and selected subscription lifecycle.
3. Product value: small owner-approved research corpus, actual source coverage/citations/artifact usefulness, failures and feedback. No invented accuracy/date/cost threshold.

## Gates and unresolved evidence

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Cross-host subscription concurrency | Supported shared credential lifecycle, renewal/logout/cancel races and packed-consumer conformance; exact artifact pinned | New Schway brief; not implemented |
| Native orphan discovery/recovery | Supported #414 behavior and create-before-correlation crash fixtures | Existing upstream issue; not implemented |
| Bot/profile/network isolation | Cross-Bot path/process/egress bypass denial, protected sessions, takeover leases and host measurements | Proposed ADR 0046; not verified |
| Parallel protocol | Anonymous/keyed fixture snapshots, schema changes, quota/cancel/output bounds and no fallback | Planned adapter; live quality unverified |
| Reports and lineage | Claims bind read evidence; missing coverage remains partial; artifact hash/type/path/lifecycle checks | Planned contract |
| Safe resume | Typed handler replay classes, unchanged grant/config/input, old transport settlement and remaining reservations | Planned contract |
| Linux operation | Bounded startup/idle persistence/reboot and real selected-route evidence on declared platforms | Legacy evidence cannot certify the S14 redesign |
| UI/UX | Opus-authored prototype, rendered samples and DOM checks; full product/no-script/device/screen-reader evidence | Design artifact, not implemented product |

## Decisions that need no new owner interview

- Typed work.start, not model intent, is the start-authority signal. @Bot is routing only.
- Prototype numbers remain fixtures; validated finite operating values are chosen with measured host/provider evidence.
- Unknown browser/action classes ask or refuse. Public read/report MVP does not imply every form/payment/send adapter exists.
- A coordinator-only Jit can stay without a warm computer; Jit uses the same Bot policy if authorized execution later needs one.
- Stop fences named work/attempts; unrelated grants/routines remain independent.
- Preserve script-free form-based takeover; the designer's claim that forms cannot forward input was incorrect.
- Mobile navigation is an Opus design proposal, not a new owner-confirmed requirement. Implementation updates the affected UI contract/tests.

See [contract/design resolutions](../contracts/s14-authority-and-design-resolutions.md). These engineering choices can be reviewed without silently becoming confirmed product decisions.

## Required later-phase discovery

Coding: exact repository bindings, enforced package/network paths, immutable diff/test evidence, trusted push/PR adapters and unknown-outcome reconciliation.

Personal assistance: first connector/provider scopes, OAuth feasibility, account visibility, calendar timezone/recurrence, draft approval and send/event idempotency/read-back. Do not assume Gmail or Calendar transport is already available from a configured entry.

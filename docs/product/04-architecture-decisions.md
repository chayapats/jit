# Jit Architecture Decision Records

Domain vocabulary lives in [CONTEXT.md](../../CONTEXT.md). Current target is [S15](../specs/S15-conversational-autonomy.md); S14 remains the implemented default. Engineering choices and support claims require their own contract/evidence status.

## S15 proposal

[ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) records conversational admission under standing policy, shared working resources and a control plane protected from the administrable VM. It identifies unresolved administration/destruction, browser/effect, disclosure, budget and transition proofs. Its engineering status is proposed; S15-D01–D23 are confirmed product inputs. Existing ADRs retain their historical/runtime meaning until explicit replacement contracts land.

## S14 proposals

| ADR | Proposed engineering choice | Owner direction |
| --- | --- | --- |
| [0045](../adr/0045-bot-first-domain-and-fresh-state.md) | Bot/work/grant identities and a fresh application store | D01/D04/D05/D06/D12/D15 |
| [0046](../adr/0046-bot-computers-and-explicit-sharing.md) | Private persistent computers, protected browser sessions, input leases and named snapshot shares | D02/D03/D10/D13 |
| [0047](../adr/0047-parallel-research-and-report-artifacts.md) | Service-owned Parallel reads, evidence snapshots and report artifacts | D07/D09 |
| [0048](../adr/0048-concurrent-work-and-replay-safe-recovery.md) | Finite concurrent work graphs and safe checkpoint/native reconciliation | D04/D08/D10/D11 |

The [design/contract resolutions](../contracts/s14-authority-and-design-resolutions.md) record engineering review of the Opus artifact. They are not a replacement UI design or a shipped contract.

## Retained boundaries and history

[0001](../adr/0001-application-boundary.md) keeps the Jit/Schway boundary and [0002](../adr/0002-local-runtime-and-external-inference.md) keeps local runtime with explicit external recipients. Existing authority, receipts, fencing, outbox, lifecycle and credential invariants remain relevant.

ADRs 0003/0018/0031 retain their historical project-origin language for the legacy store. ADRs 0036–0039 retain the implemented per-project computer/permission shape until S14 replaces it. ADR 0044 retains the legacy SearXNG default; S14 chooses Parallel for the new store. Do not erase history or describe a proposed replacement as shipped.

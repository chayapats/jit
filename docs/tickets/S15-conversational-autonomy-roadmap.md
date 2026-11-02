# S15 delivery roadmap

Status: prepared from the owner-confirmed 2026-11-02 baseline. This is a dependency and readiness plan, not an instruction to implement every issue or an installed permission profile.

Canonical scope: [S15](../specs/S15-conversational-autonomy.md), [PRD](../product/02-prd.md), [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) and [workflow](../agents/workflow.md). S14 remains the implemented default. No live deployment, spending amount, state deletion or personal GitHub enrollment is authorized by this plan.

## Publication and readiness

Documentation PR: https://github.com/chayapats/jit/pull/343

Parent: https://github.com/chayapats/jit/issues/316

The documentation delivery is already in progress. All other tickets remain needs-triage while their direct blockers and actual reviewed contract revisions are outstanding. ARCH15-01 and STATE15-01 are the first candidates after DOC15-01 merges; they are bounded audits, not permission to run live guests/accounts. A closed upstream issue alone is insufficient. Confirm assignees, comments, branches/PRs, exact integration base and referenced evidence before adding ready-for-agent. Human/live evidence uses ready-for-human only after technical prerequisites and owner inputs are actually available.

Required UX authoring is separately tracked in UX15-00. The prescribed Claude Opus 5.5/high provider was unavailable; no concrete experience or primary-authored substitute is claimed. UX15-01/02 describe confirmed user outcomes only and stay blocked until that handoff and their runtime contracts land. Do not retry by changing provider/model or increasing spending without owner instruction.

All current slices are Frontier because they retain authority/isolation, lifecycle, cross-contract, design or evidence judgment. Extract mechanical Standard slices only after exact files, signatures, schemas/migrations, dictionary keys, ordered steps and fixture inputs/outputs are checked on main. This is not a blanket permission to spend on a model.

## Scoped delivery graph

| Ticket | Outcome | Direct blockers | Current readiness |
| --- | --- | --- | --- |
| [DOC15-01](https://github.com/chayapats/jit/issues/317) | Publish the confirmed S15 spec and delivery graph | None; current documentation task | In progress |
| [ARCH15-01](https://github.com/chayapats/jit/issues/318) | Freeze the working-VM and protected-effect feasibility contract | [DOC15-01](https://github.com/chayapats/jit/issues/317) | Blocked / needs triage |
| [STATE15-01](https://github.com/chayapats/jit/issues/319) | Specify a non-destructive S14-to-S15 state and policy transition | [DOC15-01](https://github.com/chayapats/jit/issues/317) | Blocked / needs triage |
| [POLICY15-01](https://github.com/chayapats/jit/issues/320) | Enforce standing policy and exact held actions outside working agents | [ARCH15-01](https://github.com/chayapats/jit/issues/318), [STATE15-01](https://github.com/chayapats/jit/issues/319) | Blocked / needs triage |
| [VM15-01](https://github.com/chayapats/jit/issues/321) | Run ordinary administration in the approved working VM | [POLICY15-01](https://github.com/chayapats/jit/issues/320) | Blocked / needs triage |
| [BROW15-01](https://github.com/chayapats/jit/issues/322) | Complete a website task through a protected general browser | [VM15-01](https://github.com/chayapats/jit/issues/321) | Blocked / needs triage |
| [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Start requested tool work directly from ordinary conversation | [VM15-01](https://github.com/chayapats/jit/issues/321) | Blocked / needs triage |
| [TEAM15-01](https://github.com/chayapats/jit/issues/324) | Let authorized team members share work resources without repeated grants | [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [MEM15-01](https://github.com/chayapats/jit/issues/325) | Remember useful owner knowledge automatically and honor corrections | [TEAM15-01](https://github.com/chayapats/jit/issues/324) | Blocked / needs triage |
| [MODEL15-01](https://github.com/chayapats/jit/issues/326) | Choose approved models and effort without widening accounts or spend | [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [WORK15-01](https://github.com/chayapats/jit/issues/327) | Keep assigned responsibility through waits, restart and stalled progress | [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [GIT15-01](https://github.com/chayapats/jit/issues/328) | Report ready issues and implement only the owner-selected issue | [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [GIT15-02](https://github.com/chayapats/jit/issues/329) | Enforce default and personal GitHub publication policies | [GIT15-01](https://github.com/chayapats/jit/issues/328) | Blocked / needs triage |
| [GIT15-03](https://github.com/chayapats/jit/issues/330) | Babysit selected PRs through review and safe eligible auto-merge | [GIT15-02](https://github.com/chayapats/jit/issues/329), [WORK15-01](https://github.com/chayapats/jit/issues/327) | Blocked / needs triage |
| [EDIT15-01](https://github.com/chayapats/jit/issues/331) | Create solo calendar blocks without repeated approval | [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [SEND15-01](https://github.com/chayapats/jit/issues/332) | Approve the final email once and enforce the same communication gate | [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [PAY15-01](https://github.com/chayapats/jit/issues/333) | Hold exact transactions and validate recurring-payment rules | [POLICY15-01](https://github.com/chayapats/jit/issues/320) | Blocked / needs triage |
| [BIZ15-01](https://github.com/chayapats/jit/issues/334) | Apply evidenced business-record edits without making new commitments | [BROW15-01](https://github.com/chayapats/jit/issues/322), [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [DATA15-01](https://github.com/chayapats/jit/issues/335) | Block new private-data recipients across tool and model routes | [BROW15-01](https://github.com/chayapats/jit/issues/322), [MODEL15-01](https://github.com/chayapats/jit/issues/326) | Blocked / needs triage |
| [MIG15-01](https://github.com/chayapats/jit/issues/336) | Stage S15 adoption without erasing state or widening installed policy | [VM15-01](https://github.com/chayapats/jit/issues/321), [MEM15-01](https://github.com/chayapats/jit/issues/325), [STATE15-01](https://github.com/chayapats/jit/issues/319) | Blocked / needs triage |
| [UX15-00](https://github.com/chayapats/jit/issues/337) | Author the required S15 experience and freeze the UI handoff | [DOC15-01](https://github.com/chayapats/jit/issues/317); required authoring provider availability | Blocked / needs triage |
| [UX15-01](https://github.com/chayapats/jit/issues/338) | Complete one-time setup and the first ordinary conversational task | [UX15-00](https://github.com/chayapats/jit/issues/337), [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [UX15-02](https://github.com/chayapats/jit/issues/339) | Review a held action once and follow authorized work to evidence | [UX15-00](https://github.com/chayapats/jit/issues/337), [WORK15-01](https://github.com/chayapats/jit/issues/327), [GIT15-02](https://github.com/chayapats/jit/issues/329), [SEND15-01](https://github.com/chayapats/jit/issues/332), [PAY15-01](https://github.com/chayapats/jit/issues/333) | Blocked / needs triage |
| [EDIT15-02](https://github.com/chayapats/jit/issues/342) | Apply reversible personal document and task edits | [BROW15-01](https://github.com/chayapats/jit/issues/322), [CHAT15-01](https://github.com/chayapats/jit/issues/323) | Blocked / needs triage |
| [EVID15-01](https://github.com/chayapats/jit/issues/340) | Prove the GitHub scenario and protected boundaries on the tested build | [GIT15-03](https://github.com/chayapats/jit/issues/330), [EDIT15-01](https://github.com/chayapats/jit/issues/331), [SEND15-01](https://github.com/chayapats/jit/issues/332), [PAY15-01](https://github.com/chayapats/jit/issues/333), [BIZ15-01](https://github.com/chayapats/jit/issues/334), [DATA15-01](https://github.com/chayapats/jit/issues/335), [MIG15-01](https://github.com/chayapats/jit/issues/336), [UX15-01](https://github.com/chayapats/jit/issues/338), [UX15-02](https://github.com/chayapats/jit/issues/339), [EDIT15-02](https://github.com/chayapats/jit/issues/342) | Blocked / needs triage |
| [CUT15-01](https://github.com/chayapats/jit/issues/341) | Adopt the reviewed S15 release with owner acceptance and rollback | [EVID15-01](https://github.com/chayapats/jit/issues/340) | Blocked / needs triage |

## Acceptance coverage

| Acceptance case | Owning slices |
| --- | --- |
| S15-AC01 | [CHAT15-01](https://github.com/chayapats/jit/issues/323), [GIT15-01](https://github.com/chayapats/jit/issues/328), [UX15-01](https://github.com/chayapats/jit/issues/338) |
| S15-AC02 | [GIT15-01](https://github.com/chayapats/jit/issues/328) |
| S15-AC03 | [ARCH15-01](https://github.com/chayapats/jit/issues/318), [VM15-01](https://github.com/chayapats/jit/issues/321) |
| S15-AC04 | [TEAM15-01](https://github.com/chayapats/jit/issues/324) |
| S15-AC05 | [BROW15-01](https://github.com/chayapats/jit/issues/322) |
| S15-AC06 | [EDIT15-01](https://github.com/chayapats/jit/issues/331), [BIZ15-01](https://github.com/chayapats/jit/issues/334), [EDIT15-02](https://github.com/chayapats/jit/issues/342) |
| S15-AC07 | [POLICY15-01](https://github.com/chayapats/jit/issues/320), [SEND15-01](https://github.com/chayapats/jit/issues/332), [GIT15-02](https://github.com/chayapats/jit/issues/329), [UX15-02](https://github.com/chayapats/jit/issues/339) |
| S15-AC08 | [POLICY15-01](https://github.com/chayapats/jit/issues/320), [PAY15-01](https://github.com/chayapats/jit/issues/333), [MODEL15-01](https://github.com/chayapats/jit/issues/326) |
| S15-AC09 | [POLICY15-01](https://github.com/chayapats/jit/issues/320), [BIZ15-01](https://github.com/chayapats/jit/issues/334) |
| S15-AC10 | [GIT15-01](https://github.com/chayapats/jit/issues/328), [GIT15-02](https://github.com/chayapats/jit/issues/329), [GIT15-03](https://github.com/chayapats/jit/issues/330), [WORK15-01](https://github.com/chayapats/jit/issues/327) |
| S15-AC11 | [DATA15-01](https://github.com/chayapats/jit/issues/335) |
| S15-AC12 | [WORK15-01](https://github.com/chayapats/jit/issues/327) |
| S15-AC13 | [MEM15-01](https://github.com/chayapats/jit/issues/325) |
| S15-AC14 | [MODEL15-01](https://github.com/chayapats/jit/issues/326) |
| S15-AC15 | [WORK15-01](https://github.com/chayapats/jit/issues/327), [GIT15-03](https://github.com/chayapats/jit/issues/330) |
| S15-AC16 | [STATE15-01](https://github.com/chayapats/jit/issues/319), [MIG15-01](https://github.com/chayapats/jit/issues/336), [EVID15-01](https://github.com/chayapats/jit/issues/340), [CUT15-01](https://github.com/chayapats/jit/issues/341) |

UX15-00 supplies the required authored handoff across all cases; EVID15-01 records exact-build coverage for all sixteen. A fixture-only payment/business port proves policy behavior, not support for a bank or production CRM. Such real resources need their own explicit approved bindings/adapters and opt-in evidence.

## Contract and activation rules

- Existing source paths were checked against main at `17e5110daf1491f2d1e918fef4cb5b5aec8f8f1b`. Planned S15 contract identifiers are deliverables, not supported APIs. Recheck current main before implementation.
- ARCH15-01 inventories exact supported Schway exports and gaps; STATE15-01 freezes data/privacy/policy transition inputs. Actual administration/browser/effect/disclosure enforcement is proved by later implementation and exact-build evidence before CUT15-01 activation.
- Logic may be developed against reviewed fake ports without claiming real VM enforcement. Required human gates must survive guest administration; snapshots, prompts, a sibling process, HTTP method or model label alone do not prove prevention.
- Provider-specific payment/business adapters and unsupported websites are constrained honestly. No speculative upstream Schway issue is a blocker; create one only for a demonstrated missing public contract.
- Jod interoperability is intentionally deferred, with a future provenance-preserving seam in MEM15-01. It is not a delivery blocker or mandatory storage replacement.
- Every implementation PR closes only its own ticket, records tested SHA/contracts/evidence, and is not merged by its implementer. The current documentation PR closes DOC15-01, not the S15 design parent.

Native GitHub parent/blocking relations mirror the direct dependency keys in [the manifest](s15/manifest.json). Verify actual graph edges and labels after publication. No implement-parallel/coordinator/claim workflow applies.

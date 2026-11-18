---
status: selected engineering contract for SKILL16-01 (#420); implementation and conformance pending
date: 2026-11-18
scope: S16-AC13; FR-17/20/21/31/35/38/39; NFR-01/02/07/09/14
---

# Pinned know-how with executable parts inside the working computer

## Target and inspected alternatives

S16 requires importing a pinned skill/plugin, showing supported and unsupported parts, choosing team/Bot
availability and using it in chat. Importing know-how grants no account, recipient, effect or host-code authority.
MCP16-01 (#418) is merged; its protected directory, reviewed tools and per-run runtime remain the connection owner.

The inspected Rakazo source is commit `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`. Its `docs/build-a-plugin.md`
(SHA-256 `b351475cf8cfe50a5728f9a355c41f0ed99539b0ca8930c23a88e602d627e12f`) describes `plugin.json`,
`mcp.json` and `skills/<name>/SKILL.md`, commit-pinned preview/review, and explicit unsupported parts. The inspected
`apps/api/src/plugin-installs.ts` (`7154df537b16c9f4ff1f6bf61a56e538664d89d22b50e63200ebf2d2859790b9`),
`apps/api/src/agent-skills.ts` (`1be39e5bc736784250b161fbf93e774b5dcae66b72b59c10b2d36033e60d6161`) and
`packages/adapters/src/skill-tools.ts` (`32a500104114e37cab7f46aa70fdb52de9ca47426c07aa41fcb08bffbd9f4d92`)
bind to Prisma, upstream owner identities and the other runtime. Reusing that runtime would duplicate Jit's authority
and lifecycle. No source/dependency/asset is copied by this choice; applicable source licenses must still be retained
if a later change imports code. Imported owner packages carry their own exact license/notice files and hashes.

The pinned Schway host exposes custom `ToolDefinition`s and host source documents. Its native skill discovery and
activation implementation is not exported by `schway/host`; importing internal modules or discovering packages on the
protected host would create an inappropriate installation/execution boundary. No missing engine contract is needed:
Jit owns imported know-how, availability and provenance, and supplies guarded tools over Schway's public host surface.
Schway continues to own loops, sessions, compaction and provider retries.

A text-only pasted skill would omit the requested plugin, resource and executable behavior. An npm/git installation
on the protected controller would execute unreviewed hooks and expose service credentials. Select bounded inert file
snapshots with Jit review, existing connection bindings and work-scoped VM execution instead.

## Import and immutable review

- Accept a public GitHub repository/folder URL, resolving its requested ref once to an immutable 40-hex commit, or an
  owner-selected folder snapshot. GitHub uses unauthenticated, HTTPS/public-address-checked, no-redirect requests; no
  local git/npm process, account token, install script, submodule checkout or archive extraction is involved. Folder
  transport contains only relative regular-file bytes, never an ambient host path. Origin labels on uploaded folders
  are owner assertions; the content digest is the verified immutable pin, not a claim of authenticated remote origin.
- Bound the complete tree, file count, individual/total bytes, request count and elapsed import time. Refuse truncated
  trees, symlinks/submodules, absolute paths, dot/traversal segments, encoded traversal, backslashes, duplicate/case-
  colliding paths, sensitive configuration filenames and credential content before persistence or VM staging. Keep
  exact license/notice bytes. A repository license outside a selected subfolder is included with original provenance.
- Support a root `SKILL.md` and plugin units `skills/<name>/SKILL.md`; metadata remains data. Parse bounded scalar
  frontmatter (`name`, `description`, explicit invocation flag) without YAML evaluation, aliases or executable tags.
  A plugin manifest supplies display identity/version/license only, never permissions. Name unsupported fields/parts,
  malformed units, disabled model invocation, install hooks, platform runtimes and unsupported MCP transports.
- `mcp.json` requirements are inert HTTPS endpoint declarations. Review maps each one to an already reviewed Jit source
  with the same endpoint, catalog hash and review revision. No import connects a server, copies credentials, fetches its
  playbooks or changes its tool decisions. Missing or changed dependencies are explicit and refuse invocation.
- Import/update creates an inert candidate. One exact authenticated review binds its pin, license/parts inventory,
  team or selected Bots, executable-part choice and dependency mappings. A changed candidate/pin requires a new review;
  checking for updates never silently replaces the active version. Old reviewed pins remain evidence. Revoke disables
  future use immediately. Command receipts deduplicate exact owner commands and do not replay imports or executions.

## Existing authority, disclosure and execution

Each reviewed package is a versioned TEAM/POLICY data resource and private DATA15 source. Register it only through
review; include it in the existing default-policy proposal/membership path without widening custom installed rules.
The review discloses the already configured provider recipients that may receive its know-how. New recipients and
external effects retain S16-D07's existing exact in-chat gates. Bot availability narrows TEAM access; it never supplies
a missing work resource, connection, purpose, action classification, model route or budget.

CHAT's scoped skill tools discover/load a reviewed unit and read its bounded resources. They retain the exact
package/unit/pin and actual invocation evidence before releasing bytes. Instructions and resources are labelled data,
never system/owner approval or interpretation input. Loading a skill neither installs nor calls a connection. It gives
the model the actual governed tool names only when those dependencies are in the admitted work and current review.

Executable parts require the review's explicit working-computer choice and ordinary reversible-write work with the
computer resource. They use the actual placed conversation VM session, its finite core-tool/transfer contracts,
workspace, operation claims and deadline. Staging copies inert regular bytes only under the work's inputs directory;
no protected path, service environment, credential or install hook is passed. An execution tool invokes a selected
supported script inside that session, with bounded arguments, observed output and pin provenance. It never calls a
host shell/loader. Missing guest runtimes are honest refusal, not a controller fallback or automatic installation.
Guest root remains the accepted working-VM residual; source pinning does not attest a guest administrator's behavior.

Persist CHAT skill-use pins before disclosure; every subsequent send, tool, result commit and result read checks the
same owner/work, current package revision/pin/availability, selected Bot, dependency review, TEAM and DATA15 ancestry.
Update/revoke during a wait fences later execution and publication. Restart keeps evidence and unknown claims, never
replays a claimed script. Disabling the owning skill service cannot make prior loaded context publishable. Derived
memory retains package-resource ancestry. A computer continuation (ADR 0094) must guard every prior skill-use pin
before copying its evidence; copied skill observations cannot bypass an update or revocation.

## Client, migration and conformance

Add a Skills/plugins tab under the existing Connections experience: GitHub/folder import, exact preview and pin,
license/parts and dependency review, team/Bot availability, executable choice, check/update/revoke and actual status.
Use current protected owner/CSRF ingress and receipt recovery; never retry unknown commands silently. English/Thai,
keyboard focus, mobile width, loading/error/empty/unavailable and authentication-loss withholding are required.
A connected app never causes unrelated skills to load. Chat shows actual use provenance and results, not a model claim
that a package was installed or ran. No placeholder controls.

Use an additive protected skill journal and additive CHAT metadata/capabilities, with the same manifest adoption and
rollback protections as existing S16 services. Missing listed journals refuse instead of resetting reviews/revocations.
S14 default, S15 opt-in, historical private scope, provider configuration and owner-host adoption stay separate.

Required fixtures cover: deterministic content pin independent of file order; update review; real SKILL/plugin/MCP
import; traversal/symlink/hook/host-target refusal; dependency changes; team/Bot and private disclosure fences; actual
instruction/resource and VM-script result; revoke/update during model/tool waits; duplicate/lost-response/restart and
unknown claims; composed production/fallback and computer-continuation guards; native English/Thai import/review/use
and session-loss flows. Record exact tested heads, required CI/review and separate live guest/account/device limits.
This ADR alone does not close #420 or certify those proofs.

## Integration refinement: persistent VM copies and later memory

Static tracing of DATA15 shows an integration requirement before exposing this feature: `vmInput` records every
work source on the VM, and `vmOutput` reacquires those sources under a later work. Giving every package only its own
resource would strand unrelated future work on that VM. Dropping the old source, clearing VM lineage, treating
private bytes as public, or silently widening the new work would break the retained boundary.

The implementation must distinguish the controller's current skill-use permission from data deliberately released
to a working computer. Add a protected DATA15 VM-input projection seam: validate the original admitted source first,
then record an immutable private VM-copy source with its actual computer custody, original package/source/pin,
owner generation, frozen recipient approvals and an equal or narrower Bot scope. The projection is owning host code,
never a model/source callback. It may not downgrade classification, grant an effect, introduce a recipient or ignore
any other source. Non-team private know-how needs that Bot's actual private computer before guest release; a shared
root cannot establish private Bot custody. A missing private computer is an explicit hold with the existing setup
path, not a controller execution fallback. Team-reviewed know-how can use the existing shared computer.

An imported package's review must bind the known recipient configuration as well as its file pin. Do not extend a
past review to future model providers automatically. Mapping a dependency is not blanket consent for other private
inputs: any deliberately configured sharing scope covers this package's exact source only; repository/file/memory
inputs retain their own exact disclosure gates. Execution/working-computer use is an explicit part of the review,
including when a text-only playbook will influence guest commands; no script file is needed to carry private data.

Existing VM copies are ordinary released work data, not an installation of Jit state. Revoking/updating the package
fences current skill-use contexts and future package activation/staging. It does not claim that already released
bytes or arbitrary guest-root copies were erased. Their data source remains private under the original (never
broadened) custody/recipient scope; stronger withdrawal/reset uses the owning computer/data recovery contract. A
later wider review must not promote an older Bot-private copy to team scope. Keep these residuals visible in review.

MEM must preserve the DATA15 lineage of actual tool observations, including later reads of a VM copy in work that
did not load the playbook itself. Use the existing protected derive/inherit primitives and complete retained-source
ancestry; owner corrections must retain those parents. Do not infer source provenance by matching model text, and do
not taint unrelated owner-authored interpretation history with a playbook that was only listed. Private copy scope
must constrain retention as well as physical sends. Prove a following ordinary task, private Bot placement, recipient
changes, correction/forget, package revocation and computer continuation before accepting this refinement. This
section is a selected implementation/proof obligation; the current import/directory core alone does not establish it.

### Implemented lineage core (not end-to-end acceptance)

The protected directory now freezes recipient refs under `s16.skill.recipients.v1`; the exact review/availability
command includes that preview's `recipientsHash`. Text-only playbooks can be reviewed for computer use. DATA15's
owning `projectVmInput` seam validates the admitted original before accepting an equal-classification, no-more-
releasable, equal-or-narrower-Bot VM source. Immutable `s16-skill-vm-copy/v1` rows retain computer custody, original
source/pin, owner generation and frozen recipient refs independently of the current package pointer.

Actual tool observations can be registered as protected DATA15 descendants; optional TEAM/MEM `dataRefs` preserve
these through claims, contexts, summaries, correction and delegation, including observations from a later work that
only read the VM. Inspection/ranking is metadata-only; actual byte handoffs inherit restrictions. A context retains
observation ancestry even when extraction retained no claim. Computer continuations copy those complete context
references instead of recapturing an old instruction. Inference uses an owning, privacy-only standing-resource
projection and final recipient check; it creates no execution authority.

TEAM stamps format 3 for DATA15 ancestry, 4 when combined with file ancestry; MEM stamps 5 and 6 respectively. Existing
formats remain readable under their existing ports. A reader lacking an owning port refuses the newer header before
writable open; later file/timing writes preserve the stronger format. These formats protect rollback, not historical
private-data conversion. The new ports are still opt-in and not yet exposed by the composition/client at this checkpoint.

Deterministic core/regression evidence: 109 tests passed across nine actual files in the selected import, directory,
continuity, disclosure, TEAM, MEM and file-memory suites; typecheck and `git diff --check` passed. The scenario suite
`tests/s16-skills-disclosure.test.ts` covers ordinary following work, private computer placement, frozen-recipient
changes, copied data after revocation/reopen, correction/forget and rollback refusal with unchanged bytes. Real
composed model/tool invocation, executable VM effects and the rendered client remain required before #420 closes.


### Runtime/client implementation checkpoint

The opt-in composition now wires the directory, pure package data resources, guarded instruction/resource tools,
actual placed-session VM staging/script invocation, TEAM/MEM ancestry, artifact-derived input inheritance and shared
client endpoints described in [s16-skills-v1](../contracts/s16-skills-v1.md). The new S15 installer enables the explicit
option; existing installed/omitted options and S14 default retain their contracts. Package resources add no effect
adapter or action rule. An exact review can reconcile membership only under the existing custom-policy comparison.

The Connections Skills/plugins tab uses the actual services for GitHub/folder import, separate bounded file preview,
license/unsupported-part inventory, current dependency mapping, exact sharing/computer/Bot review, candidate update,
revocation and original-identity recovery. An unchanged active pin can be reviewed again when a dependency/provider
changes; a moving GitHub update locator is retained separately from immutable provenance. Human-only units remain
explicitly unavailable for automatic invocation. Chat shows the actual guarded use pins, alongside tool evidence.

Observed checkpoint evidence: 190 deterministic tests passed across 16 selected skills/CHAT/VM/FILE/TEAM/MEM/client/
connections/i18n suites; two actual Chromium scenarios passed in English at 1440 px and Thai at 390 px. The native
scenarios cover a lost import reply/reload with one original import, GitHub/license/unsupported preview, exact review,
actual chat instruction observation, folder candidate update, revoke, keyboard focus, width and session-loss withholding.
The composed scenarios prove an actual fixture-VM file effect through one placed session, before-start revocation and
a lost script reply with retained guest bytes/unknown evidence and no restart replay. Typecheck, diff and immutable
upstream/license checks passed at that checkpoint. Additional re-review, fallback, file/continuation and receiver-change
conformance plus the complete exact-head release suite/review remain required; no live guest/account/host claim follows.

### Composed Bot-scope and continuation conformance

The real composed Bot-only scenario exposed a TEAM refresh constraint: its ordinary reviewed-registration path
correctly refuses changing any existing restriction. SKILL16-01 adds a protected `reviewedBotScope` host check only for
an exact current active package resource/review. On a newer team identity, it may change `allowedBots` alone. Scope,
S14-private origin, denials, purposes, operations and physical coordination remain identical. The original generic
path stays strict when the port is absent; even an accepting port cannot change those other fields. Older sources,
MEM descendants and released private VM copies are not promoted by a later wider package review.

Additional composed fixtures now exercise Bot-only refusal before guest bytes on the shared member, successful
placement/copy custody on its assigned private member, actual mapped MCP reads with the package, and refusal of a
separate private source's outbound arguments. File work uses that same placed session; its observed script result
reports a guest path for collection. A committed file artifact copied into a later input cannot drop the original
package's DATA15 ancestors by omitting its resource. File work also offers only the already-admitted reviewed source
tools, under the same run limit and cleanup as ordinary CHAT. Offering them loads no playbook.

A real computer continuation carries actually observed skill instructions, complete MEM/DATA15 refs and the original
work/workspace. Revocation during its actual model wait withholds the result and further tools. Native English/Thai
scenarios additionally change team availability to a selected Bot and follow the missing-private-computer hold to the
real Computers setup page. These remain deterministic service/client/guest-protocol fixtures, not live physical guest
or account attestations. Full exact-head release validation and external review remain required.

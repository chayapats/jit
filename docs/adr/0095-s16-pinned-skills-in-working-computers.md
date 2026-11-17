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

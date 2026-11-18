# Pinned skill/plugin contract (SKILL16-01)

Engineering contract: [ADR 0095](../adr/0095-s16-pinned-skills-in-working-computers.md). Requirement references remain
S16-AC13; FR-17, FR-20, FR-21, FR-31, FR-35, FR-38, FR-39 and NFR-01/02/07/09/14. This contract records the implementation;
release conformance and exact tested revisions belong in the PR/evidence, not an inferred live-host acceptance.

## Composition and custody

`S15RuntimeConfig.skills: true` explicitly composes `skills.sqlite`, DATA15/MEM ancestry and the shared client capability.
DATA15 is required. The new S15 installer configuration includes it; existing omitted settings, S14 default, legacy
selection, installed policies and owner-host adoption retain their own transition contracts. Missing listed journals
refuse before recreation. Additive adoption preserves an existing unlisted journal and only removes newly created
stores if boot fails. The directory and immutable snapshots stay in protected state; guest copies contain package
bytes only. No service/vault/provider credentials, installation hook, shell or protected state are copied to the guest.

Supported formats are regular `SKILL.md` or `skills/<name>/SKILL.md` instruction bodies, resources, `plugin.json` or
`.claude-plugin/plugin.json` display metadata, and inert `mcp.json`/`.mcp.json` HTTPS streamable-HTTP requirements. Required
connections must already have a current owner tool review at the same endpoint; mapping never installs a connection,
changes a tool's classification or loads unrelated playbooks. Other config/stdio/transports/hooks/install scripts are
inventoried as unsupported or ignored. Human-only units are shown as such and withheld from automatic load/staging;
there is no claim of a manual invocation workflow. The owner can inspect all bounded file bytes as escaped data.

Public GitHub imports resolve once to an immutable 40-hex commit, then verify commit/tree/blob identities, sizes and
regular paths. Imports send no account token, execute no git/archive/package-manager command and follow no redirect.
Uploaded folder labels assert no authenticated remote origin. The SHA-256 pin binds canonical origin and sorted exact
path/hash/size entries. Applicable license/notice bytes remain part of the snapshot, including a repository license
outside a selected subfolder. No upstream runtime/authority, source code or dependency is installed by this importer.

Limits: 64 retained package records, 128 files, 64 KiB/file, 2 MiB/package, 16 instruction units/dependencies, 32,000 bytes
per instruction body, 144 import requests/60 seconds. Capacity refusal never evicts revocation or command identities.

## Exact owner review and recovery

`s16-skill-command/v1` commands are `skill.import`, `skill.update`, `skill.review`, `skill.availability` and `skill.revoke`.
Every command carries its original `requestId`. Changes carry `skillId` and `expectedRevision`; review additionally binds
the exact pin, team or selected-Bot availability, working-computer choice, dependency source/catalog/review revisions
and `recipientsHash` of the displayed currently configured recipient set. These are owner commands under the existing
session, Origin and CSRF checks. Imported text, model output and ordinary messages cannot create a review.

A discovered candidate keeps the active pin unchanged until review. An unchanged active pin can be re-reviewed after
connection/provider changes without re-importing bytes. Review/availability/revoke advances the current resource and
source revision, fencing prior package-use contexts. Membership reconciliation only changes connection/package resource
membership when the installed rules otherwise match the current default proposal; custom policy differences require
the existing rules review. Replaying an old receipt cannot reinstall an old review over a later update or revocation.

Import commands save their original inert input before network work and their resolved commit before tree/blob reads.
An interrupted import resumes that saved input/commit; a changed branch or reselected local folder cannot alter it.
The compact `s16-skill-receipt/v1` is committed before policy membership reconciliation. No script is part of this queue.

Protected API paths, all under `/api/s16/client`:

| Path | Operation | Result |
| --- | --- | --- |
| `/skills` | GET | `s16-client-skills/v1` current owner records, Bots, dependency metadata and limits |
| `/skills/<id>` | GET | `s16-client-skill/v1` exact active/candidate metadata, inventories and copy count |
| `/skills/<id>/files?pin=…&path=…` | GET | One bounded file of that record's actual active/candidate pin |
| `/skills/<id>/review-preview` | POST `{pin, dependencies}` | Read-only recipient refs and exact review hash |
| `/skills/commands` | POST command | Compact durable receipt; no automatic client retry |
| `/skills/commands/<requestId>` | GET | Pure `s16-skill-command-status/v1`; starts no import, membership or work |
| `/skills/commands/<requestId>/resume` | POST `{}` | Explicit original inert import or committed membership reconciliation |

The client preserves only an opaque command ID in the Connections recovery fragment. Folder bytes, previews, CSRF and
credentials remain ephemeral. Losing the response or reloading never automatically sends another command. Every
post-wait response rechecks the owner; session loss withholds package data and ignores stale asynchronous responses.

## Scoped runtime and later data

The public tools `skills_list`, `skill_load`, `skill_resources` and `skill_resource` use actual work admission, TEAM,
POLICY read claims, bounded chunks and current exact reviews. Before bytes are released, CHAT transactionally retains
`s16-skill/v1` use provenance (`SkillUse`) and stamps its owning contract; DATA15 records the original source. Merely
composing a connection or offering the generic tools does not load a playbook. Every later send, tool, result commit,
result read and computer continuation rechecks loaded pins/dependencies. Source text remains know-how with no authority.

`skill_stage` and `skill_run` require reviewed computer use and ordinary reversible-write/effect work. The original
placed CHAT session is shared with the normal/file workflow; no second computer or host-local fallback is opened.
Exact files transfer as individually bounded regular VM writes, then assemble below that work's guest `inputs` path.
Only an inventoried bash/python3/node/bun script can be selected; arguments are literal bounded strings. Execution uses
the actual session's public backend, policy claims, deadline, cancellation and evidence. Missing runtimes produce actual
guest failure; Jit does not install a runtime or retry an uncertain operation. Results identify pin/script/session and
observed VM evidence, with guest-reported exit/output rather than an attestation of hostile guest root.

Working-computer use includes text guiding ordinary computer commands. DATA15 validates the admitted package source
before projecting an immutable private `s16-skill-vm-copy/v1` with actual computer custody, owner generation, original
pin/source, frozen recipients and equal-or-narrower Bot scope. Bot-only know-how requires that Bot's private computer;
shared guest root is insufficient. Ordinary later work can read released VM data under the computer resource while
retaining those private-data restrictions; it is not silently granted the original package resource. Updating or
revoking a package fences its activation/current contexts, and does not erase already released guest-root copies.
Later broader reviews cannot promote an older private copy. Other private inputs retain their independent gates.

Actual tool observations retain DATA15 descendant refs in TEAM/MEM, even if extraction retained no claim. Selection is
metadata-only; actual selected bytes inherit complete source restrictions. Correction, forget, delegation, continuations
and artifact-derived inputs preserve ancestry; original S14-private scope remains S14-private. Frozen sharing covers
only this package/copy and the explicitly listed recipients, never future providers or unrelated private inputs.

Rollback format fences: CHAT 5 for loaded skill pins; TEAM 3 for DATA15 ancestry/4 with file ancestry; MEM 5/6 respectively.
TEAM can refresh only allowedBots on a newer team resource through the owning exact active-package review; all other restrictions, physical identity and S14-private scope remain unchanged.
Readers without the owning ports refuse before writable open. Later file/timing writes preserve the stronger header.

## Client and conformance

Connections has a capability-gated Skills/plugins tab for GitHub/folder inspection, exact pin/license/parts preview,
dependency mapping, team/Bot and computer-use review, update, revoke and identity-only recovery. All private reads stay
behind the existing owner session. English/Thai, keyboard focus, mobile width, unknown outcomes and authentication loss
are covered by the actual bundled client scenario suite. Chat exposes actual guarded use pins and observed tool evidence.

Deterministic tests: `s16-skills-{package,github,service,continuity,disclosure,composition,continuation}.test.ts` and the opt-in native
`s16-skills.browser.test.ts`. Broader FILE/TEAM/MEM/CHAT/connections and installer/package checks remain part of release
validation. Real subscription/account/device, hostile-root network enforcement, power-loss and owner-host cutover evidence
are independently owned by #408/#431/#432; these deterministic fixtures do not certify them or invoke a billable service.

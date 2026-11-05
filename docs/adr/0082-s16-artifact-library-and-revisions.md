---
status: selected for ART16-01 implementation; deterministic composition and browser evidence; live acceptance separate
date: 2026-11-05
scope: ART16-01 (#407); S16-AC04, S16-AC20 (library part); FR-04/07/16/18/42; NFR-05/06/07/08
---

# Artifact library, immutable revisions and an isolated HTML viewer

## Context

FILE16-01A delivered committed immutable artifacts, but only inside the bounded recent conversation window, with no revision path and no HTML handling. ART16-01 needs four things: a durable library, exact provenance, revisions that never mutate the original, and an active-document viewer that cannot reach cookies, the network or the parent.

## Decision

**Library = FileStore staging index ∩ CHAT committed references, recomputed per read.** FileStore already records every staged artifact with request, work, conversation and inputs. CHAT already owns publication through its committed reference set and publication guard. The library intersects the two on every request and pages by an opaque `createdAt.id` position. No second index, mirrored revocation flag or cached result exists, so withdrawal or a failed publication cannot survive in a stale page. A dedicated index can replace the linear scan behind the same contract if single-installation scale ever needs it.

**Revision input = a copied, parent-linked upload in the same conversation.** "Revise this file" copies the exact committed bytes into a new upload record with an `origin` link. The owner then sends an ordinary v2 file message, so the revision runs through the same file tools, POLICY reads/actions, DATA15 and MEM paths as any file task. Alternatives considered:

- *Referencing artifacts directly in `files`.* This would widen every file port, the receipt union, the CHAT format and the memory adapter at once.
- *Editing in place.* This violates immutability and the "old and new hashes remain distinct" acceptance case.

The copy keeps precise ancestry. Its availability is computed from its parent chain. Work stamps and fences every transitive original source, and MEM pins include them. Withdrawal therefore reaches every descendant without a second write.

**Same-conversation adoption.** Keeping the revision in the producing conversation preserves its Bot and private scope. Cross-conversation reuse waits for SPACE16/TEAM scope rules.

**HTML preview = opaque, script-free sandbox served by the service.** A token-free `sandbox` CSP response, embedded only in a token-free sandboxed iframe, gives an opaque origin with no scripts, forms, popups, top navigation or downloads. Fetch directives are closed except inline style and data images. The embedding page's `frame-src 'self'` refuses link navigation to other origins.

A `srcdoc` viewer was rejected: it inherits the page's strict style policy, so documents render unstyled. A separate preview origin was also rejected: it needs installation DNS/TLS work the single-origin install does not have. The endpoint accepts only same-origin iframe navigations. Interactive HTML remains out of scope until a reviewed execution capability exists.

**Grammar.** The narrow terminal-deliverable grammar gains "revised/updated", `html`, `page` and the Thai revised-file qualifiers. It still recognizes only explicit terminal local-file requests on v2 commands. Model output, file text and the library grant nothing.

## Consequences

- No migration, installed rule or default changes. Existing artifacts list as revision 1. The first adopted input stamps the file journal `user_version=3` in the same transaction; the stamp is monotonic, so a later binary upload never lowers it to 2. Older releases accept only formats 1/2 and refuse to open the journal, instead of ignoring `origin` and treating a copied input as an independent source after its ancestor is withdrawn. Rollback after adoption therefore needs the same compatible release/state review as other S16 file adoption (ADR 0076/0078).
- Library cost is linear in staged artifacts per read, plus one CHAT owner view per distinct request.
- Upstream reuse is limited to the already attributed `ArtifactFileCard` adaptation. Its provenance pin and modification notice are updated. No new upstream source or dependency is imported.
- Pending: Bot-scoped library filters and cross-object search (#428), file-to-VM output collection (#433), native/mobile viewers (#425/#426) and live/owner-host evidence (#431/#432).

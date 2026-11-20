---
status: selected for SPACE16-01 implementation; acceptance evidence pending
date: 2026-11-20
scope: SPACE16-01 (#428); S16-AC20; FR-01/04/05/10/16/18/22/24/35; NFR-07/08/11/12/13
---

# Authorized cross-object search and owner labels

## Baseline and alternatives

Implementation starts at main `0b1e69b9a015413e15f2aa35dbb35e9bf59c5745`.
#412, #407 and #416 are closed. CHAT owns history/publication, WORK owns
responsibilities, routines own their configuration, MEM owns sourced claims and
FileStore intersected with committed CHAT references owns artifacts. Existing
navigation windows (32 messages, 64 conversations/routines/responsibilities)
cannot implement installation search. Existing memory and artifact search
already revalidate owning services instead of copying their content.

Rakazo at the retained immutable reference
`abf3c08145a05cba92a912d6c24fdfb5f569d0e0` supplies the product concept of
cross-object navigation. Porting its backend/search storage would add another
authority stack. An FTS mirror in Jit would improve large-installation latency
but introduce a second text-erasure, scope and refresh protocol. Neither is
needed before measured installation-scale evidence. No new upstream source,
assets or dependency is imported by this slice; existing mixed-license notices
and provenance remain applicable.

Select a bounded, fresh projection from the five existing owners. Search scans
at most 10,000 identities across those families and refuses the entire read on
overflow; it never labels a truncated search complete. No text index, snippets,
query history, result cache or model call is persisted. A later measured index
can implement this same public contract only with equivalent withdrawal proof.
Stable owning identities, current scoring and a filter-bound keyset cursor
support pagination across service restart, model and computer changes.

## Authority and organization

Owning guards and MEM history suppression precede matching, ranking, snippets,
counts, facets and pagination. A Bot filter selects the producer/history owner;
MEM additionally checks every transitive private scope. It grants no Bot new
access. The authenticated installation owner may inspect currently authorized
Bot-private material without a Bot filter, as in existing MEM owner inspection.
Withdrawn material and another owner's/generation's objects are absent.

Labels are owner-authored organization over `{kind,id}`. Store label sets and
exact command receipts in additive CHAT SQLite tables, inside the existing
process lease and synchronous FULL writer transaction. Store no object text,
title, source copies, work grants or credentials. Current target availability
is required for reads, mutations and original-command recovery. A changed set
requires its exact revision; a lost reply retains the original command identity.
Moving labels never moves data, changes scope, changes lineage or creates work.

Older binaries can ignore these additive tables safely: labels never affect
authority or content interpretation. CHAT's current file/skill format stamps
remain unchanged. Labels are part of CHAT backup bytes; restoring older bytes
may restore older organization but cannot restore source access. Existing
withdrawal and current-state reconciliation still decide visibility.

Do not introduce Spaces. The installation remains single-owner; labels and
existing Bot/source filters solve organization without a new availability,
tenant, isolation or migration boundary. This choice does not reduce search
coverage. No S14 default, S15 opt-in, installed policy, retained private scope,
owner host or Schway contract changes.

## Client and acceptance

The primary agent owns the authored Search page, source/type/Bot/date/label
filters, current result counts, keyboard entry and label editing. Reuse the
existing S16 design handoff and Mobbin research. Source opening first resolves
the result again and then uses the existing protected destination; a search
cursor or label is never a download, execution or approval token.

The [versioned contract](../contracts/s16-search-v1.md) owns bounds, exact
transport, compatibility and recovery. Required evidence includes all five
real service families, old history beyond navigation windows, private and
withdrawal filtering before counts, stale open/download refusal, exact label
conflict/retry/restart, unchanged source lineage and real English/Thai browser
flows at desktop/mobile widths. No live host/account/device acceptance is
claimed by deterministic fixtures. #392 remains open.

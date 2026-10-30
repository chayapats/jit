---
status: accepted for opt-in implementation
scope: BOT14-02; refines ADRs 0045/0046/0048 and authority resolution Q7
---

# Exact Bot policy generations and lifecycle cleanup

Confirmed behavior is owner-only exact proposal/preview acceptance, no implicit widening of work/resources/accounts, immediate fencing and no resurrection. This implementation uses a separate capability proposal and a durable transition instead of editing a live Bot snapshot in place. All accepted policy changes invalidate old grants/contexts; this includes widening, so a tool-less Jit can be repaired without granting old work the new tools. Changes create a fresh generation and keep Bot.enabled false until actual settlement/native retirement. Reenable similarly requires a new exact proposal/current selected ceiling and never renews old authority.

Main Jit cannot retire/delete in this phase, because no coordinator replacement contract exists. Capability repair remains available. A stale restored generation fails closed and can be reenabled only with current owner selection. Deletion leaves a permanent identity tombstone.

A lifecycle preview binds exact owned/dependent identities and revisions, including computer components and native contexts. Retirement requires explicit retention of history/evidence; it stops processes without wiping volumes. Retained owner evidence is separate from executable context and still obeys original lineage withdrawals. Computer-only reset/delete remains independent. Whole grants containing a changed Bot stop rather than silently rewriting their participant sets; unrelated grants remain live.

Deletion writes independent root/generation and forward lineage/context/share withdrawal facts before cleanup, preserving foreign originals. Native context identities are retained outside application images before scrub/pruning. Local payload redaction preserves immutable hashes/identities and revoked authority facts; narrowly scoped tombstoned work/attempt markers allow cache erasure without creating mutable live grants. Cleanup waits for actual work/chat/input settlement, then performs retry-safe local, computer and public-native stages. Missing/busy/partial/failed-close native outcomes remain unresolved.

Schema 14 refuses unreleased earlier stores and reconciles the current independent ledger before projections or worker activation. Restored policy generations become disabled/retired with empty ceilings for a new owner review; deleted roots reapply withdrawal and cleanup. OPS14-01 still owns managed backup and quarantined activation. See app.bot-lifecycle/v1 and its deterministic crash/race evidence; product UI and live host evidence remain separate.

## Reconciliation with main and #262 handoff

Combined schema 14 is one version above both unreleased parents, retains every table and refuses 1–13 without migration. Bot retirement and deletion use main's graph stop/capacity/settlement and independent share/native recovery paths. Retained-evidence inspection bypasses only a changed historical Bot snapshot with an exact independent owner-retention fact; producer traversal still follows every graph input and delegation parent, plus source/access/share and destructive computer withdrawals. It does not recurse through its own result source to decide the retention exception.

Fresh installs expose the finite built-in slot candidates from ADR 0053 through the free-slot query; adding them or web_search/web_fetch still requires the owner's exact current capability proposal acceptance. The boot timestamp on app.recovery.view is process-local application construction time, not a claim about an earlier native event or successful recovery. Routines remain background graphs behind the complete recovery gate, including native close.

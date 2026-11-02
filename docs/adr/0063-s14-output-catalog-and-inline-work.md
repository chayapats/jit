---
status: accepted for owner-authorized Plain implementation
date: 2026-11-02
scope: PLAIN14-04/05; S14-AC06/08/09/13; FR-07/16/18/24/25/29/42; NFR-07/08/11/13
---

# Retained output navigation and inline Work

The 2026-11-01 handoff recorded a cross-work Reports/Artifacts Library and inline Work outcomes. The owner authorized completion, remediation, CI/Greptile babysitting and merge on 2026-11-02, with the existing task-specific UI/UX author exception. The latest Bots/conversations/Work primary navigation remains; Library is grouped under knowledge. This does not revive a superseded feature flag or old UI compatibility requirement.

## Read contracts

`S14Reports.catalog(actor, {before?,limit?})` returns `{items:ReportView[],nextBefore:number|null}`. Default limit is 20 and the hard maximum is 50; positive safe-integer row cursors are exclusive and newest-first. A later insert does not shift an already selected older page. One extra identity determines whether a next page exists. Every item passes through existing owner authentication, reconciliation and `read`; withdrawn payloads and files remain withheld. The cursor is untrusted navigation data, never authority. There is no schema change or new write command.

`S14Reports.latest(actor, workIds)` reads at most 24 distinct named work heads in one owner/reconciliation transaction. Chat prefetches this for its newest 24 granted work items. It returns the latest revision even when unavailable, rather than silently substituting an older readable revision. All work cards retain existing exact detail/report links outside that preview window. Current WorkView result/effect projections remain the source of inline outcomes and controls. No model output can manufacture a report, grant or acceptance.

`GET /library?tab=reports|artifacts&before=<cursor>&limit=<count>` is an authenticated HTML view over the bounded catalog. It has no new JSON command/API. Original Work/Bot identity, revision, coverage, owner-review facts and download metadata stay separate. Unavailable rows show only stable report/work identity and withdrawal status. Downloads remain exclusively in the existing artifact gateway.

## Presentation and updates

Inline results are escaped untrusted data. Available reports add actual revision/coverage/review facts, limitations, a preview of up to eight distinct source identities and immutable file metadata. The complete Evidence/Report detail views remain linked. Sources are current gateway-validated report evidence, not inferred from raw model prose. Private-source identities use their typed labels and Brief links rather than invented public URLs.

Generic/personal exact decisions reuse existing components/typed commands. Unknown remains reconcile-only. Git approval retains its exact diff/check review page; inline presentation cannot shortcut that contract. Task acceptance remains distinct from start, and Stop retains its named grant/settlement meaning. When Progress already displays the same work, it owns the exact controls to avoid duplicate decisions.

Each work's primary inline region can refresh while its receipt disclosure or another work's focused control defers the surrounding thread. Focused forms are not replaced. Root polling remains pinned to the displayed conversation as corrected in PLAIN14-03; browser storage restores text only. Native no-script links/forms, CSP and session/Host/Origin/CSRF/escaping boundaries remain unchanged.

This is presentation plus additive bounded owner reads, not execution authority, provider support, schema migration or deployment/cutover acceptance. Device/AT evidence remains attributed to actual tested builds and prior deferrals.

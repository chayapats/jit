---
status: accepted for opt-in implementation
scope: REPORT14-01, S14-AC06/08; refines ADR 0047
---

# Committed report revisions and private snapshots

Separate report readiness, evidence coverage and owner completion. A free-form result may be inspectable without a report. The trusted result handler alone publishes a validated immutable report revision with Markdown, an evidence manifest and optional bounded workspace snapshots. All report/result/source/file rows commit together in SQLite. BLOB storage keeps this local slice atomic without filesystem orphan/rename or arbitrary host-path delivery.

Citations resolve actual read evidence through app.parallel.citation. Synthesis receives only accessible committed handoffs, with explicit gaps and bounds. Quote, inference, snippet/excerpt/page, cache, freshness and conflict remain distinct. Optional owner-start evidence targets define mechanically checkable coverage; absent targets retain a machine-unverified completion-rule gap. Models cannot certify owner completion, invent a coverage target or widen authority.

Only portable UTF-8 Markdown/text/JSON files are delivered initially. Workspace snapshots use the exact guarded computer backend and stable runner observation, with relative-path, symlink/type/size/hash checks. Downloads use opaque IDs, attachment responses, no-store, nosniff and sandbox/default-none CSP. No active app-origin HTML rendering or arbitrary host-file export is introduced.

Report/file sources inherit original memory source and access pins. Publication and every download revalidate them. The independent ledger retains identity-only revoked access/share revisions, stopped execution grants and reset/deleted computer generation ranges so a stale application image cannot restore their descendants. This is part of the ticket's revocation/restore invariant, not a new execution permission. Full managed recovery/backup remains its tracked slice. See the delivered app.report-artifacts/v1 and app.artifact-gateway/v1 contracts.

## PR #273 logic-gap refinement

Use a separate revisioned per-work review record for explicit owner acceptance of the exact latest available report revision. Immutable report/artifact bytes and evidence coverage do not change. New publication or lineage withdrawal invalidates acceptance; retry receipts remain historical facts. The owner command uses the review revision plus report ID/revision and the existing receipt/audit boundary. Schema 9 adds report_reviews and refuses earlier unreleased stores.

Service-observed missing evidence uses a discriminated ReportGap union; model-proposed missing prose stays in modelMissing, including exact look-alikes of valid service codes or IDs. Product rendering and generated manifests keep these origins separate. The existing review fact/coverage copy is reused; the acceptance control remains an explicit follow-up for the UI agent.

Combined schema 11 retains this report/review storage together with the first-run computer activity table; earlier unreleased schemas 1–10 refuse with fresh-state. The existing Opus-authored acceptance control and first-run/recovery surfaces are both retained. The integrated deterministic journey covers fresh owner setup and fake-store device sign-in, independent overlapping public Schway hosts, committed cited synthesis, exact-revision review and private artifact downloads.

## PR #273 withdrawal review

Citations are an incomplete description of data used by synthesis. Enforce retained producer fences at the shared source-currentness boundary, with an additive producer-attempt pin on attempt-derived sources and durable origin resolution for existing schema-10 outputs. Retained attempt validation follows all actual graph inputs and delegation parents iteratively. Context/tool/publication guards and report/staging reconciliation therefore cover uncited transitive text and every report/artifact copy. Preserve committed evidence after ordinary execution stop/expiry; destructive computer reset/delete and revoked source/access/Bot/resource lineage withdraw descendants. No schema bump or required export change is needed.

## EVID14-01 live candidate failures

Real Codex research on both Linux architectures retrieved public sources but final candidates failed exact quotation or expanded report-size validation. Keep those checks unchanged. The native executor now checks a candidate through the actual publisher in a rolled-back transaction before retiring its session. It may request one tool-free correction under the same live authority and remaining call budget. No result/source/report/artifact is committed by validation; final publication rechecks every fence. A second invalid candidate remains failed. This is bounded report formatting/citation correction, not replay of a read/effect or permission to invent evidence.

`S14Reports.validateCandidate(attemptId:string,output:WorkOutput):void` is a trusted internal seam, not an HTTP or model tool. `schwayResearch(directory,app,scriptedModel?,clock?):WorkExecutor` uses only public `schway/host` options, the remaining owner deadline and a labelled per-run call slice; optional model/HostClock arguments are deterministic test seams. The model sees no tools when it must finish or correct a candidate. Native failure categories preserve safe quota/auth and application budget reasons, without raw provider errors or route fallback. Report usefulness and real-host reruns remain separate evidence.

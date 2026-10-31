import { containsCredential } from "../security/credentials";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { record, type S14Application } from "./application";
import type { Attempt, Work, WorkOutput } from "./authority-types";
import type { MemoryRef } from "./memory-types";
import type { WebRead } from "./parallel-types";
import type { Artifact, EvidenceRequirement, Report, ReportCitation, ReportClaim, ReportCommand, ReportEvidence, ReportGap, ReportProposal, ReportReceipt, ReportReview, ReportView, StagedArtifact } from "./report-types";
import type { OwnerActor } from "./types";
import { artifactHash, validateArtifact } from "./artifacts";
import { canonical, exact, identity, integer, text } from "./validation";
import { publicWebUrl } from "./parallel-protocol";

const id = () => crypto.randomUUID().replaceAll("-", "");
const ref = (source: MemoryRef): MemoryRef => ({ id: source.id, revision: source.revision, generation: source.generation });
const coverageRank = { snippet: 0, excerpt: 1, full_content_returned: 2 };
const scopeRank = { snippet: 0, excerpt: 1, page: 2 };
function strings(value: unknown, maximum = 32): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length) throw new AppError("invalid_report_list");
  for (const item of value) text(item, 2000);
}

/** Validates exact owner evidence targets at work start; model output cannot replace required coverage. */
export function evidenceRequirements(value: unknown): asserts value is EvidenceRequirement[] {
  if (!Array.isArray(value) || value.length > 32) throw new AppError("invalid_evidence_requirements");
  const ids = new Set<string>();
  for (const target of value) {
    exact(target, ["id", "label", "url", "coverage", "freshness"]);
    identity(target.id); text(target.label, 2000);
    if (containsCredential(target.label as string)) throw new AppError("credential_content_refused", 403);
    if (ids.has(target.id)) throw new AppError("invalid_evidence_requirements");
    ids.add(target.id);
    if (target.url !== null) { if (typeof target.url !== "string") throw new AppError("invalid_evidence_requirements"); publicWebUrl(target.url); }
    if (!["snippet", "excerpt", "full_content_returned"].includes(target.coverage as string) || !["any", "live_reported"].includes(target.freshness as string)) throw new AppError("invalid_evidence_requirements");
  }
}

/** Validates untrusted report claims and publishes immutable files only inside a live attempt-fenced transaction. */
export class S14Reports {
  constructor(readonly app: S14Application) {}

  /** Checks the actual publication contract in a rolled-back transaction; creates no result, report, source or artifact. */
  validateCandidate(attemptId: string, output: WorkOutput): void {
    const rollback = {};
    try {
      this.app.store.transaction(tx => {
        const attempt = this.app.authority.guard(tx, attemptId);
        const content = text(output.text, attempt.snapshot.outputBytes);
        if (output.report) this.publish(tx, attempt, output.report, Buffer.byteLength(content));
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  }

  private gap(missing: Map<string, ReportGap>, gap: ReportGap): void { missing.set(canonical(gap), gap); }

  private reviewIn(tx: AppTransaction, workId: string): ReportReview {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM report_reviews WHERE work_id=?", workId);
    return row ? JSON.parse(row.record_json) as ReportReview : { workId, revision: 0, reportId: null, reportRevision: null, completion: "owner_review_required", acceptance: null };
  }

  private saveReview(tx: AppTransaction, review: ReportReview): void {
    tx.run("INSERT INTO report_reviews VALUES (?,?) ON CONFLICT(work_id) DO UPDATE SET record_json=excluded.record_json", review.workId, canonical(review));
  }

  /** Reads the current exact review target and its optimistic revision without starting work. */
  review(actor: OwnerActor, workId: string): ReportReview {
    identity(workId);
    return this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor); record(tx, "work_items", workId); this.reconcile(tx);
      return this.reviewIn(tx, workId);
    });
  }

  /** Records explicit owner acceptance separately from immutable report bytes, coverage and execution authority. */
  apply(tx: AppTransaction, command: ReportCommand): ReportReceipt {
    exact(command.payload, ["reportId", "reportRevision"]);
    identity(command.payload.reportId); integer(command.payload.reportRevision, 1);
    this.reconcile(tx);
    const view = this.read(tx, command.payload.reportId);
    const workId = view.state === "available" ? view.report.workId : view.workId, review = this.reviewIn(tx, workId);
    if (review.revision !== command.expectedRevision || review.reportId !== command.payload.reportId || review.reportRevision !== command.payload.reportRevision) throw new AppError("stale_revision", 409);
    if (view.state !== "available") throw new AppError("report_unavailable", 409);
    if (review.acceptance) throw new AppError("report_already_accepted", 409);
    review.acceptance = { reportId: view.report.id, reportRevision: view.report.revision,
      ownerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation, requestId: command.requestId, acceptedAt: this.app.now() };
    review.completion = "owner_accepted"; review.revision++;
    this.saveReview(tx, review);
    return { kind: command.kind, requestId: command.requestId, review, conversationId: record<Work>(tx, "work_items", workId).conversationId };
  }

  private citation(tx: AppTransaction, attempt: Attempt, value: ReportCitation): ReportEvidence {
    exact(value, ["attemptId", "id", "revision", "quote", "scope"]);
    identity(value.attemptId); identity(value.id); integer(value.revision, 1); text(value.quote, 4096);
    if (!["snippet", "excerpt", "page"].includes(value.scope)) throw new AppError("invalid_report_citation");
    if (value.attemptId !== attempt.id && !attempt.step?.inputs.some(input => input.attemptId === value.attemptId && input.evidence.some(e => e.id === value.id && e.revision === value.revision))) throw new AppError("citation_not_read", 403);
    const evidence = this.app.personal.reads.evidence(tx, value.attemptId).find(source => source.id === value.id && source.revision === value.revision)
      ?? this.app.parallel.citation(tx, value.attemptId, value.id, value.revision);
    if (evidence.workId !== attempt.workId || !evidence.content.includes(value.quote)) throw new AppError("citation_quote_mismatch", 403);
    return evidence;
  }

  private normalizeClaims(tx: AppTransaction, attempt: Attempt, proposed: ReportProposal["claims"], targets: EvidenceRequirement[], missing: Map<string, ReportGap>): { claims: ReportClaim[]; covered: Set<string> } {
    const claimIds = new Set<string>(), covered = new Set<string>();
    const claims: ReportClaim[] = proposed.map(value => {
      exact(value, ["id", "text", "kind", "citations", "covers", "conflicts"]);
      identity(value.id);
      if (claimIds.has(value.id) || !["quote", "inference"].includes(value.kind)) throw new AppError("invalid_report_claim");
      claimIds.add(value.id);
      const content = text(value.text, 4096);
      strings(value.covers); strings(value.conflicts);
      if (value.covers.some(key => !targets.some(target => target.id === key))) throw new AppError("invented_coverage_target", 403);
      if (!Array.isArray(value.citations) || value.citations.length > 8) throw new AppError("invalid_report_citations");
      const evidence = value.citations.map(citation => this.citation(tx, attempt, citation));
      const flags = new Set<ReportClaim["flags"][number]>();
      if (value.kind === "inference") flags.add("inference");
      if (value.conflicts.length) flags.add("conflicting");
      let supported = evidence.length > 0;
      for (let index = 0; index < evidence.length; index++) {
        const source = evidence[index]!, citation = value.citations[index]!;
        if (source.coverage === "snippet") flags.add("snippet");
        if (source.coverage === "excerpt") flags.add("excerpt");
        if (source.freshness === "cached_reported") flags.add("cached_reported");
        if (source.freshness === "unknown") flags.add("freshness_unknown");
        if (scopeRank[citation.scope] > coverageRank[source.coverage] || citation.scope === "page" && source.truncated) supported = false;
      }
      if (value.kind === "quote" && !value.citations.some(c => c.quote === content)) supported = false;
      if (!supported) { flags.add("unsupported"); this.gap(missing, { kind: "unsupported_claim", claimId: value.id }); }
      if (value.conflicts.length) this.gap(missing, { kind: "conflicting_claim", claimId: value.id });
      for (const key of value.covers) {
        const target = targets.find(t => t.id === key)!;
        const matching = evidence.some(source => coverageRank[source.coverage] >= coverageRank[target.coverage] &&
          (!target.url || source.url === target.url && (source.requestedUrl === null || source.requestedUrl === target.url)) &&
          (target.freshness === "any" || source.freshness === "live_reported") && (!source.truncated || source.tool === "personal_read" && target.coverage !== "full_content_returned"));
        if (supported && matching && !value.conflicts.length) covered.add(key);
      }
      return { ...structuredClone(value), text: content, support: supported ? "supported" : "unsupported", flags: [...flags], evidence };
    });
    for (const claim of claims) for (const conflict of claim.conflicts) if (conflict === claim.id || !claimIds.has(conflict)) throw new AppError("invalid_report_conflict");
    for (const target of targets) if (!covered.has(target.id)) this.gap(missing, { kind: "required_evidence", targetId: target.id });
    return { claims, covered };
  }

  private files(report: Report): { name: string; mediaType: Artifact["mediaType"]; bytes: Uint8Array }[] {
    const markdown = [`# ${report.title}`, "", `Coverage: ${report.coverage}; owner acceptance is a separate live service record`, "",
      ...report.claims.flatMap(claim => [`## ${claim.id} (${claim.kind}; ${claim.support})`, claim.text, `Flags: ${claim.flags.join(", ") || "none"}`,
        ...claim.evidence.map(e => `Source: ${e.id}@${e.revision}; ${e.url}; ${e.coverage}; ${e.freshness}`), ""]),
      "## Missing evidence", ...report.missing.map(item => `- ${JSON.stringify(item)}`), "", "## Model-reported gaps (untrusted)", ...report.modelMissing.map(item => `- ${JSON.stringify(item)}`), "", "## Limitations", ...report.limitations.map(item => `- ${item}`)].join("\n");
    const manifest = JSON.stringify({ reportId: report.id, revision: report.revision, workId: report.workId, attemptId: report.attemptId, coverage: report.coverage,
      claims: report.claims.map(claim => ({ id: claim.id, support: claim.support, citations: claim.citations, evidence: claim.evidence.map(({ content: _content, ...metadata }) => metadata) })),
      covered: report.covered, missing: report.missing, modelMissing: report.modelMissing, limitations: report.limitations }, null, 2);
    return [
      { name: `report-r${report.revision}.md`, mediaType: "text/markdown" as const, bytes: new TextEncoder().encode(markdown) },
      { name: `evidence-r${report.revision}.json`, mediaType: "application/json" as const, bytes: new TextEncoder().encode(manifest) },
    ];
  }

  private budgetError(attempt: Attempt, claims: ReportClaim[], phase: "artifacts" | "snapshot", actualBytes: number): AppError {
    const costs = new Map<string, { attemptId: string; id: string; revision: number; bytesPerReference: number; references: number }>();
    for (const claim of claims) for (const source of claim.evidence) {
      const previous = costs.get(source.id);
      if (previous) previous.references++;
      else costs.set(source.id, { attemptId: source.attemptId, id: source.id, revision: source.revision,
        bytesPerReference: Buffer.byteLength(JSON.stringify(source)), references: 1 });
    }
    const bounded: NonNullable<ReturnType<typeof costs.get>>[] = [];
    for (const cost of costs.values()) {
      if (bounded.length >= 16 || Buffer.byteLength(JSON.stringify([...bounded, cost])) > 4096) break;
      bounded.push(cost);
    }
    // Only validated identities and measured sizes leave this boundary, never source content or vendor errors.
    return new AppError("report_output_budget_exhausted", 409, { phase, actualBytes, outputBytes: attempt.snapshot.outputBytes,
      citationCosts: JSON.stringify(bounded), omittedSources: costs.size - bounded.length });
  }

  /** Commits validated report, source lineage and immutable downloadable snapshots atomically with its producing result. */
  publish(tx: AppTransaction, attempt: Attempt, proposal: ReportProposal, resultBytes: number): Report {
    this.app.authority.guard(tx, attempt.id);
    exact(proposal, ["title", "claims", "missing", "limitations", "artifactIds"]);
    const title = text(proposal.title, 200), missing = new Map<string, ReportGap>();
    strings(proposal.missing); strings(proposal.limitations); strings(proposal.artifactIds, 4);
    const modelMissing = proposal.missing.map(value => text(value, 2000));
    for (const gap of attempt.step?.gaps ?? []) this.gap(missing, { kind: "handoff", stepId: gap.stepId, reason: gap.reason });
    if (!Array.isArray(proposal.claims) || !proposal.claims.length || proposal.claims.length > 32) throw new AppError("invalid_report_claims");
    const targets = attempt.snapshot.grant.command.payload.requiredEvidence ?? [];
    for (const step of attempt.step ? this.app.graph.steps(tx, attempt.workId) : []) {
      if (step.id !== attempt.step?.id && step.state !== "committed") this.gap(missing, { kind: "step", stepId: step.id, state: step.state });
    }
    if (!targets.length) this.gap(missing, { kind: "completion_rule_not_machine_verified" });
    const { claims, covered } = this.normalizeClaims(tx, attempt, proposal.claims, targets, missing);
    // All failures remain visible to the owner even if a model omits them from its proposed prose.
    const reads = tx.all<{ record_json: string }>("SELECT record_json FROM web_reads WHERE json_extract(record_json,'$.workId')=?", attempt.workId).map(r => JSON.parse(r.record_json) as WebRead);
    for (const read of reads) {
      if (read.outcome !== "success") this.gap(missing, { kind: "read", readId: read.id, outcome: read.outcome });
      for (const url of read.missing) this.gap(missing, { kind: "missing_url", url });
      for (const failure of read.failures) this.gap(missing, { kind: "failed_url", url: failure.url, failureKind: failure.kind });
    }
    for (const gap of this.app.personal.reads.gaps(tx, attempt.workId)) this.gap(missing, gap);
    const key = id(), packet = this.app.memory.attemptPacket(tx, attempt.id), lineage = this.app.memory.derive(tx, packet);
    const staged = proposal.artifactIds.map(key => {
      identity(key);
      const row = tx.get<{ record_json: string; content: Uint8Array }>("SELECT record_json,content FROM artifact_staging WHERE id=? AND attempt_id=?", key, attempt.id);
      if (!row) throw new AppError("artifact_not_staged", 403);
      const metadata = JSON.parse(row.record_json) as StagedArtifact;
      if (!this.app.memory.sourceCurrent(tx, metadata.source)) throw new AppError("artifact_lineage_withdrawn", 403);
      validateArtifact(row.content, metadata, attempt.snapshot.outputBytes);
      lineage.derived.push(metadata.source);
      return { metadata, bytes: row.content };
    });
    // Own and actually handed-off evidence must remain in the conservative publication ancestry.
    for (const claim of claims) for (const source of claim.evidence) lineage.derived.push(ref(source));
    lineage.derived = [...new Map(lineage.derived.map(r => [r.id, r])).values()];
    const source = this.app.memory.source(tx, { id: key, botId: attempt.snapshot.bot.id, conversationId: packet.conversationId,
      attribution: "bot", text: `Committed report ${key}`, ...lineage });
    const revision = tx.get<{ n: number }>("SELECT coalesce(max(revision),0)+1 n FROM reports WHERE work_id=?", attempt.workId)!.n;
    const report: Report = { id: key, workId: attempt.workId, revision, attemptId: attempt.id,
      botIds: [...new Set([attempt.snapshot.bot.id, ...claims.flatMap(c => c.evidence.map(e => e.botId))])], createdAt: this.app.now(),
      state: "ready_for_review", coverage: missing.size || modelMissing.length ? "partial" : "covered", title,
      claims, covered: [...covered], missing: [...missing.values()], modelMissing, limitations: proposal.limitations.map(item => text(item, 2000)), source: ref(source), artifactIds: [] };
    const generated = this.files(report);
    const total = resultBytes + generated.reduce((sum, file) => sum + file.bytes.length, 0) + staged.reduce((sum, file) => sum + file.bytes.length, 0);
    if (total > attempt.snapshot.outputBytes) throw this.budgetError(attempt, claims, "artifacts", total);
    for (const file of [...staged.map(s => ({ ...s.metadata, bytes: s.bytes })), ...generated.map(file => ({ ...file, id: id() }))]) {
      const artifact: Artifact = { id: file.id, reportId: key, workId: report.workId, attemptId: attempt.id,
        name: file.name, mediaType: file.mediaType, size: file.bytes.length, sha256: artifactHash(file.bytes), source: report.source, createdAt: this.app.now() };
      validateArtifact(file.bytes, artifact, attempt.snapshot.outputBytes);
      tx.run("INSERT INTO artifacts VALUES (?,?,?,?,?)", artifact.id, key, attempt.id, canonical(artifact), file.bytes);
      report.artifactIds.push(artifact.id);
    }
    const encoded = JSON.stringify(report);
    if (Buffer.byteLength(encoded) > Math.min(1048576, attempt.snapshot.outputBytes)) throw this.budgetError(attempt, claims, "snapshot", Buffer.byteLength(encoded));
    tx.run("INSERT INTO reports VALUES (?,?,?,?,?,?)", key, report.workId, attempt.id, revision, canonical({ id: key, workId: report.workId, revision, source: report.source }), encoded);
    this.app.artifacts.discard(tx, attempt.id);
    const review = this.reviewIn(tx, report.workId);
    this.saveReview(tx, { workId: report.workId, revision: review.revision + 1, reportId: report.id, reportRevision: report.revision,
      completion: "owner_review_required", acceptance: null });
    return report;
  }

  /** Reads one exact committed revision while withholding stale or withdrawn report content. */
  read(tx: AppTransaction, reportId: string): ReportView {
    identity(reportId);
    const row = tx.get<{ metadata_json: string; content_json: string | null }>("SELECT metadata_json,content_json FROM reports WHERE id=?", reportId);
    if (!row) throw new AppError("not_found", 404);
    const metadata = JSON.parse(row.metadata_json) as { id: string; workId: string; revision: number; source: MemoryRef };
    if (!row.content_json || !this.app.memory.sourceCurrent(tx, metadata.source)) return { state: "unavailable", id: reportId, workId: metadata.workId, revision: metadata.revision, reason: "lineage_withdrawn" };
    const report = JSON.parse(row.content_json) as Report;
    const artifacts = tx.all<{ record_json: string }>("SELECT record_json FROM artifacts WHERE report_id=? ORDER BY rowid", reportId).map(r => JSON.parse(r.record_json) as Artifact);
    const review = this.reviewIn(tx, report.workId), acceptance = review.reportId === report.id ? review.acceptance : null;
    return { state: "available", report, artifacts, completion: acceptance ? "owner_accepted" : "owner_review_required", acceptance };
  }

  /** Returns immutable report history without executing work, fetching sources or certifying completion. */
  list(actor: OwnerActor, workId: string): ReportView[] {
    identity(workId);
    return this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor); record(tx, "work_items", workId); this.reconcile(tx);
      return tx.all<{ id: string }>("SELECT id FROM reports WHERE work_id=? ORDER BY revision", workId).map(row => this.read(tx, row.id));
    });
  }

  /** Returns one owner-authorized exact report revision with its immutable file metadata. */
  view(actor: OwnerActor, reportId: string): ReportView {
    return this.app.store.transaction(tx => { this.app.requireOwner(tx, actor); this.reconcile(tx); return this.read(tx, reportId); });
  }

  /** Reconciles current lineage/access/grant fences into reports, private staging and downloadable descendants before reads/restore. */
  reconcile(tx: AppTransaction): void {
    for (const row of tx.all<{ id: string; attempt_id: string; metadata_json: string; content_json: string }>("SELECT id,attempt_id,metadata_json,content_json FROM reports WHERE content_json IS NOT NULL")) {
      const metadata = JSON.parse(row.metadata_json) as { source: MemoryRef };
      let current = false;
      try {
        const report = JSON.parse(row.content_json) as Report;
        const producers = new Set([row.attempt_id, ...report.claims.flatMap(c => c.citations.map(citation => citation.attemptId))]);
        current = this.app.memory.sourceCurrent(tx, metadata.source) && [...producers].every(producer =>
          (this.app.memory.attemptCurrent(tx, producer) || this.app.botLifecycle.retained(tx, producer)) && this.app.authority.retainedEvidence(tx, producer));
      } catch { /* Missing original ancestry is unavailable, never reconstructed from a model claim. */ }
      if (!current) {
        tx.run("UPDATE reports SET content_json=NULL WHERE id=?", row.id);
        tx.run("UPDATE artifacts SET content=NULL WHERE report_id=?", row.id);
      }
    }
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM report_reviews")) {
      const review = JSON.parse(row.record_json) as ReportReview;
      if (!review.acceptance) continue;
      const report = tx.get<{ content_json: string | null }>("SELECT content_json FROM reports WHERE id=?", review.reportId);
      if (!report?.content_json || review.acceptance.ownerGeneration !== tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation) {
        review.acceptance = null; review.completion = "owner_review_required"; review.revision++;
        this.saveReview(tx, review);
      }
    }
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM artifact_staging")) {
      const stage = JSON.parse(row.record_json) as StagedArtifact;
      if (!this.app.memory.sourceCurrent(tx, stage.source) || !this.app.memory.attemptCurrent(tx, stage.attemptId) || !this.app.authority.retainedEvidence(tx, stage.attemptId)) tx.run("DELETE FROM artifact_staging WHERE id=?", row.id);
    }
  }
}

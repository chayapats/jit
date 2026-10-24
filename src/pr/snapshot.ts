import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { readMonitor } from "./authority";
import type { TrustedGitHubConnector } from "./github";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { DEFAULT_PR_LIMITS } from "./types";
import type {
  CoverageEntry,
  CoverageManifest,
  ImmutableSnapshot,
  PrReadLimits,
  ReviewCandidate,
} from "./types";
import { Utf8Budget, utf8Bytes } from "../utf8";

const ISSUE_REF = /(?:closes|fixes|refs)\s+#(\d+)/gi;
const SPEC_REF = /(?:spec|docs)[/:]([\w./-]+\.md)/gi;

function saveCandidate(tx: AppTransaction, candidate: ReviewCandidate): void {
  tx.run(
    "UPDATE pr_candidates SET status = ?, record_json = ? WHERE id = ?",
    candidate.status, JSON.stringify(candidate), candidate.id,
  );
}

function overall(entries: CoverageEntry[], enumerationComplete: boolean): CoverageManifest["overall"] {
  if (!enumerationComplete) return "incomplete";
  if (entries.some(e => e.state === "unavailable" || e.state === "truncated")) return "partial";
  if (entries.some(e => e.state === "requested")) return "incomplete";
  return "complete";
}

/** Collected immutable inputs before the application transaction persists them. */
export interface SnapshotMaterials {
  candidateId: string;
  snapshot: Omit<ImmutableSnapshot, "id" | "createdAt">;
  markStale?: boolean;
}

/** Snapshot read limits; every connector-supplied string counts against `maxPayloadBytes`. */
export type SnapshotLimits = Pick<PrReadLimits, "maxPages" | "maxFiles" | "maxDiffBytes" | "maxEvidenceBytes" | "pageSize">
  & Partial<Pick<PrReadLimits, "maxPayloadBytes">>;

/** Per-field ceiling for the PR and issue titles, in UTF-8 bytes. */
const MAX_TITLE_BYTES = 500;

/**
 * Reads connector-bound inputs for a candidate without writing.
 * Does not checkout, install, execute, or autoload AGENTS/skills/config.
 *
 * Every connector-supplied string retained in the snapshot (PR title/body, file paths/statuses and
 * patches, issue titles/bodies, spec paths/texts, CI names/conclusions/reasons) draws from one
 * cumulative UTF-8 budget of `maxPayloadBytes` (default {@link DEFAULT_PR_LIMITS}), on top of the
 * per-field `maxDiffBytes`/`maxEvidenceBytes` ceilings, which are also UTF-8 bytes. Text is cut only
 * on code-point boundaries ({@link truncateUtf8}); identities (paths, names) are never stored cut and
 * are dropped instead. Every cut or drop is a `truncated` coverage entry (`max_payload_bytes`,
 * `max_diff_bytes`, `max_evidence_bytes`, ...), so the snapshot reads partial/incomplete, never complete.
 * Coverage reasons are service-owned codes only: the connector normalizes adapter denials
 * (`prDenialReason` in ./github.ts), so no adapter text bypasses the budget through coverage.
 */
export function collectSnapshotMaterials(
  candidate: ReviewCandidate,
  monitorLimits: SnapshotLimits,
  connector: TrustedGitHubConnector,
): SnapshotMaterials {
  const pull = connector.resolvePull(candidate.pullNumber);
  if (!pull) throw new AppError("pr_pull_unavailable", 404);
  if (pull.base.sha !== candidate.baseSha || pull.head.sha !== candidate.headSha) {
    return {
      candidateId: candidate.id,
      markStale: true,
      snapshot: {
        candidateId: candidate.id, repository: { ...candidate.repository }, pullNumber: candidate.pullNumber,
        baseSha: candidate.baseSha, headSha: candidate.headSha, policyVersion: candidate.policyVersion,
        title: "", body: "", files: [], issues: [], specs: [], ci: [],
        coverage: {
          baseSha: candidate.baseSha, headSha: candidate.headSha, policyVersion: candidate.policyVersion,
          enumerationComplete: false, overall: "incomplete", entries: [],
        },
      },
    };
  }

  const maxPayloadBytes = monitorLimits.maxPayloadBytes ?? DEFAULT_PR_LIMITS.maxPayloadBytes;
  const budget = new Utf8Budget(maxPayloadBytes);
  const entries: CoverageEntry[] = [];
  const files: ImmutableSnapshot["files"] = [];
  let enumerationComplete = true;
  let page = 1;
  let collected = 0;
  let diffBytes = 0;
  const range = `${candidate.baseSha}...${candidate.headSha}`;
  const payloadCut = (kind: CoverageEntry["kind"], path: string | null, immutableRef: string | null, bytes: number | null): CoverageEntry => ({
    kind, path, state: "truncated", immutableRef, limit: maxPayloadBytes, bytes, reason: "max_payload_bytes",
  });

  entries.push({
    kind: "enumeration", path: null, state: "requested",
    immutableRef: range, limit: monitorLimits.maxFiles, bytes: null, reason: null,
  });

  // The title comes first so later reads cannot starve it; it is optional context, so a cut is disclosed.
  const title = budget.take(pull.title, MAX_TITLE_BYTES);
  if (title.truncated) {
    entries.push(title.cutBy === "budget"
      ? payloadCut("pr", "title", candidate.headSha, title.bytes)
      : { kind: "pr", path: "title", state: "truncated", immutableRef: candidate.headSha, limit: MAX_TITLE_BYTES, bytes: title.bytes, reason: "max_title_bytes" });
  }

  let payloadExhausted = false;
  while (page <= monitorLimits.maxPages && !payloadExhausted) {
    const listed = connector.listFiles(candidate.pullNumber, candidate.baseSha, candidate.headSha, page);
    if (listed.reason === "rate_limited" || listed.reason === "pagination_failed") {
      enumerationComplete = false;
      entries.push({
        kind: "files", path: null, state: "unavailable",
        immutableRef: range, limit: monitorLimits.pageSize, bytes: null, reason: listed.reason,
      });
      break;
    }
    for (const file of listed.items) {
      if (collected >= monitorLimits.maxFiles) {
        enumerationComplete = false;
        entries.push({
          kind: "files", path: file.filename, state: "truncated",
          immutableRef: candidate.headSha, limit: monitorLimits.maxFiles, bytes: null, reason: "max_files",
        });
        break;
      }
      // A file identity is stored whole or not at all; running out of budget ends enumeration.
      if (!budget.fits(file.filename) || !budget.fits(file.status)) {
        enumerationComplete = false;
        payloadExhausted = true;
        entries.push(payloadCut("files", null, range, collected));
        break;
      }
      const patch = file.patch;
      if (patch === null && file.status !== "removed") {
        entries.push({
          kind: "file", path: file.filename, state: "unavailable",
          immutableRef: candidate.headSha, limit: null, bytes: null, reason: "missing_patch",
        });
        files.push({ path: file.filename, status: file.status, patch: null, truncated: false });
        collected += 1;
        continue;
      }
      const kept = patch === null ? null : budget.take(patch, monitorLimits.maxDiffBytes - diffBytes);
      if (file.truncated || kept?.truncated) {
        const reason = file.truncated ? "provider_truncated" : kept!.cutBy === "budget" ? "max_payload_bytes" : "max_diff_bytes";
        entries.push({
          kind: "file", path: file.filename, state: "truncated",
          immutableRef: candidate.headSha, limit: reason === "max_payload_bytes" ? maxPayloadBytes : monitorLimits.maxDiffBytes,
          bytes: kept?.bytes ?? 0, reason,
        });
        files.push({ path: file.filename, status: file.status, patch: kept?.text ?? null, truncated: true });
        diffBytes += kept?.bytes ?? 0;
        collected += 1;
        continue;
      }
      entries.push({
        kind: "file", path: file.filename, state: "read",
        immutableRef: candidate.headSha, limit: monitorLimits.maxDiffBytes, bytes: kept?.bytes ?? 0, reason: null,
      });
      files.push({ path: file.filename, status: file.status, patch, truncated: false });
      diffBytes += kept?.bytes ?? 0;
      collected += 1;
    }
    // Reaching maxFiles exactly at a page boundary is still a cap when the provider reports more pages.
    if (collected >= monitorLimits.maxFiles && enumerationComplete && listed.incomplete) {
      enumerationComplete = false;
      entries.push({
        kind: "files", path: null, state: "truncated",
        immutableRef: range, limit: monitorLimits.maxFiles, bytes: collected, reason: "max_files",
      });
    }
    if (collected >= monitorLimits.maxFiles || payloadExhausted) break;
    if (listed.incomplete) {
      if (page >= monitorLimits.maxPages) {
        enumerationComplete = false;
        entries.push({
          kind: "files", path: null, state: "truncated",
          immutableRef: range, limit: monitorLimits.maxPages, bytes: collected, reason: "max_pages",
        });
        break;
      }
      page += 1;
      continue;
    }
    break;
  }

  // Reading every selected file does not prove complete enumeration when pages/caps failed.
  entries[0] = enumerationComplete
    ? {
      kind: "enumeration", path: null, state: "read",
      immutableRef: range, limit: monitorLimits.maxFiles, bytes: collected, reason: null,
    }
    : {
      kind: "enumeration", path: null, state: "unavailable",
      immutableRef: range, limit: monitorLimits.maxFiles, bytes: collected, reason: "enumeration_incomplete",
    };

  entries.push({
    kind: "diff", path: null,
    state: enumerationComplete && !entries.some(e => e.kind === "file" && e.state !== "read") ? "read" : "truncated",
    immutableRef: range, limit: monitorLimits.maxDiffBytes, bytes: diffBytes, reason: null,
  });

  const issues: ImmutableSnapshot["issues"] = [];
  const specs: ImmutableSnapshot["specs"] = [];
  const ci: ImmutableSnapshot["ci"] = [];
  const bodyRead = budget.take(pull.body, monitorLimits.maxEvidenceBytes);
  const body = bodyRead.text;
  if (bodyRead.truncated) {
    // Issue/spec references beyond the cut are never discovered, so the cut is disclosed.
    entries.push(bodyRead.cutBy === "budget"
      ? payloadCut("pr", "body", candidate.headSha, bodyRead.bytes)
      : { kind: "pr", path: "body", state: "truncated", immutableRef: candidate.headSha, limit: monitorLimits.maxEvidenceBytes, bytes: bodyRead.bytes, reason: "max_evidence_bytes" });
  }

  for (const match of body.matchAll(ISSUE_REF)) {
    const number = Number(match[1]);
    entries.push({
      kind: "issue", path: `#${number}`, state: "requested",
      immutableRef: null, limit: monitorLimits.maxEvidenceBytes, bytes: null, reason: null,
    });
    const issue = connector.readIssue(number);
    const idx = entries.length - 1;
    if ("denied" in issue) {
      entries[idx]!.state = "unavailable";
      entries[idx]!.reason = issue.reason;
    } else {
      // Title and body share one per-issue evidence ceiling and the cumulative payload budget.
      const issueTitle = budget.take(issue.title, Math.min(MAX_TITLE_BYTES, monitorLimits.maxEvidenceBytes));
      const issueBody = budget.take(issue.body, monitorLimits.maxEvidenceBytes - issueTitle.bytes);
      const cut = [issueTitle, issueBody].find(part => part.truncated);
      entries[idx]!.state = cut ? "truncated" : "read";
      entries[idx]!.bytes = issueTitle.bytes + issueBody.bytes;
      entries[idx]!.reason = !cut ? null : cut.cutBy === "budget" ? "max_payload_bytes" : "max_evidence_bytes";
      if (cut?.cutBy === "budget") entries[idx]!.limit = maxPayloadBytes;
      issues.push({ number: issue.number, title: issueTitle.text, body: issueBody.text });
    }
  }

  for (const match of body.matchAll(SPEC_REF)) {
    const path = match[1]!;
    entries.push({
      kind: "spec", path, state: "requested",
      immutableRef: candidate.headSha, limit: monitorLimits.maxEvidenceBytes, bytes: null, reason: null,
    });
    const idx = entries.length - 1;
    try {
      const spec = connector.readSpec(path, candidate.headSha);
      if ("denied" in spec) {
        entries[idx]!.state = "unavailable";
        entries[idx]!.reason = spec.reason;
      } else if (!budget.fits(spec.path)) {
        entries[idx] = payloadCut("spec", path, candidate.headSha, 0);
      } else {
        const text = budget.take(spec.text, monitorLimits.maxEvidenceBytes);
        const providerTruncated = "truncated" in spec;
        const truncated = providerTruncated || text.truncated;
        entries[idx]!.state = truncated ? "truncated" : "read";
        entries[idx]!.bytes = text.bytes;
        entries[idx]!.reason = providerTruncated ? "provider_truncated"
          : !text.truncated ? null : text.cutBy === "budget" ? "max_payload_bytes" : "max_evidence_bytes";
        if (!providerTruncated && text.cutBy === "budget") entries[idx]!.limit = maxPayloadBytes;
        specs.push({ path: spec.path, text: text.text, truncated });
      }
    } catch (error) {
      entries[idx]!.state = "unavailable";
      entries[idx]!.reason = error instanceof AppError ? error.code : "spec_rejected";
    }
  }

  entries.push({
    kind: "ci", path: null, state: "requested",
    immutableRef: candidate.headSha, limit: null, bytes: null, reason: null,
  });
  const checks = connector.readChecks(candidate.headSha);
  if ("denied" in checks) {
    entries.at(-1)!.state = "unavailable";
    entries.at(-1)!.reason = checks.reason;
    if (budget.fits("checks") && budget.fits(checks.reason)) ci.push({ name: "checks", conclusion: null, available: false, reason: checks.reason });
  } else {
    entries.at(-1)!.state = "read";
    for (const check of checks) {
      if (!budget.fits(check.name) || (check.conclusion !== null && !budget.fits(check.conclusion))) {
        entries[entries.length - 1] = payloadCut("ci", null, candidate.headSha, ci.length);
        break;
      }
      ci.push({ name: check.name, conclusion: check.conclusion, available: true, reason: null });
    }
  }

  // Adversarial AGENTS/skills content may appear in files; it remains untrusted data only.
  for (const file of files) {
    if (/(^|\/)(AGENTS\.md|skills\/|\.cursor\/)/.test(file.path)) {
      entries.push({
        kind: "file", path: file.path, state: "read",
        immutableRef: candidate.headSha, limit: null, bytes: file.patch ? utf8Bytes(file.patch) : 0,
        reason: "untrusted_instruction_data_not_autoload",
      });
    }
  }

  const coverage: CoverageManifest = {
    baseSha: candidate.baseSha, headSha: candidate.headSha, policyVersion: candidate.policyVersion,
    enumerationComplete, overall: overall(entries, enumerationComplete), entries,
  };

  return {
    candidateId: candidate.id,
    snapshot: {
      candidateId: candidate.id, repository: { ...candidate.repository }, pullNumber: candidate.pullNumber,
      baseSha: candidate.baseSha, headSha: candidate.headSha, policyVersion: candidate.policyVersion,
      title: title.text, body, files, issues, specs, ci, coverage,
    },
  };
}

/** Persists collected materials inside an application transaction after authority checks. */
export function persistSnapshot(
  tx: AppTransaction,
  projectId: string,
  materials: SnapshotMaterials,
  connector: TrustedGitHubConnector,
  now: number,
): ImmutableSnapshot | null {
  ensurePrSchema(tx);
  const candidate = readCandidate(tx, projectId, materials.candidateId);
  const monitor = readMonitor(tx, projectId, candidate.monitorId);
  if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);
  if (monitor.state === "paused") throw new AppError("pr_monitor_paused", 409);
  if (["superseded", "cancelled", "stale"].includes(candidate.status)) throw new AppError("pr_candidate_not_current", 409);
  if (candidate.status === "draft") throw new AppError("pr_candidate_draft", 409);
  if (candidate.status === "closed") throw new AppError("pr_candidate_closed", 409);

  if (materials.markStale) {
    candidate.status = "stale";
    candidate.updatedAt = now;
    saveCandidate(tx, candidate);
    // Return null so the stale mark can commit; throwing would roll it back.
    return null;
  }

  const snapshot: ImmutableSnapshot = {
    ...materials.snapshot,
    id: crypto.randomUUID(),
    createdAt: now,
  };
  connector.cacheDestination(snapshot.id);
  tx.run(
    "INSERT INTO pr_snapshots(id, candidate_id, record_json) VALUES (?, ?, ?)",
    snapshot.id, candidate.id, JSON.stringify(snapshot),
  );
  candidate.snapshotId = snapshot.id;
  candidate.status = snapshot.coverage.overall === "complete" ? "captured" : "partial";
  candidate.updatedAt = now;
  saveCandidate(tx, candidate);
  return snapshot;
}

/**
 * Captures immutable static review inputs for a ready candidate in one transaction.
 * Does not checkout, install, execute, or autoload AGENTS/skills/config.
 */
export function captureSnapshot(
  tx: AppTransaction,
  projectId: string,
  candidateId: string,
  connector: TrustedGitHubConnector,
  now: number,
): ImmutableSnapshot | null {
  ensurePrSchema(tx);
  const candidate = readCandidate(tx, projectId, candidateId);
  const monitor = readMonitor(tx, projectId, candidate.monitorId);
  if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);
  if (monitor.state === "paused") throw new AppError("pr_monitor_paused", 409);
  if (["superseded", "cancelled", "stale"].includes(candidate.status)) throw new AppError("pr_candidate_not_current", 409);
  if (candidate.status === "draft") throw new AppError("pr_candidate_draft", 409);
  if (candidate.status === "closed") throw new AppError("pr_candidate_closed", 409);
  const materials = collectSnapshotMaterials(candidate, monitor.limits, connector);
  return persistSnapshot(tx, projectId, materials, connector, now);
}

/** Reads a committed immutable snapshot by candidate identity. */
export function readSnapshot(tx: AppTransaction, candidateId: string): ImmutableSnapshot {
  ensurePrSchema(tx);
  const row = tx.get<{ record_json: string }>(
    "SELECT record_json FROM pr_snapshots WHERE candidate_id = ?", candidateId);
  if (!row) throw new AppError("pr_snapshot_not_found", 404);
  return JSON.parse(row.record_json) as ImmutableSnapshot;
}

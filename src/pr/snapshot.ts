import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { readMonitor } from "./authority";
import type { TrustedGitHubConnector } from "./github";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import type {
  CoverageEntry,
  CoverageManifest,
  ImmutableSnapshot,
  ReviewCandidate,
} from "./types";

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

/**
 * Reads connector-bound inputs for a candidate without writing.
 * Does not checkout, install, execute, or autoload AGENTS/skills/config.
 */
export function collectSnapshotMaterials(
  candidate: ReviewCandidate,
  monitorLimits: { maxPages: number; maxFiles: number; maxDiffBytes: number; maxEvidenceBytes: number; pageSize: number },
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

  const entries: CoverageEntry[] = [];
  const files: ImmutableSnapshot["files"] = [];
  let enumerationComplete = true;
  let page = 1;
  let collected = 0;
  let diffBytes = 0;

  entries.push({
    kind: "enumeration", path: null, state: "requested",
    immutableRef: `${candidate.baseSha}...${candidate.headSha}`,
    limit: monitorLimits.maxFiles, bytes: null, reason: null,
  });

  while (page <= monitorLimits.maxPages) {
    const listed = connector.listFiles(candidate.pullNumber, candidate.baseSha, candidate.headSha, page);
    if (listed.reason === "rate_limited" || listed.reason === "pagination_failed") {
      enumerationComplete = false;
      entries.push({
        kind: "files", path: null, state: "unavailable",
        immutableRef: `${candidate.baseSha}...${candidate.headSha}`,
        limit: monitorLimits.pageSize, bytes: null, reason: listed.reason,
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
      const patch = file.patch;
      const patchBytes = patch ? Buffer.byteLength(patch) : 0;
      if (patch === null && file.status !== "removed") {
        entries.push({
          kind: "file", path: file.filename, state: "unavailable",
          immutableRef: candidate.headSha, limit: null, bytes: null, reason: "missing_patch",
        });
        files.push({ path: file.filename, status: file.status, patch: null, truncated: false });
        collected += 1;
        continue;
      }
      if (file.truncated || diffBytes + patchBytes > monitorLimits.maxDiffBytes) {
        const kept = patch
          ? patch.slice(0, Math.max(0, monitorLimits.maxDiffBytes - diffBytes))
          : null;
        entries.push({
          kind: "file", path: file.filename, state: "truncated",
          immutableRef: candidate.headSha, limit: monitorLimits.maxDiffBytes,
          bytes: kept ? Buffer.byteLength(kept) : 0, reason: file.truncated ? "provider_truncated" : "max_diff_bytes",
        });
        files.push({ path: file.filename, status: file.status, patch: kept, truncated: true });
        diffBytes += kept ? Buffer.byteLength(kept) : 0;
        collected += 1;
        continue;
      }
      entries.push({
        kind: "file", path: file.filename, state: "read",
        immutableRef: candidate.headSha, limit: monitorLimits.maxDiffBytes, bytes: patchBytes, reason: null,
      });
      files.push({ path: file.filename, status: file.status, patch, truncated: false });
      diffBytes += patchBytes;
      collected += 1;
    }
    if (collected >= monitorLimits.maxFiles) break;
    if (listed.incomplete) {
      if (page >= monitorLimits.maxPages) {
        enumerationComplete = false;
        entries.push({
          kind: "files", path: null, state: "truncated",
          immutableRef: `${candidate.baseSha}...${candidate.headSha}`,
          limit: monitorLimits.maxPages, bytes: collected, reason: "max_pages",
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
      immutableRef: `${candidate.baseSha}...${candidate.headSha}`,
      limit: monitorLimits.maxFiles, bytes: collected, reason: null,
    }
    : {
      kind: "enumeration", path: null, state: "unavailable",
      immutableRef: `${candidate.baseSha}...${candidate.headSha}`,
      limit: monitorLimits.maxFiles, bytes: collected, reason: "enumeration_incomplete",
    };

  entries.push({
    kind: "diff", path: null,
    state: enumerationComplete && !entries.some(e => e.kind === "file" && e.state !== "read") ? "read" : "truncated",
    immutableRef: `${candidate.baseSha}...${candidate.headSha}`,
    limit: monitorLimits.maxDiffBytes, bytes: diffBytes, reason: null,
  });

  const issues: ImmutableSnapshot["issues"] = [];
  const specs: ImmutableSnapshot["specs"] = [];
  const ci: ImmutableSnapshot["ci"] = [];
  const body = pull.body.slice(0, monitorLimits.maxEvidenceBytes);

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
      const text = `${issue.title}\n${issue.body}`;
      const truncated = Buffer.byteLength(text) > monitorLimits.maxEvidenceBytes;
      entries[idx]!.state = truncated ? "truncated" : "read";
      entries[idx]!.bytes = Math.min(Buffer.byteLength(text), monitorLimits.maxEvidenceBytes);
      entries[idx]!.reason = truncated ? "max_evidence_bytes" : null;
      issues.push({
        number: issue.number, title: issue.title.slice(0, 500),
        body: issue.body.slice(0, monitorLimits.maxEvidenceBytes),
      });
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
      } else if ("truncated" in spec) {
        entries[idx]!.state = "truncated";
        entries[idx]!.bytes = Buffer.byteLength(spec.text);
        entries[idx]!.reason = "provider_truncated";
        specs.push({ path: spec.path, text: spec.text, truncated: true });
      } else {
        const truncated = Buffer.byteLength(spec.text) > monitorLimits.maxEvidenceBytes;
        entries[idx]!.state = truncated ? "truncated" : "read";
        entries[idx]!.bytes = Math.min(Buffer.byteLength(spec.text), monitorLimits.maxEvidenceBytes);
        entries[idx]!.reason = truncated ? "max_evidence_bytes" : null;
        specs.push({
          path: spec.path,
          text: truncated ? spec.text.slice(0, monitorLimits.maxEvidenceBytes) : spec.text,
          truncated,
        });
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
    ci.push({ name: "checks", conclusion: null, available: false, reason: checks.reason });
  } else {
    entries.at(-1)!.state = "read";
    for (const check of checks) ci.push({ name: check.name, conclusion: check.conclusion, available: true, reason: null });
  }

  // Adversarial AGENTS/skills content may appear in files; it remains untrusted data only.
  for (const file of files) {
    if (/(^|\/)(AGENTS\.md|skills\/|\.cursor\/)/.test(file.path)) {
      entries.push({
        kind: "file", path: file.path, state: "read",
        immutableRef: candidate.headSha, limit: null, bytes: file.patch ? Buffer.byteLength(file.patch) : 0,
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
      title: pull.title.slice(0, 500), body, files, issues, specs, ci, coverage,
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

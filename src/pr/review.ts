import { AppError } from "../errors";
import { jobData } from "../jobs/queue";
import type { JobLimits, WorkDefinition } from "../jobs/types";
import type { AppTransaction } from "../store";
import { normalizePortResult } from "../team/scripted-port";
import type { ApplicationRunPort } from "../team/run-port";
import type { ApplicationRunRequest } from "../team/types";
import { readMonitor } from "./authority";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { normalizeReviewOutput, persistReport } from "./report";
import { readSnapshot } from "./snapshot";
import { DEFAULT_REVIEW_POLICY, REVIEW_POLICY_VERSION } from "./types";
import type { ImmutableSnapshot, PrReviewInput } from "./types";

const UUID = /^[a-f0-9-]{36}$/;

function isInput(value: unknown): value is PrReviewInput {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof (value as PrReviewInput).monitorId === "string" && UUID.test((value as PrReviewInput).monitorId)
    && typeof (value as PrReviewInput).candidateId === "string" && UUID.test((value as PrReviewInput).candidateId);
}

export interface PrReviewWorkOptions {
  store: { read: <T>(query: (tx: AppTransaction) => T) => T };
  port: ApplicationRunPort;
  now?: () => number;
  contextBytes?: number;
  outputBytes?: number;
  requiredRoles?: readonly string[];
}

const FIXTURE_ROUTE = { provider: "grok", model: "scripted-fixture", authRoute: "owner-grok" } as const;

function manifestSources(snapshot: ImmutableSnapshot, contextBytes: number): Array<{ projectId: string; reference: { sourceId: string; revision: number; generation: number }; text: string }> {
  const sources: Array<{ projectId: string; reference: { sourceId: string; revision: number; generation: number }; text: string }> = [];
  const push = (text: string) => {
    if (sources.length >= 8) return;
    if (Buffer.byteLength(text) > Math.min(8192, contextBytes)) text = text.slice(0, Math.min(8192, contextBytes));
    sources.push({
      projectId: snapshot.candidateId,
      reference: { sourceId: crypto.randomUUID(), revision: 1, generation: 1 },
      text,
    });
  };
  push(`PR #${snapshot.pullNumber} ${snapshot.baseSha.slice(0, 8)}...${snapshot.headSha.slice(0, 8)} policy ${snapshot.policyVersion}\n${snapshot.title}\n${snapshot.body.slice(0, 2000)}`);
  for (const file of snapshot.files.slice(0, 6)) {
    push(`diff ${file.path}\n${(file.patch ?? "[no patch]").slice(0, 4000)}`);
  }
  for (const issue of snapshot.issues.slice(0, 2)) {
    push(`issue #${issue.number} ${issue.title}\n${issue.body.slice(0, 2000)}`);
  }
  for (const spec of snapshot.specs.slice(0, 2)) {
    push(`spec ${spec.path}\n${spec.text.slice(0, 2000)}`);
  }
  return sources;
}

function buildRequest(input: {
  projectId: string;
  topicId: string;
  roleId: string;
  purpose: string;
  responsibility: string;
  manifestSources: ApplicationRunRequest["manifest"]["sources"];
  job: { id: string; authorization: { generation: number }; limits: JobLimits };
  generation: number;
  contextBytes: number;
  contextId: string;
}): ApplicationRunRequest {
  return {
    runId: crypto.randomUUID(),
    projectId: input.projectId,
    topicId: input.topicId,
    roleId: input.roleId,
    purpose: input.purpose.slice(0, 300),
    route: { ...FIXTURE_ROUTE },
    configuration: { ownerRevision: 1, projectRevision: 1, roleRevision: 1 },
    context: { id: input.contextId, generation: 1 },
    fence: { jobId: input.job.id, generation: input.generation, ownerGeneration: input.job.authorization.generation },
    instructions: {
      operator: ["อ่านเฉพาะ snapshot ที่ให้มา", "ห้ามรันโค้ด ห้ามคอมเมนต์ GitHub ห้ามเปลี่ยน route"],
      responsibility: input.responsibility.slice(0, 2048),
    },
    manifest: { sources: input.manifestSources, claims: [] },
    tools: [],
    policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
    limits: structuredClone(input.job.limits),
  };
}

/**
 * `pr.private_report/v1` review work through `ApplicationRunPort` only.
 * N bounded specialist invokes + 1 synthesis with separate contexts and finite budgets.
 * Snapshot capture stays on `TrustedGitHubConnector` + `fixtureFor`, never through this port.
 */
export function prReviewWork(options: PrReviewWorkOptions): WorkDefinition {
  const contextBytes = options.contextBytes ?? 65536;
  const outputBytes = options.outputBytes ?? 16384;
  const requiredRoles = options.requiredRoles ?? [...DEFAULT_REVIEW_POLICY.requiredRoles];
  const now = options.now ?? Date.now;
  void REVIEW_POLICY_VERSION;
  return {
    replay: "read",
    id: "pr.review",
    title: "ตรวจ PR แบบ static ส่วนตัว",
    revision: 1,
    route: { provider: "jit-service", model: null, authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: (input, scope) => isInput(input) && scope.inputRevision === scope.projectRevision,
    isCurrent: (tx, job) => {
      if (!isInput(job.input)) return false;
      try {
        ensurePrSchema(tx);
        const monitor = readMonitor(tx, job.projectId, job.input.monitorId);
        if (monitor.state !== "active") return false;
        const candidate = readCandidate(tx, job.projectId, job.input.candidateId);
        return !["superseded", "cancelled", "stale", "closed"].includes(candidate.status);
      } catch { return false; }
    },
    run: async ({ job, attempt, signal, reserve, commit }) => {
      if (signal.aborted || !isInput(job.input)) return { state: "failed", reason: "worker_failed" };
      const input = job.input;
      let loaded: { projectId: string; monitorId: string; candidateId: string; snapshot: ImmutableSnapshot };
      try {
        loaded = options.store.read(tx => {
          ensurePrSchema(tx);
          const candidate = readCandidate(tx, job.projectId, input.candidateId);
          const monitor = readMonitor(tx, job.projectId, input.monitorId);
          if (candidate.monitorId !== monitor.id) throw new AppError("pr_candidate_not_current", 409);
          const snapshot = readSnapshot(tx, candidate.id);
          return { projectId: job.projectId, monitorId: monitor.id, candidateId: candidate.id, snapshot };
        });
      } catch {
        return { state: "failed", reason: "worker_failed" };
      }
      const snapshot = loaded.snapshot;
      const sources = manifestSources(snapshot, contextBytes);
      const specialistOutcomes: Array<{ role: string; output: string | null; state: string; reason: string | null }> = [];
      const specialistRuns: Array<{ role: string; state: string; reason: string | null }> = [];

      for (const role of requiredRoles) {
        if (signal.aborted) return { state: "failed", reason: "worker_failed" };
        const contextId = crypto.randomUUID();
        try {
          options.store.read(tx => {
            tx.run("INSERT OR IGNORE INTO team_contexts VALUES (?, 1, 'active')", contextId);
          });
        } catch { /* Context table may be unavailable in minimal fixtures; port still fences. */ }
        const request = buildRequest({
          projectId: job.projectId,
          topicId: input.candidateId,
          roleId: crypto.randomUUID(),
          purpose: `specialist:${role} review PR #${snapshot.pullNumber} ${snapshot.headSha.slice(0, 8)}`,
          responsibility: `วิเคราะห์ ${role} จาก snapshot แบบ static เท่านั้น`,
          manifestSources: sources,
          job: { id: job.id, authorization: job.authorization, limits: job.limits },
          generation: attempt.generation,
          contextBytes,
          contextId,
        });
        try { void jobData(request, contextBytes); } catch { return { state: "failed", reason: "worker_failed" }; }
        try { reserve({ calls: 1, rounds: 1, hops: 1 }); } catch { return { state: "failed", reason: "worker_failed" }; }
        let outcome;
        try {
          outcome = normalizePortResult(await options.port.invoke(request, signal, () => {}), request, Math.min(outputBytes, job.limits.outputTokens * 4, 65000));
        } catch { outcome = { state: "error" as const, reason: "invalid_result" as const, mode: "fixture" as const, output: null, usage: { calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0 }, session: null }; }
        if (outcome.reason === "quota" || outcome.reason === "needs_login" || outcome.reason === "route_unavailable") {
          return { state: "waiting", reason: outcome.reason };
        }
        if (outcome.reason === "cancelled" || signal.aborted) return { state: "failed", reason: "worker_failed" };
        if (outcome.state !== "complete" || !outcome.output) {
          specialistOutcomes.push({ role, output: null, state: outcome.state, reason: outcome.reason });
          specialistRuns.push({ role, state: outcome.state, reason: outcome.reason });
          continue;
        }
        specialistOutcomes.push({ role, output: outcome.output, state: "complete", reason: null });
        specialistRuns.push({ role, state: "complete", reason: null });
      }

      // Synthesis merges specialist outputs; model text never grants authority.
      const synthesisContextId = crypto.randomUUID();
      try {
        options.store.read(tx => {
          tx.run("INSERT OR IGNORE INTO team_contexts VALUES (?, 1, 'active')", synthesisContextId);
        });
      } catch { /* best effort */ }
      const synthesisSources: Array<{ projectId: string; reference: { sourceId: string; revision: number; generation: number }; text: string }> = [...sources];
      for (const item of specialistOutcomes) {
        if (synthesisSources.length >= 8) break;
        if (!item.output) continue;
        synthesisSources.push({
          projectId: job.projectId,
          reference: { sourceId: crypto.randomUUID(), revision: 1, generation: 1 },
          text: `specialist ${item.role}:\n${item.output.slice(0, 4000)}`,
        });
      }
      const synthesisRequest = buildRequest({
        projectId: job.projectId,
        topicId: input.candidateId,
        roleId: crypto.randomUUID(),
        purpose: `synthesis review PR #${snapshot.pullNumber} ${snapshot.headSha.slice(0, 8)}`,
        responsibility: "สังเคราะห์ผล specialist ที่อ้างอิงได้เท่านั้น",
        manifestSources: synthesisSources,
        job: { id: job.id, authorization: job.authorization, limits: job.limits },
        generation: attempt.generation,
        contextBytes,
        contextId: synthesisContextId,
      });
      try { reserve({ calls: 1, rounds: 1, hops: 1 }); } catch { return { state: "failed", reason: "worker_failed" }; }
      let synthesisOutcome;
      try {
        synthesisOutcome = normalizePortResult(await options.port.invoke(synthesisRequest, signal, () => {}), synthesisRequest, Math.min(outputBytes, job.limits.outputTokens * 4, 65000));
      } catch { synthesisOutcome = { state: "error" as const, reason: "invalid_result" as const, mode: "fixture" as const, output: null, usage: { calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0 }, session: null }; }
      if (synthesisOutcome.reason === "quota" || synthesisOutcome.reason === "needs_login" || synthesisOutcome.reason === "route_unavailable") {
        return { state: "waiting", reason: synthesisOutcome.reason };
      }
      if (synthesisOutcome.reason === "cancelled" || signal.aborted) return { state: "failed", reason: "worker_failed" };

      const synthesisOutput = synthesisOutcome.state === "complete" && synthesisOutcome.output ? synthesisOutcome.output : "";
      const normalized = normalizeReviewOutput(synthesisOutput || JSON.stringify({ findings: [], analyzedRoles: [], skippedScope: requiredRoles }), snapshot, requiredRoles);
      // Specialist outputs that synthesis ignored stay visible as disagreements, never silent consensus.
      const mergedDisagreements = [...normalized.disagreements];
      for (const item of specialistOutcomes) {
        if (!item.output) mergedDisagreements.push(`${item.role}: ${item.state}${item.reason ? `/${item.reason}` : ""}`);
      }
      const merged = { ...normalized, disagreements: mergedDisagreements.slice(0, 16) };
      const synthesisState = synthesisOutcome.state === "complete" && merged.valid ? "complete" : synthesisOutcome.state;

      const evidence = `pr-review:${input.candidateId};roles:${specialistRuns.map(r => `${r.role}=${r.state}`).join(",")};synthesis:${synthesisState};findings:${merged.findings.length}`;
      const outcome = { state: "succeeded" as const, evidence };
      const committedAt = now();
      const ok = commit(outcome, (tx) => {
        persistReport(tx, {
          projectId: job.projectId,
          monitorId: input.monitorId,
          candidateId: input.candidateId,
          snapshot,
          normalized: merged,
          requiredRoles,
          specialistRuns,
          synthesis: { state: synthesisState, reason: synthesisOutcome.reason ?? null },
          jobId: job.id,
          attemptId: attempt.id,
          now: committedAt,
        });
        try {
          const live = readCandidate(tx, job.projectId, input.candidateId);
          if (!live.jobId) {
            live.jobId = job.id;
            tx.run("UPDATE pr_candidates SET record_json = ? WHERE id = ?", JSON.stringify(live), live.id);
          }
        } catch { /* candidate may have been fenced concurrently */ }
      });
      return ok ? outcome : { state: "failed", reason: "worker_failed" };
    },
  };
}

/**
 * Invalidates fenced PR review jobs for a revoked/superseded candidate inside the same tx.
 * Callers must invoke `queue.cancelFenced()` after the transaction commits.
 */
export async function fencePrReviewJobs(
  tx: AppTransaction,
  invalidate: (projectId: string, jobId: string, reason: "revoked" | "superseded" | "source_retired" | "context_retired") => void,
  projectId: string,
  candidate: { jobId: string | null },
  reason: "revoked" | "superseded" | "source_retired" | "context_retired",
): Promise<void> {
  if (candidate.jobId) invalidate(projectId, candidate.jobId, reason);
}

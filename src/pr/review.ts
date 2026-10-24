import { AppError } from "../errors";
import { jobData } from "../jobs/queue";
import { readAttempts } from "../jobs/attempts";
import type { JobData, JobLimits, JobUsage, WorkDefinition } from "../jobs/types";
import type { AppTransaction } from "../store";
import { requireRoleRoute } from "../team/configuration";
import { normalizePortResult } from "../team/scripted-port";
import { portFailureOutcome, schwayMaxAttempts } from "../team/schway-port";
import type { ApplicationRunPort } from "../team/run-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../team/types";
import { readMonitor } from "./authority";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { normalizeReviewOutput, persistReport } from "./report";
import { readSnapshot } from "./snapshot";
import { DEFAULT_REVIEW_POLICY } from "./types";
import type {
  ImmutableSnapshot,
  PrReviewCapture,
  PrReviewInput,
  PrReviewPolicy,
  PrReviewRouteLayer,
  TransmittedEntry,
  TransmittedManifest,
} from "./types";

const UUID = /^[a-f0-9-]{36}$/;

function isInput(value: unknown): value is PrReviewInput {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof (value as PrReviewInput).monitorId === "string" && UUID.test((value as PrReviewInput).monitorId)
    && typeof (value as PrReviewInput).candidateId === "string" && UUID.test((value as PrReviewInput).candidateId);
}

function isCapture(value: unknown): value is PrReviewCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capture = value as PrReviewCapture;
  try { requireRoleRoute(capture.route); } catch { return false; }
  return capture.version === 1 && typeof capture.adapter === "string" && !!capture.route
    && ["project_default", "owner_default", "scripted_fixture"].includes(capture.layer)
    && !!capture.configuration && [capture.configuration.ownerRevision, capture.configuration.projectRevision, capture.configuration.roleRevision]
      .every(n => Number.isSafeInteger(n) && n >= 0)
    && !!capture.reviewPolicy && Number.isSafeInteger(capture.reviewPolicy.version) && capture.reviewPolicy.version >= 1
    && Array.isArray(capture.reviewPolicy.requiredRoles) && capture.reviewPolicy.requiredRoles.length >= 1
    && capture.reviewPolicy.requiredRoles.every(role => typeof role === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(role));
}

export interface PrReviewWorkOptions {
  store: { read: <T>(query: (tx: AppTransaction) => T) => T };
  port: ApplicationRunPort;
  now?: () => number;
  /** Port team policy: maximum manifest sources per request (default 8). */
  sourceLimit?: number;
  /** Port team policy: maximum encoded request bytes (default 32768). */
  contextBytes?: number;
  /** Port output ceiling in bytes (default 4096). */
  outputBytes?: number;
  /**
   * Review scope policy this worker enforces; defaults to the accepted
   * `DEFAULT_REVIEW_POLICY`. Production wiring never overrides it; a different
   * version models an upgrade and fences work captured under the old policy.
   */
  reviewPolicy?: PrReviewPolicy;
}

/**
 * Route used only by the scripted fixture port when the owner configured none.
 * Concrete (schway) admission never falls back to it.
 */
export const PR_REVIEW_SCRIPTED_ROUTE = { provider: "grok", model: "scripted-fixture", authRoute: "owner-grok" } as const;

/**
 * Resolves the owner-configured PR review route for one project: the project
 * default route, then the owner default route (`route.save` with `roleId:null`).
 * Each layer is a complete provider/model/authRoute triple; fields never mix.
 * Returns null when neither layer is configured. Never probes credentials.
 */
export function resolvePrReviewRoute(tx: AppTransaction, projectId: string): {
  route: RoleRoute; layer: Exclude<PrReviewRouteLayer, "scripted_fixture">; ownerRevision: number; projectRevision: number;
} | null {
  const owner = tx.get<{ revision: number; route_json: string | null }>("SELECT revision, route_json FROM team_state WHERE id = 1");
  const project = tx.get<{ revision: number; route_json: string | null }>("SELECT revision, route_json FROM project_team WHERE project_id = ?", projectId);
  const ownerRevision = owner?.revision ?? 0, projectRevision = project?.revision ?? 0;
  const pick = (json: string | null | undefined): RoleRoute | null => {
    if (!json) return null;
    const route = JSON.parse(json) as RoleRoute;
    requireRoleRoute(route);
    return route;
  };
  const projectRoute = pick(project?.route_json);
  if (projectRoute) return { route: projectRoute, layer: "project_default", ownerRevision, projectRevision };
  const ownerRoute = pick(owner?.route_json);
  if (ownerRoute) return { route: ownerRoute, layer: "owner_default", ownerRevision, projectRevision };
  return null;
}

type ManifestSource = ApplicationRunRequest["manifest"]["sources"][number];

interface PackItem {
  kind: TransmittedEntry["kind"];
  ref: string;
  required: boolean;
  text: string;
  /** Delivered text marks evidence the snapshot could not read. */
  unavailable?: boolean;
  /** Item text was already bounded before packing (for example a long PR body). */
  preTruncated?: boolean;
}

/** Bytes a string contributes inside the JSON-encoded request. */
const escapedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** Longest well-formed prefix whose encoded size fits `maxBytes`. */
function fit(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapedBytes(text.slice(0, mid)) <= maxBytes) low = mid; else high = mid - 1;
  }
  let piece = text.slice(0, low);
  if (!piece.isWellFormed()) piece = piece.slice(0, -1);
  return piece;
}

const SEPARATOR = "\n\n";
const MIN_PIECE = 128;

/**
 * Packs ordered items into at most `slots` chunks of at most `capacity`
 * encoded bytes. Items may continue across chunks; whatever does not fit is
 * recorded as truncated (partially sent) or omitted (nothing sent).
 */
function pack(items: PackItem[], slots: number, capacity: number): { chunks: string[]; entries: TransmittedEntry[] } {
  const chunks: string[] = [];
  let room = 0;
  const usable = capacity >= 4 * MIN_PIECE;
  const open = (): boolean => {
    if (!usable || chunks.length >= slots) return false;
    chunks.push(""); room = capacity; return true;
  };
  const write = (piece: string) => {
    const last = chunks.length - 1;
    const separator = chunks[last] ? SEPARATOR : "";
    chunks[last] += separator + piece;
    room -= escapedBytes(separator + piece);
  };
  const entries: TransmittedEntry[] = [];
  for (const item of items) {
    let rest = item.text, sent = 0, first: number | null = null;
    while (rest.length) {
      if (!chunks.length || room < MIN_PIECE + escapedBytes(SEPARATOR)) { if (!open()) break; }
      const separatorBytes = chunks[chunks.length - 1] ? escapedBytes(SEPARATOR) : 0;
      const prefix = sent > 0 ? `(continued ${item.kind} ${item.ref})\n` : "";
      const budget = room - separatorBytes - escapedBytes(prefix);
      if (escapedBytes(rest) <= budget) {
        write(prefix + rest); sent += Buffer.byteLength(rest); first ??= chunks.length - 1; rest = "";
        break;
      }
      const piece = fit(rest, budget);
      if (!piece.length) { if (!open()) break; continue; }
      write(prefix + piece); sent += Buffer.byteLength(piece); first ??= chunks.length - 1;
      rest = rest.slice(piece.length);
      if (!open()) break;
    }
    const state: TransmittedEntry["state"] = rest.length
      ? (sent > 0 ? "truncated" : "omitted")
      : item.unavailable ? "unavailable" : item.preTruncated ? "truncated" : "sent";
    entries.push({ kind: item.kind, ref: item.ref.slice(0, 512), required: item.required, state, bytes: Buffer.byteLength(item.text), sentBytes: sent, chunk: first });
  }
  return { chunks, entries };
}

function headerItem(snapshot: ImmutableSnapshot, reviewPolicyVersion: number): PackItem {
  const body = snapshot.body.length > 2000 ? snapshot.body.slice(0, 2000) : snapshot.body;
  return {
    kind: "pr", ref: `#${snapshot.pullNumber}`, required: false, preTruncated: body.length < snapshot.body.length,
    text: [
      `PR #${snapshot.pullNumber} ${snapshot.repository.owner}/${snapshot.repository.name}`,
      `base ${snapshot.baseSha}`, `head ${snapshot.headSha}`,
      `trigger policy v${snapshot.policyVersion} · review policy v${reviewPolicyVersion}`,
      `changed files ${snapshot.files.length} · enumeration ${snapshot.coverage.enumerationComplete ? "complete" : "incomplete"} · coverage ${snapshot.coverage.overall}`,
      `title: ${snapshot.title || "(none)"}`,
      body || "(no description)",
    ].join("\n"),
  };
}

/** Ordered snapshot items every specialist receives: PR header, CI, every diff, issues, specs. */
function snapshotItems(snapshot: ImmutableSnapshot, reviewPolicyVersion: number): PackItem[] {
  const items: PackItem[] = [headerItem(snapshot, reviewPolicyVersion)];
  for (const check of snapshot.ci) {
    items.push({
      kind: "ci", ref: check.name, required: true, unavailable: !check.available,
      text: `ci ${check.name}: ${check.available ? check.conclusion ?? "pending" : `unavailable (${check.reason ?? "unreadable"})`}`,
    });
  }
  for (const file of snapshot.files) {
    const missing = file.patch === null && file.status !== "removed";
    const content = file.patch ?? (file.status === "removed" ? "[file removed; no patch]" : "[patch unavailable]");
    items.push({
      kind: "diff", ref: file.path, required: true, unavailable: missing,
      text: `diff ${file.path} [${file.status}]${file.truncated ? " (snapshot truncated)" : ""}\n${content}`,
    });
  }
  for (const issue of snapshot.issues) {
    items.push({ kind: "issue", ref: `#${issue.number}`, required: true, text: `issue #${issue.number} ${issue.title}\n${issue.body || "(empty)"}` });
  }
  for (const spec of snapshot.specs) {
    items.push({ kind: "spec", ref: spec.path, required: true, text: `spec ${spec.path}${spec.truncated ? " (snapshot truncated)" : ""}\n${spec.text || "(empty)"}` });
  }
  return items;
}

function buildRequest(input: {
  projectId: string;
  topicId: string;
  purpose: string;
  responsibility: string;
  capture: PrReviewCapture;
  manifestSources: ManifestSource[];
  job: { id: string; authorization: { generation: number }; limits: JobLimits };
  generation: number;
  contextId: string;
}): ApplicationRunRequest {
  return {
    runId: crypto.randomUUID(),
    projectId: input.projectId,
    topicId: input.topicId,
    roleId: crypto.randomUUID(),
    purpose: input.purpose.slice(0, 300),
    route: { ...input.capture.route },
    configuration: { ...input.capture.configuration },
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

/** Per-source JSON envelope (project id, reference, keys) plus slack. */
const SOURCE_ENVELOPE = 200;

/** Splits packed chunks into manifest sources with fresh opaque references. */
function toSources(projectId: string, chunks: string[]): ManifestSource[] {
  return chunks.map(text => ({ projectId, reference: { sourceId: crypto.randomUUID(), revision: 1, generation: 1 }, text }));
}

/**
 * `pr.private_report/v1` review work through `ApplicationRunPort` only.
 * N bounded specialist invokes + 1 synthesis with separate contexts and finite budgets.
 * Admission (`prepare`) captures the owner-configured route (project default,
 * then owner default) with its configuration revisions and the review policy;
 * a concrete port without a configured route is rejected before dispatch, and
 * retries reuse the first capture without fallback. Every request is packed to
 * the port's source/byte limits and the exact transmitted manifest is committed
 * with the report; completion derives from it. Snapshot capture stays on
 * `TrustedGitHubConnector` + `fixtureFor`, never through this port.
 */
export function prReviewWork(options: PrReviewWorkOptions): WorkDefinition {
  const sourceLimit = options.sourceLimit ?? 8;
  const contextBytes = options.contextBytes ?? 32768;
  const outputBytes = options.outputBytes ?? 4096;
  const policy: PrReviewPolicy = options.reviewPolicy
    ? { version: options.reviewPolicy.version, requiredRoles: [...options.reviewPolicy.requiredRoles] }
    : { version: DEFAULT_REVIEW_POLICY.version, requiredRoles: [...DEFAULT_REVIEW_POLICY.requiredRoles] };
  if (!Number.isSafeInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > 32 || !Number.isSafeInteger(contextBytes) || contextBytes < 1 || contextBytes > 65536 ||
      !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > 65536 ||
      !Number.isSafeInteger(policy.version) || policy.version < 1 || policy.requiredRoles.length < 1 || policy.requiredRoles.length > 8 ||
      policy.requiredRoles.some(role => !/^[a-z][a-z0-9_-]{0,63}$/.test(role))) throw new AppError("invalid_work_definition");
  const now = options.now ?? Date.now;
  const port = options.port;
  const captureCurrent = (capture: PrReviewCapture) => capture.reviewPolicy.version === policy.version && capture.adapter === port.adapter;
  return {
    replay: "read",
    id: "pr.review",
    title: "ตรวจ PR แบบ static ส่วนตัว",
    revision: 1,
    route: { provider: "jit-service", model: null, authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: (input, scope) => isInput(input) && scope.inputRevision === scope.projectRevision,
    prepare: (tx, job) => {
      if (!isInput(job.input)) throw new AppError("invalid_job_input");
      const prior = readAttempts(tx, job.id).map(attempt => attempt.data as unknown).find(isCapture);
      if (prior) {
        // Retries keep the admitted route exactly; a changed policy or adapter fences the job.
        if (!captureCurrent(prior)) throw new AppError("pr_review_policy_changed", 409);
        return { native: null, data: prior as unknown as JobData };
      }
      const resolved = resolvePrReviewRoute(tx, job.projectId);
      if (!resolved && port.adapter !== "scripted") throw new AppError("pr_review_route_missing", 409);
      const capture: PrReviewCapture = {
        version: 1,
        adapter: port.adapter,
        route: resolved ? { ...resolved.route } : { ...PR_REVIEW_SCRIPTED_ROUTE },
        layer: resolved ? resolved.layer : "scripted_fixture",
        configuration: {
          ownerRevision: resolved?.ownerRevision ?? 0,
          projectRevision: resolved?.projectRevision ?? 0,
          roleRevision: policy.version,
        },
        reviewPolicy: { version: policy.version, requiredRoles: [...policy.requiredRoles] },
      };
      return { native: null, data: capture as unknown as JobData };
    },
    isCurrent: (tx, job, attempt) => {
      if (!isInput(job.input)) return false;
      if (!isCapture(attempt.data) || !captureCurrent(attempt.data)) return false;
      try {
        ensurePrSchema(tx);
        const monitor = readMonitor(tx, job.projectId, job.input.monitorId);
        if (monitor.state !== "active") return false;
        const candidate = readCandidate(tx, job.projectId, job.input.candidateId);
        return !["superseded", "cancelled", "stale", "closed"].includes(candidate.status);
      } catch { return false; }
    },
    run: async ({ job, attempt, signal, reserve, commit }) => {
      if (signal.aborted || !isInput(job.input) || !isCapture(attempt.data)) return { state: "failed", reason: "worker_failed" };
      const input = job.input;
      const capture = attempt.data;
      const requiredRoles = capture.reviewPolicy.requiredRoles;
      let snapshot: ImmutableSnapshot;
      try {
        snapshot = options.store.read(tx => {
          ensurePrSchema(tx);
          const candidate = readCandidate(tx, job.projectId, input.candidateId);
          const monitor = readMonitor(tx, job.projectId, input.monitorId);
          if (candidate.monitorId !== monitor.id) throw new AppError("pr_candidate_not_current", 409);
          return readSnapshot(tx, candidate.id);
        });
      } catch {
        return { state: "failed", reason: "worker_failed" };
      }

      const requestFor = (role: string | null, sources: ManifestSource[], contextId: string) => buildRequest({
        projectId: job.projectId,
        topicId: input.candidateId,
        purpose: role
          ? `specialist:${role} review PR #${snapshot.pullNumber} ${snapshot.headSha.slice(0, 8)}`
          : `synthesis review PR #${snapshot.pullNumber} ${snapshot.headSha.slice(0, 8)}`,
        responsibility: role ? `วิเคราะห์ ${role} จาก snapshot แบบ static เท่านั้น` : "สังเคราะห์ผล specialist ที่อ้างอิงได้เท่านั้น",
        capture,
        manifestSources: sources,
        job: { id: job.id, authorization: job.authorization, limits: job.limits },
        generation: attempt.generation,
        contextId,
      });
      // Exact budget: request envelope measured, remaining bytes split across sources.
      const capacityFor = (slots: number) => {
        const overhead = Math.max(...[...requiredRoles, null].map(role =>
          Buffer.byteLength(jobData(requestFor(role, [], crypto.randomUUID()), 1 << 20))));
        return Math.floor((contextBytes - overhead - slots * SOURCE_ENVELOPE - 64) / Math.max(1, slots));
      };
      const specialistPack = pack(snapshotItems(snapshot, capture.reviewPolicy.version), sourceLimit, capacityFor(sourceLimit));
      const sources = toSources(job.projectId, specialistPack.chunks);

      // Finite budgets: every call pre-reserves its worst-case retry attempts.
      const calls = requiredRoles.length + 1;
      const attempts = port.adapter === "schway" ? schwayMaxAttempts({ limits: job.limits }) : 1;
      const perCallOutputTokens = Math.max(1, Math.floor(job.limits.outputTokens / calls));
      const callOutputBytes = Math.min(outputBytes, perCallOutputTokens * 4, 65000);
      const usageFor = (request: ApplicationRunRequest): JobUsage => ({
        calls: attempts, rounds: attempts, hops: 1,
        contextTokens: Math.ceil(Buffer.byteLength(jobData(request, contextBytes)) / 4),
        outputTokens: perCallOutputTokens,
      });
      const probe = requestFor(requiredRoles[0]!, sources, crypto.randomUUID());
      let specialistUsage: JobUsage;
      try { specialistUsage = usageFor(probe); } catch { return { state: "failed", reason: "worker_failed" }; }
      const worst: Required<JobUsage> = {
        roles: 0,
        calls: attempts * calls, rounds: attempts * calls, hops: calls,
        contextTokens: specialistUsage.contextTokens! * requiredRoles.length + Math.ceil(contextBytes / 4),
        outputTokens: perCallOutputTokens * calls,
        retries: 0,
      };
      const persist = (fields: {
        specialistRuns: Array<{ role: string; state: string; reason: string | null; mode?: "fixture" | "production" }>;
        synthesis: { state: string; reason: string | null };
        output: string;
        transmitted: TransmittedManifest | null;
        mode: "fixture" | "production" | null;
        extraDisagreements: string[];
      }) => {
        const normalized = normalizeReviewOutput(
          fields.output || JSON.stringify({ findings: [], analyzedRoles: [], skippedScope: requiredRoles, disagreements: [] }),
          snapshot, requiredRoles, fields.transmitted,
        );
        const merged = { ...normalized, disagreements: [...normalized.disagreements, ...fields.extraDisagreements].slice(0, 16) };
        const evidence = `pr-review:${input.candidateId};policy:v${capture.reviewPolicy.version};route:${capture.layer};roles:${fields.specialistRuns.map(r => `${r.role}=${r.state}`).join(",")};synthesis:${fields.synthesis.state};findings:${merged.findings.length};mode:${fields.mode ?? "none"}`;
        const outcome = { state: "succeeded" as const, evidence: evidence.slice(0, 1024) };
        const at = now();
        const ok = commit(outcome, (tx) => {
          persistReport(tx, {
            projectId: job.projectId,
            monitorId: input.monitorId,
            candidateId: input.candidateId,
            snapshot,
            normalized: merged,
            requiredRoles,
            specialistRuns: fields.specialistRuns,
            synthesis: fields.synthesis,
            transmitted: fields.transmitted,
            capture,
            mode: fields.mode,
            currentReviewPolicyVersion: policy.version,
            jobId: job.id,
            attemptId: attempt.id,
            now: at,
          });
        });
        return ok ? outcome : { state: "failed" as const, reason: "worker_failed" as const };
      };

      const remaining = job.remaining;
      const shortfall = (Object.keys(worst) as Array<keyof JobUsage>).filter(key => worst[key] > remaining[key]);
      if (shortfall.length) {
        // Budget exhaustion is an honest incomplete report; nothing is dispatched.
        const reason = "budget_exhausted";
        return persist({
          specialistRuns: requiredRoles.map(role => ({ role, state: "incomplete", reason })),
          synthesis: { state: "incomplete", reason },
          output: "", transmitted: null, mode: null,
          extraDisagreements: [`budget: worst-case ${shortfall.map(key => `${key} ${worst[key]}>${remaining[key]}`).join(", ")}`],
        });
      }

      const invoke = async (request: ApplicationRunRequest): Promise<ApplicationRunOutcome | "reserve_failed"> => {
        try { reserve(usageFor(request)); } catch { return "reserve_failed"; }
        try {
          return normalizePortResult(await port.invoke(request, signal, () => {}), request, callOutputBytes);
        } catch { return portFailureOutcome(port); }
      };
      const openContext = () => {
        const contextId = crypto.randomUUID();
        try {
          options.store.read(tx => { tx.run("INSERT OR IGNORE INTO team_contexts VALUES (?, 1, 'active')", contextId); });
        } catch { /* Context table may be unavailable in minimal fixtures; port still fences. */ }
        return contextId;
      };

      const specialistOutcomes: Array<{ role: string; output: string | null; state: string; reason: string | null; mode: "fixture" | "production" }> = [];
      for (const role of requiredRoles) {
        if (signal.aborted) return { state: "failed", reason: "worker_failed" };
        const request = requestFor(role, sources, openContext());
        const outcome = await invoke(request);
        if (outcome === "reserve_failed") return { state: "failed", reason: "worker_failed" };
        if (outcome.reason === "quota" || outcome.reason === "needs_login" || outcome.reason === "route_unavailable") {
          return { state: "waiting", reason: outcome.reason };
        }
        if (outcome.reason === "cancelled" || signal.aborted) return { state: "failed", reason: "worker_failed" };
        const complete = outcome.state === "complete" && !!outcome.output;
        specialistOutcomes.push({ role, output: complete ? outcome.output : null, state: complete ? "complete" : outcome.state, reason: complete ? null : outcome.reason, mode: outcome.mode });
      }

      // Synthesis reserves a slot for every required specialist result; peer text stays untrusted evidence.
      const synthesisItems: PackItem[] = [headerItem(snapshot, capture.reviewPolicy.version), ...specialistOutcomes.map(item => ({
        kind: "specialist" as const, ref: item.role, required: true, unavailable: !item.output,
        text: item.output ? `specialist ${item.role} (${item.mode})\n${item.output}` : `specialist ${item.role}: no result (${item.state}/${item.reason ?? "none"})`,
      }))];
      const synthesisSlots = Math.min(sourceLimit, synthesisItems.length);
      const synthesisPack = pack(synthesisItems, synthesisSlots, capacityFor(synthesisSlots));
      const synthesisRequest = requestFor(null, toSources(job.projectId, synthesisPack.chunks), openContext());
      const synthesisOutcome = await invoke(synthesisRequest);
      if (synthesisOutcome === "reserve_failed") return { state: "failed", reason: "worker_failed" };
      if (synthesisOutcome.reason === "quota" || synthesisOutcome.reason === "needs_login" || synthesisOutcome.reason === "route_unavailable") {
        return { state: "waiting", reason: synthesisOutcome.reason };
      }
      if (synthesisOutcome.reason === "cancelled" || signal.aborted) return { state: "failed", reason: "worker_failed" };

      const transmitted: TransmittedManifest = {
        version: 1, sourceLimit, contextBytes,
        specialist: specialistPack.entries,
        synthesis: synthesisPack.entries,
      };
      const synthesisOutput = synthesisOutcome.state === "complete" && synthesisOutcome.output ? synthesisOutcome.output : "";
      const parsedValid = normalizeReviewOutput(synthesisOutput || "{}", snapshot, requiredRoles, transmitted).valid;
      return persist({
        specialistRuns: specialistOutcomes.map(item => ({ role: item.role, state: item.state, reason: item.reason, mode: item.mode })),
        synthesis: {
          state: synthesisOutcome.state === "complete" && parsedValid ? "complete" : synthesisOutcome.state,
          reason: synthesisOutcome.reason ?? null,
        },
        output: synthesisOutput,
        transmitted,
        mode: synthesisOutcome.mode,
        // Specialist outputs that synthesis could not use stay visible as disagreements, never silent consensus.
        extraDisagreements: specialistOutcomes.filter(item => !item.output).map(item => `${item.role}: ${item.state}${item.reason ? `/${item.reason}` : ""}`),
      });
    },
  };
}

import { attachmentSources, replayAttachmentLifecycle, attachmentInventory } from "../attachments/lifecycle";
import { AppError } from "../errors";
import { invalidatePendingJob, jobData } from "../jobs/queue";
import { requireId, requireText, type SourceReference } from "../sources";
import type { AppTransaction } from "../store";
import type { Discussion } from "../team/types";
import { fenceStaleContexts, lexicalScore, lexicalTerms } from "./context";
import { fenceUnavailableExtractions } from "./extract";
import { forgetLineage } from "./lineage";
import { lookupActiveClaim, requireClaimReference, suppressedClaim, suppressedSource } from "./read";
import type {
  ClaimReference, ForgetMemoryCommand, MemoryClaim, MemorySuppression, SuppressedClaimIdentity,
  SuppressedContextIdentity, SuppressedSourceIdentity, SuppressionImpact, SuppressionLedger, SuppressionReceipt,
} from "./types";

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates the complete owner forget command before any state is read; receipt deduplication hashes the result. */
export function forgetIdentity(command: ForgetMemoryCommand, contextBytes: number): string {
  const encoded = jobData(command, contextBytes);
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || command.kind !== "memory.forget" ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 ||
      !exact(command.payload, ["acknowledged", "claim", "reason"])) throw new AppError("invalid_memory_forget");
  requireId(command.projectId);
  requireClaimReference(command.payload.claim);
  requireText(command.payload.reason, 500);
  if (typeof command.payload.acknowledged !== "boolean") throw new AppError("invalid_memory_forget");
  return encoded;
}

/** The durable forget for one claim revision, or null when it was never forgotten. */
export function readSuppression(tx: AppTransaction, projectId: string, claimId: string): MemorySuppression | null {
  requireId(projectId); requireId(claimId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_suppressions WHERE project_id = ? AND claim_id = ?", projectId, claimId);
  return row ? JSON.parse(row.record_json) as MemorySuppression : null;
}

const sameSource = (a: { sourceId: string; revision: number; generation: number }, b: { sourceId: string; revision: number; generation: number }) =>
  a.sourceId === b.sourceId && a.revision === b.revision && a.generation === b.generation;

interface Withdrawn { projectId: string; claim: MemoryClaim }

/**
 * Conservative forget scope: the exact claim, every transitive dependent across
 * projects, and sibling claims from the same exact source revision. Raw sources
 * are never deleted; their lineage is bound in memory_suppressed_sources instead.
 */
/**
 * Sources that copy the same owner text as `source` by recorded lineage: a chat title derived from a chat's first
 * message (chat-first home, `chat_title_sources`) and that message are twins, in either direction. A forget of one
 * suppresses both, so automatic memory can never rebuild the forgotten text from the other copy.
 */
export function chatTitleTwins(tx: AppTransaction, source: SourceReference): { projectId: string; source: SourceReference }[] {
  return tx.all<{ projectId: string; sourceId: string; revision: number; generation: number }>(
    `SELECT s.project_id AS projectId, s.id AS sourceId, s.current_revision AS revision, s.generation FROM chat_title_sources c
     JOIN sources s ON s.id = CASE WHEN c.title_source_id = ? THEN c.message_source_id ELSE c.title_source_id END
     WHERE c.title_source_id = ? OR c.message_source_id = ?`, source.sourceId, source.sourceId, source.sourceId)
    .map(row => ({ projectId: row.projectId, source: { sourceId: row.sourceId, revision: row.revision, generation: row.generation } }));
}

function withdrawnSet(tx: AppTransaction, projectId: string, claim: MemoryClaim): Map<string, Withdrawn> {
  const found = new Map<string, Withdrawn>();
  found.set(claim.claimId, { projectId, claim });
  const triples = [{ ...claim.source }, ...chatTitleTwins(tx, claim.source).map(twin => twin.source)];
  for (let round = 0; round < 10; round++) {
    let added = false;
    for (const row of tx.all<{ project_id: string; record_json: string }>("SELECT project_id, record_json FROM memory_claims LIMIT 4000")) {
      let candidate: MemoryClaim;
      try { candidate = JSON.parse(row.record_json) as MemoryClaim; } catch { continue; }
      if (found.has(candidate.claimId)) continue;
      const linked = [...candidate.dependencies, ...candidate.conflicts].some(ref => found.has(ref.claimId));
      const sibling = triples.some(triple => sameSource(triple, candidate.source));
      if (!linked && !sibling) continue;
      found.set(candidate.claimId, { projectId: row.project_id, claim: candidate });
      for (const source of [candidate.source, ...chatTitleTwins(tx, candidate.source).map(twin => twin.source)]) {
        if (!triples.some(triple => sameSource(triple, source))) triples.push({ ...source });
      }
      added = true;
    }
    if (!added) break;
  }
  return found;
}

function overlapTitles(tx: AppTransaction, projectId: string, text: string): SuppressionImpact["overlaps"] {
  const query = lexicalTerms(text), overlaps: SuppressionImpact["overlaps"] = [];
  const clip = (value: string) => Array.from(value).slice(0, 120).join("");
  for (const row of tx.all<{ id: string; title: string; summary: string }>(
    "SELECT id, title, summary FROM tasks WHERE project_id = ? AND state IN ('proposed', 'accepted', 'ready_for_review') LIMIT 200", projectId)) {
    if (lexicalScore(query, `${row.title}\n${row.summary}`) >= 3) overlaps.push({ kind: "task", id: row.id, title: clip(row.title) });
  }
  for (const row of tx.all<{ id: string; conclusion: string; rationale: string }>(
    "SELECT id, conclusion, rationale FROM owner_decisions WHERE project_id = ? AND superseded_by IS NULL LIMIT 200", projectId)) {
    if (lexicalScore(query, `${row.conclusion}\n${row.rationale}`) >= 3) overlaps.push({ kind: "decision", id: row.id, title: clip(row.conclusion) });
  }
  return overlaps;
}

const forgetNote = "การลืมถอน memory ที่เลือกกับข้ออนุมานที่พึ่งมันเท่านั้น ไม่ยกเลิกงาน ไม่ถอนมติ ไม่เปลี่ยนบทบาทหรือสิทธิ์ที่รับรองแล้ว " +
  "ต้นฉบับยังเปิดดูเองได้แต่ถูกแยกออกจาก memory อัตโนมัติ งานที่ค้างซึ่งใช้ข้อความเดิมจะถูก fence บริบทเดิมไม่ถูกใช้อ้างอิงอีก";

/**
 * app.memory_suppression/v1 inspector preview: the exact claim, its existing
 * suppression, transitive cross-project dependents, same-source siblings that the
 * conservative granularity also withdraws, recorded run contexts that used any of
 * them, pending jobs that would fence, and active tasks/decisions whose wording
 * overlaps so the owner can confirm scope before anything mutates.
 */
export function suppressionImpact(tx: AppTransaction, projectId: string, reference: ClaimReference): SuppressionImpact {
  requireId(projectId); requireClaimReference(reference);
  const claim = lookupActiveClaim(tx, projectId, reference);
  const suppression = readSuppression(tx, projectId, reference.claimId);
  if (claim.state !== "available") {
    return { claim, suppression, dependents: [], siblings: [], contexts: [], pendingJobs: [], overlaps: [], note: forgetNote };
  }
  const withdrawn = withdrawnSet(tx, projectId, claim.claim);
  const ids = new Set(withdrawn.keys());
  const direct = [...withdrawn.values()].filter(entry =>
    entry.claim.claimId !== reference.claimId &&
    [...entry.claim.dependencies, ...entry.claim.conflicts].some(ref => ref.claimId === reference.claimId));
  const siblings = [...withdrawn.values()].filter(entry =>
    entry.claim.claimId !== reference.claimId && !direct.some(item => item.claim.claimId === entry.claim.claimId) &&
    sameSource(entry.claim.source, claim.claim.source));
  const indirect = [...withdrawn.values()].filter(entry =>
    entry.claim.claimId !== reference.claimId && !direct.some(item => item.claim.claimId === entry.claim.claimId) &&
    !siblings.some(item => item.claim.claimId === entry.claim.claimId));
  const listed = [...direct, ...indirect].map(entry => ({ projectId: entry.projectId,
    reference: { claimId: entry.claim.claimId, revision: entry.claim.revision, generation: entry.claim.generation }, text: null as string | null }));
  const { sources, lineage } = suppressedLineage(tx, withdrawn);
  const placeholders = [...ids].map(() => "?").join(",");
  const contexts = placeholders ? tx.all<{ id: string; generation: number; projectId: string; ownerKind: string; ownerId: string }>(
    `SELECT c.id, e.generation AS generation, c.project_id AS projectId, c.owner_kind AS ownerKind, c.owner_id AS ownerId
     FROM memory_context_entries e JOIN memory_contexts c ON c.id = e.context_id
     WHERE e.kind = 'claim' AND e.entry_id IN (${placeholders}) LIMIT 100`, ...ids) : [];
  return { claim, suppression,
    dependents: listed,
    siblings: siblings.map(entry => ({ projectId: entry.projectId,
      reference: { claimId: entry.claim.claimId, revision: entry.claim.revision, generation: entry.claim.generation } })),
    contexts: contexts.map(row => ({ id: row.id, generation: row.generation ?? 1, projectId: row.projectId, ownerKind: row.ownerKind, ownerId: row.ownerId })),
    pendingJobs: dedupeJobs([...pendingReferencing(tx, ids, suppressedKeys(sources)), ...lineage.pendingJobs]),
    attachments: [...new Set(sources.map(e => e.projectId))].map(id => attachmentInventory(tx, id, sources.map(e => e.source.sourceId))).reduce((n, a) => ({ count: n.count + a.count, bytes: n.bytes + a.bytes }), { count: 0, bytes: 0 }),
    overlaps: overlapTitles(tx, projectId, claim.claim.text),
    note: forgetNote };
}

const dedupeJobs = (jobs: { id: string; projectId: string }[]) => [...new Map(jobs.map(job => [job.id, job])).values()];

const sourceKey = (ref: SourceReference) => `${ref.sourceId}:${ref.revision}:${ref.generation}`;
const suppressedKeys = (sources: readonly SuppressedSourceIdentity[]) => new Set(sources.map(entry => sourceKey(entry.source)));

/**
 * The sources one forget suppresses: those of every withdrawn claim, their chat-title twins, and every derived output
 * of them by any producer ({@link forgetLineage}), with the pending jobs of producers that were given any of them.
 */
function suppressedLineage(tx: AppTransaction, withdrawn: Map<string, Withdrawn>): {
  sources: SuppressedSourceIdentity[]; lineage: ReturnType<typeof forgetLineage>;
} {
  const sources: SuppressedSourceIdentity[] = [];
  const seen = new Set<string>();
  const bind = (entry: SuppressedSourceIdentity) => {
    if (seen.has(sourceKey(entry.source))) return;
    seen.add(sourceKey(entry.source)); sources.push({ projectId: entry.projectId, source: { ...entry.source } });
  };
  for (const entry of withdrawn.values()) bind({ projectId: entry.projectId, source: entry.claim.source });
  // A chat title and the first message it was derived from are one lineage: forgetting either suppresses both.
  for (const entry of [...sources]) for (const twin of chatTitleTwins(tx, entry.source)) bind(twin);
  // Jit replies, specialist results, role previews and coordinator syntheses that were given a forgotten source,
  // directly or through an earlier output, may copy it: their outputs join the suppressed lineage.
  for (const entry of attachmentSources(tx, sources.map(e => e.source.sourceId))) bind(entry);
  const lineage = forgetLineage(tx, sources.map(entry => entry.source));
  for (const output of lineage.outputs) bind(output);
  return { sources, lineage };
}

/** Pending work that admitted a withdrawn claim or a suppressed source (`suppressed`, or already recorded), across projects. */
function pendingReferencing(tx: AppTransaction, ids: Set<string>, suppressed: Set<string>): { id: string; projectId: string }[] {
  const found = new Map<string, { id: string; projectId: string }>();
  const pending = "state IN ('queued', 'admitted', 'waiting')";
  const cites = (refs: ClaimReference[] | undefined) => refs?.some(ref => ids.has(ref.claimId)) ?? false;
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM memory_extractions WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT 500`)) {
    try {
      const extraction = JSON.parse(row.json) as { dependencies?: ClaimReference[]; source?: { sourceId: string; revision: number; generation: number } };
      if (cites(extraction.dependencies) || (extraction.source && (suppressed.has(sourceKey(extraction.source)) || suppressedSource(tx, extraction.source)))) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    } catch { /* Corrupt rows fail closed elsewhere; impact stays silent here. */ }
  }
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM team_runs WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT 500`)) {
    try {
      const parsed = JSON.parse(row.json) as { kind?: string; request?: { manifest?: { claims?: { claimId: string }[] } }; manifest?: { claims?: { claimId: string }[] } };
      const referenced = parsed.request?.manifest?.claims ?? (parsed.kind === "discussion" ? parsed.manifest?.claims : undefined);
      if (referenced?.some(claim => ids.has(claim.claimId))) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    } catch { /* See above. */ }
  }
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM coordinator_syntheses WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT 500`)) {
    try {
      const request = (JSON.parse(row.json) as { request?: { manifest?: { claims?: { claimId: string }[] } } }).request;
      if (request?.manifest?.claims?.some(claim => ids.has(claim.claimId))) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    } catch { /* See above. */ }
  }
  return [...found.values()];
}

/**
 * Discussions store their assembled manifest at the top level (not under `.request`),
 * so the shared stale-context fence cannot see them. A discussion whose manifest still
 * cites a withdrawn claim is fenced here with its specialist participations; the next
 * run must assemble a fresh context from permitted sources before any result can commit.
 */
function fenceSuppressedDiscussions(tx: AppTransaction, ids: Set<string>, now: number): string[] {
  const fenced: string[] = [];
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>("SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM team_runs LIMIT 2000")) {
    let discussion: Discussion;
    try {
      discussion = JSON.parse(row.json) as Discussion;
      if (discussion.kind !== "discussion" || !discussion.manifest) continue;
    } catch { continue; }
    if (!discussion.manifest.claims.some(claim => ids.has(claim.claimId))) continue;
    for (const jobId of [discussion.jobId, ...discussion.participations.map(item => item.jobId)]) {
      const state = tx.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", jobId)?.state;
      if (!state || !["queued", "admitted", "waiting"].includes(state)) continue;
      invalidatePendingJob(tx, row.projectId, jobId, "source_retired", now);
      fenced.push(jobId);
    }
  }
  return fenced;
}

/** Native contexts owned by jobs this suppression fenced, for the run_port retirement checkpoint. */
function fencedContexts(tx: AppTransaction, jobIds: Set<string>): SuppressedContextIdentity[] {
  const found = new Map<string, SuppressedContextIdentity>();
  if (!jobIds.size) return [];
  const placeholders = [...jobIds].map(() => "?").join(",");
  for (const row of tx.all<{ contextId: string }>(`SELECT context_id AS contextId FROM team_runs WHERE job_id IN (${placeholders})`, ...jobIds)) {
    const context = tx.get<{ generation: number }>("SELECT generation FROM team_contexts WHERE id = ?", row.contextId);
    if (context) found.set(`${row.contextId}:${context.generation}`, { id: row.contextId, generation: context.generation });
  }
  for (const row of tx.all<{ json: string }>(`SELECT record_json AS json FROM job_attempts WHERE job_id IN (${placeholders})`, ...jobIds)) {
    try {
      const native = (JSON.parse(row.json) as { native?: { context?: SuppressedContextIdentity } }).native?.context;
      if (native) found.set(`${native.id}:${native.generation}`, { id: native.id, generation: native.generation });
    } catch { /* Attempts without native references retire nothing. */ }
  }
  return [...found.values()];
}

/**
 * app.memory_suppression/v1
 * Withdraws one exact active claim revision with an explicitly acknowledged owner
 * command. The claim, its transitive dependents and same-source siblings become
 * forgotten across projects; their old source lineage is bound in
 * memory_suppressed_sources so extraction, retrieval and context assembly can never
 * rebuild them (generation-fenced). Raw message sources stay readable through ordinary
 * source reads; reached attachment files are retired and removed. Queued and running work that admitted withdrawn material is fenced
 * in the same transaction; native session retirement continues through the existing
 * jobs.session_reconcile lifecycle. Tasks, decisions, roles and standing
 * authorizations are never modified here.
 */
export function prepareSuppression(tx: AppTransaction, command: ForgetMemoryCommand, contextBytes: number, ownerRevision: number, projectRevision: number, now: number): SuppressionReceipt {
  forgetIdentity(command, contextBytes);
  const p = command.payload;
  if (projectRevision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (readSuppression(tx, command.projectId, p.claim.claimId)) throw new AppError("memory_already_forgotten", 409);
  const found = lookupActiveClaim(tx, command.projectId, p.claim);
  if (found.state !== "available") throw new AppError("memory_forget_unavailable", 409);
  if (!p.acknowledged) throw new AppError("memory_forget_ambiguous", 409);
  const target = found.claim;
  const withdrawn = withdrawnSet(tx, command.projectId, target);
  const ids = new Set(withdrawn.keys());
  const overlaps = overlapTitles(tx, command.projectId, target.text);
  const suppressionId = crypto.randomUUID();
  const listed: SuppressedClaimIdentity[] = [...withdrawn.values()].map(entry => ({ projectId: entry.projectId,
    claimId: entry.claim.claimId, revision: entry.claim.revision, generation: entry.claim.generation }));
  const { sources, lineage } = suppressedLineage(tx, withdrawn);
  const suppression: MemorySuppression = { id: suppressionId, projectId: command.projectId, claimId: target.claimId,
    fromRevision: target.revision, fromGeneration: target.generation,
    withdrawn: listed, sources, contexts: [], overlaps,
    attachments: [...new Set(sources.map(e => e.projectId))].map(projectId => ({ ...attachmentInventory(tx, projectId, sources.map(e => e.source.sourceId)), projectId, state: "pending" as const, attempts: 0, reason: null })).filter(a => a.count > 0),
    reason: p.reason, acknowledged: p.acknowledged,
    ownerRevision, projectRevision, createdAt: now };
  // The final suppressed set is recorded first, so every fence below (and the currentness checks it relies on) sees
  // each title twin and derived output this forget adds, not only the sources that were suppressed before it.
  tx.run("INSERT INTO memory_suppressions (id, project_id, claim_id, record_json) VALUES (?, ?, ?, ?)",
    suppression.id, command.projectId, target.claimId, JSON.stringify(suppression));
  for (const entry of withdrawn.values()) {
    if (suppressedClaim(tx, entry.claim.claimId)) continue;
    const forgotten: MemoryClaim = { ...entry.claim, status: "forgotten" };
    tx.run("UPDATE memory_claims SET record_json = ? WHERE id = ? AND project_id = ?", JSON.stringify(forgotten), entry.claim.claimId, entry.projectId);
    tx.run("INSERT OR IGNORE INTO memory_suppressed_claims VALUES (?, ?, ?)", suppressionId, entry.projectId, entry.claim.claimId);
  }
  for (const source of sources) {
    tx.run("INSERT OR IGNORE INTO memory_suppressed_sources VALUES (?, ?, ?, ?, ?)",
      suppressionId, source.projectId, source.source.sourceId, source.source.revision, source.source.generation);
  }
  replayAttachmentLifecycle(tx, now);
  const fenced = dedupeJobs([...pendingReferencing(tx, ids, suppressedKeys(sources)), ...lineage.pendingJobs]);
  const fencedJobs = new Set(fenced.map(job => job.id));
  for (const job of fenced) invalidatePendingJob(tx, job.projectId, job.id, "source_retired", now);
  // Every fence below adds its jobs too: a run that admitted a claim of a newly suppressed output is fenced only by the
  // stale-context check, and its context must still be listed so the ledger cannot report complete too early.
  for (const jobId of fenceSuppressedDiscussions(tx, ids, now)) fencedJobs.add(jobId);
  for (const jobId of fenceStaleContexts(tx, now)) fencedJobs.add(jobId);
  // Every project that owns a withdrawn claim or a suppressed source, not only the claims' projects.
  const projects = new Set([...[...withdrawn.values()].map(entry => entry.projectId), ...sources.map(entry => entry.projectId)]);
  for (const project of projects) for (const jobId of fenceUnavailableExtractions(tx, project, now)) fencedJobs.add(jobId);
  suppression.contexts = fencedContexts(tx, fencedJobs);
  tx.run("UPDATE memory_suppressions SET record_json = ? WHERE id = ?", JSON.stringify(suppression), suppression.id);
  return { suppression, withdrawn: listed };
}

/**
 * app.suppression_ledger/v1
 * The durable checkpoint with live retirement status. Complete only when every
 * covered native context reached retired/deleted through the run_port reconcile
 * lifecycle; pending, failed or never-reconciled contexts keep the ledger
 * incomplete so the UI never claims complete forgetting.
 */
export function suppressionLedger(tx: AppTransaction, projectId: string, claimId: string): SuppressionLedger | null {
  requireId(projectId); requireId(claimId);
  const suppression = readSuppression(tx, projectId, claimId);
  if (!suppression) return null;
  const contexts = suppression.contexts.map(context => {
    const appState = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state ?? "missing";
    const record = tx.get<{ record_json: string }>("SELECT record_json FROM job_reconciliation WHERE id = ?",
      `context:${context.id}:${context.generation}`);
    const lifecycle = record ? (JSON.parse(record.record_json) as { lifecycle: string }).lifecycle : "not_requested";
    return { ...context, appState, lifecycle };
  });
  const complete = (suppression.attachments ?? []).every(a => a.state === "purged") && contexts.every(context => context.lifecycle === "retired" || context.lifecycle === "deleted");
  return { suppression, retire: { state: complete ? "complete" : "incomplete", contexts },
    note: complete ? "บริบทที่ได้รับผลกระทบ retire ครบแล้ว งานถัดไปเริ่มจากต้นฉบับที่อนุญาตเท่านั้น"
      : "ยัง retire บริบทไม่ครบ ตรวจงานที่ถูก fence และรัน reconcile ซ้ำ ห้ามอ้างว่าลืมครบจนกว่า ledger จะ complete" };
}

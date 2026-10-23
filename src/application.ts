import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";
import type { AppConfig } from "./config";
import { TransactionStore, type AppTransaction } from "./store";
import { conversationIdentity, mutateConversation, readMessages, readTopic, readTopics, requireCursor,
  type ConversationCommand, type CreateTopicCommand, type SendMessageCommand, type TopicReceipt, type MessageReceipt } from "./conversation";
import { lookupSource, requireId, requireReference, type SourceReference, type SourceLookup } from "./sources";
import type { SessionReconciliation } from "./jobs/reconcile";
import type { JobStopOutcome } from "./jobs/types";
import { readAttempts } from "./jobs/attempts";
import { JobQueue, jobCommandIdentity, projectJob, readJob, readJobs } from "./jobs/queue";
import type { EnqueueJobCommand, ResumeJobCommand, JobCommand, JobReceipt } from "./jobs/types";
import { mutateTeamConfiguration, readTeam, teamIdentity } from "./team/configuration";
import { listDiscussions, prepareControl, prepareDispatch, projectDiscussion, readDiscussion } from "./team/dispatch";
import { acceptDecision, decisionIdentity, prepareSynthesis, readDecisionModel, supersedeDecision } from "./team/decisions";
import { preparePreview, readPreview } from "./team/preview";
import type { DecisionCommand, DecisionReadModel, DecisionReceipt, TeamCommand, TeamReceipt } from "./team/types";
import { coordinatorSynthesisWorkId } from "./team/types";
import {
  commitDeliveryIntent, deliveryCommandIdentity, listDeliveryAttempts, listDeliveryIntents, readDeliveryIntent,
  readDeliveryReport, resendDeliveryIntent, retireDeliveryReport,
} from "./delivery";
import { annotateReport, listReports, prReportIdentity, readAnnotations, readReport } from "./pr/report";
import { admitReportAlerts, evaluateReport } from "./pr/alerts";
import type {
  DismissReportCommand,
  PrReportCommand,
  PrReportReceipt,
} from "./pr/types";
import type {
  CommitDeliveryCommand, DeliveryCommand, DeliveryIntent, DeliveryPage, DeliveryReceipt, DeliveryReport,
  DeliveryResendReceipt, DeliveryRetireReceipt, ResendDeliveryCommand, RetireDeliveryCommand,
} from "./delivery";
import {
  applyTask, isTaskCommand, readProjectContinuity, readTaskCompletionPolicy, readTaskList, readTaskModel, taskIdentity,
  type ProjectContinuity, type TaskChannel, type TaskCommand, type TaskList, type TaskReadModel, type TaskReceipt,
} from "./tasks";

import { fenceUnavailableExtractions, memoryIdentity, prepareExtraction } from "./memory/extract";
import { correctionIdentity, correctionImpact, prepareCorrection, readCorrection } from "./memory/correct";
import {
  confirmDeletion, deleteCommandIdentity, listDeletionOperations, prepareDeletionPreview, readDeletionLedger,
  readDeletionOperation, readDeletionPreview, retryDeletion, type DeleteCommand, type DeletionConfirmReceipt,
  type DeletionOperation, type DeletionPreview, type DeletionReceipt,
} from "./memory/delete";
import { forgetIdentity, prepareSuppression, readSuppression, suppressionImpact, suppressionLedger } from "./memory/suppress";
import { lookupActiveClaim, readMemory, suppressedSource } from "./memory/read";
import type { ClaimReference, CorrectMemoryCommand, CorrectionImpact, CorrectionReceipt, ExtractMemoryCommand, ForgetMemoryCommand, MemoryContextView, MemoryExtraction, MemoryReceipt, SuppressionImpact, SuppressionLedger, SuppressionReceipt } from "./memory/types";
import { fenceStaleContexts, readMemoryContext, readOwnedMemoryContext } from "./memory/context";
import { commitDecisionMemorySource, memorySourceDecision, retireDecisionMemorySource } from "./memory/decision-sources";
import {
  executeScheduleCommand, listOccurrences, listSchedules, readSchedule, reminderWorkId, scheduleIdentity, summaryWorkId,
  type JobSchedule, type ScheduleCommand, type ScheduleOccurrence, type ScheduleReceipt,
} from "./jobs/schedules";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validToken = (value: string) => /^[a-f0-9]{64}$/.test(value);
const randomToken = () => crypto.getRandomValues(new Uint8Array(32)).toHex();

/** A server-issued owner identity; structural copies and model-provided objects carry no authority. */
export interface OwnerActor { readonly ownerId: "owner"; readonly channel: TaskChannel }

/** A revision-bound command shared by authenticated ingress adapters. */
export interface CreateProjectCommand {
  kind: "project.create";
  requestId: string;
  projectId: null;
  expectedRevision: number;
  payload: { name: string };
}

/** A committed project and its one stable conversation-group identity. */
export interface Project {
  id: string;
  name: string;
  revision: number;
  groupId: string;
  createdAt: number;
}

/** A durable receipt returned only after the project transaction commits. */
export interface ProjectReceipt { project: Project; workspaceRevision: number }

/** Owner-scoped, paginated workspace state with the revision required by create commands. */
export interface Workspace { revision: number; projects: Project[]; hasMore: boolean }

import {
  backupIdentity, enforceRetention, listBackups, ownBackupDir, prepareBackupManifest, readBackupManifest, resolveNativeSnapshot,
  writeArtifact, type BackupCommand, type BackupManifest, type BackupNativePort, type BackupReceipt,
} from "./ops/backup";
import {
  createExport, exportIdentity, exportPreview, listExportArtifacts, ownExportDir, readExportManifest,
  type ExportCommand, type ExportManifest, type ExportPreview, type ExportReceipt,
} from "./ops/export";
import {
  activateUpgrade, listUpgrades, migrateUpgrade, planUpgrade, prepareUpgrade, readUpgrade, recordFailedUpgrade, rollbackUpgrade,
  upgradeIdentity, validateUpgrade, ownUpgradeDirFor,
  type UpgradeCommand, type UpgradeJournal, type UpgradeReceipt,
} from "./ops/upgrade";
import {
  activateRestore, applyLedger, discardRestore, listQuarantines, migrateQuarantine, prepareRestore, readQuarantine,
  restoreIdentity, validateQuarantine, restoreEvidence, ownRestoreDirFor,
  type ExternalTombstone, type RestoreCommand, type RestoreQuarantine, type RestoreReceipt,
} from "./ops/restore";

/** Injectable clock and transaction fault seam for deterministic persistence checks. */
export interface ApplicationOptions {
  now?: () => number;
  beforeCommit?(stage: "project" | "topic" | "message" | "job" | "team" | "decision" | "delivery" | "task" | "memory" | "receipt" | "schedule" | "backup" | "ops"): void;
  jobs?: JobQueue;
  backupDir?: string;
  exportDir?: string;
  upgradeDir?: string;
  restoreDir?: string;
  nativeSnapshot?: BackupNativePort;
}

/** Owns identity validation and revisioned app commands independently of Web or model transports. */
export class Application {
  #actors = new WeakMap<OwnerActor, string>();
  #now: () => number;
  #beforeCommit: ApplicationOptions["beforeCommit"];
  #jobs: JobQueue | undefined;
  #backupDir: string;
  #exportDir: string;
  #restoreDir: string;
  #upgradeDir: string;
  #nativeSnapshot: BackupNativePort | undefined;

  constructor(readonly store: TransactionStore, readonly config: AppConfig, options: ApplicationOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#beforeCommit = options.beforeCommit;
    if (options.jobs && options.jobs.store !== store) throw new AppError("invalid_job_store");
    this.#jobs = options.jobs;
    this.#backupDir = ownBackupDir(store.path, options.backupDir);
    this.#exportDir = ownExportDir(store.path, options.exportDir);
    this.#restoreDir = ownRestoreDirFor(store.path, options.restoreDir);
    this.#upgradeDir = ownUpgradeDirFor(store.path, options.upgradeDir);
    this.#nativeSnapshot = options.nativeSnapshot;
  }

  /** Provisions exactly one owner through trusted local setup; no HTTP route exposes this method. */
  async setupOwner(password: string, reset = false): Promise<void> {
    if (typeof password !== "string" || password.length < 12 || password.length > 256) {
      throw new AppError("password_length_12_to_256");
    }
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.store.transaction(tx => {
      const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
      if (owner && !reset) throw new AppError("owner_already_configured", 409);
      if (!owner && reset) throw new AppError("owner_not_configured", 409);
      if (owner) {
        tx.run("UPDATE owner SET password_hash = ?, generation = generation + 1 WHERE id = 'owner'", hash);
      } else {
        tx.run("INSERT INTO owner VALUES ('owner', ?, 1)", hash);
      }
      tx.run("DELETE FROM sessions");
      tx.run("DELETE FROM login_throttle");
    });
  }

  /** Authenticates a password under an installation-wide persisted attempt budget. */
  async login(password: string): Promise<string> {
    const now = this.#now();
    const owner = this.store.transaction(tx => {
      const row = tx.get<{ window_start: number; attempts: number }>("SELECT * FROM login_throttle WHERE id = 1");
      const fresh = !row || now >= row.window_start + this.config.loginWindowSeconds * 1000;
      const attempts = fresh ? 0 : row.attempts;
      if (attempts >= this.config.loginAttempts) throw new AppError("login_limited_try_later", 429);
      tx.run("INSERT OR REPLACE INTO login_throttle VALUES (1, ?, ?)", fresh ? now : row.window_start, attempts + 1);
      return tx.get<{ password_hash: string; generation: number }>("SELECT password_hash, generation FROM owner WHERE id = 'owner'");
    });
    if (!owner) throw new AppError("owner_setup_required", 503);
    if (typeof password !== "string" || password.length > 256 || !await Bun.password.verify(password, owner.password_hash)) {
      throw new AppError("login_failed", 401);
    }
    const token = randomToken();
    this.store.transaction(tx => {
      const current = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
      if (current?.generation !== owner.generation) throw new AppError("login_failed", 401);
      tx.run("DELETE FROM sessions WHERE expires_at <= ?", this.#now());
      // One installation owner needs a finite set of concurrent browser sessions.
      tx.run("DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT 15)");
      tx.run("INSERT INTO sessions VALUES (?, 'owner', ?, ?)", digest(token), owner.generation,
        this.#now() + this.config.sessionSeconds * 1000);
    });
    return token;
  }

  /**
   * Issues an owner actor for a trusted adapter that already checked its own identity and holds a live session.
   * `telegram` labels the supported task, follow-up and reply boundary. It does not verify inbound identity or bypass revision and dedup rules.
   * Forged `{ ownerId, channel }` objects are not registered and cannot execute commands.
   */
  issueAdapterActor(sessionToken: string, channel: TaskChannel): OwnerActor {
    if (channel !== "web" && channel !== "telegram") throw new AppError("invalid_channel");
    if (!validToken(sessionToken)) throw new AppError("authentication_required", 401);
    const key = digest(sessionToken);
    this.store.read(tx => this.#session(tx, key));
    const actor: OwnerActor = Object.freeze({ ownerId: "owner", channel });
    this.#actors.set(actor, key);
    return actor;
  }

  /** Resolves a live server session into an opaque actor and a separate anti-CSRF token. */
  authenticate(token: string): { actor: OwnerActor; csrf: string } {
    if (!validToken(token)) throw new AppError("authentication_required", 401);
    const key = digest(token);
    this.store.read(tx => this.#session(tx, key));
    const actor: OwnerActor = Object.freeze({ ownerId: "owner", channel: "web" });
    this.#actors.set(actor, key);
    return { actor, csrf: digest(`jit.csrf.v1:${token}`) };
  }

  /** Compares the session-bound CSRF proof without rendering or exposing its session credential. */
  verifyCsrf(expected: string, supplied: unknown): void {
    if (typeof supplied !== "string" || !validToken(supplied) ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new AppError("csrf_rejected", 403);
  }

  /** Revokes this browser session, including actors issued before logout. */
  logout(actor: OwnerActor): void {
    this.store.transaction(tx => { const key = this.#requireOwner(tx, actor); tx.run("DELETE FROM sessions WHERE token_hash = ?", key); });
  }

  /** Returns one bounded owner projection; project names never select authorization identities. */
  workspace(actor: OwnerActor, offset = 0): Workspace {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new AppError("invalid_offset");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      const rows = tx.all<Project>(`SELECT p.id, p.name, p.revision, g.id AS groupId, p.created_at AS createdAt
        FROM projects p JOIN project_groups g ON g.project_id = p.id ORDER BY p.created_at, p.id LIMIT ? OFFSET ?`,
      this.config.pageSize + 1, offset);
      return { revision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision,
        projects: rows.slice(0, this.config.pageSize), hasMore: rows.length > this.config.pageSize };
    });
  }

  /** Resolves a project by stable identity under the authenticated owner, never by its name. */
  project(actor: OwnerActor, projectId: string): Project {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      return this.#project(tx, projectId);
    });
  }

  /** Reads a bounded topic list and the project revision used by topic creation without starting work. */
  topics(actor: OwnerActor, projectId: string, after = 0) {
    requireId(projectId); requireCursor(after);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      return { project: this.#project(tx, projectId), ...readTopics(tx, projectId, after, this.config.pageSize) };
    });
  }

  /** Reads one scoped topic and bounded committed history without creating commands, runs or memory. */
  conversation(actor: OwnerActor, projectId: string, topicId: string, after = 0) {
    requireId(projectId); requireId(topicId); requireCursor(after);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      const project = this.#project(tx, projectId), topic = readTopic(tx, projectId, topicId);
      return { project, topic, ...readMessages(tx, projectId, topicId, after, this.config.pageSize) };
    });
  }

  /** Resolves an exact source reference under an explicit authorized project and never fetches missing content. */
  source(actor: OwnerActor, projectId: string, reference: SourceReference): SourceLookup {
    requireId(projectId); requireReference(reference);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId);
      return lookupSource(tx, projectId, reference);
    });
  }

  /** Whether one exact source lineage is excluded from automatic memory by an owner forget. */
  sourceSuppressed(actor: OwnerActor, projectId: string, reference: SourceReference): boolean {
    requireId(projectId); requireReference(reference);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId);
      return suppressedSource(tx, reference);
    });
  }

  /** Commits a validated owner command, state, source records, receipt and audit as one transaction. */
  execute(actor: OwnerActor, command: ExtractMemoryCommand): MemoryReceipt;
  execute(actor: OwnerActor, command: EnqueueJobCommand): JobReceipt;
  execute(actor: OwnerActor, command: ResumeJobCommand): JobReceipt;
  execute(actor: OwnerActor, command: JobCommand): JobReceipt;
  execute(actor: OwnerActor, command: ScheduleCommand): ScheduleReceipt;
  execute(actor: OwnerActor, command: CreateProjectCommand): ProjectReceipt;
  execute(actor: OwnerActor, command: CreateTopicCommand): TopicReceipt;
  execute(actor: OwnerActor, command: SendMessageCommand): MessageReceipt;
  execute(actor: OwnerActor, command: TeamCommand): TeamReceipt;
  execute(actor: OwnerActor, command: DecisionCommand): DecisionReceipt;
  execute(actor: OwnerActor, command: TaskCommand): TaskReceipt;
  execute(actor: OwnerActor, command: CorrectMemoryCommand): CorrectionReceipt;
  execute(actor: OwnerActor, command: ForgetMemoryCommand): SuppressionReceipt;
  execute(actor: OwnerActor, command: CommitDeliveryCommand): DeliveryReceipt;
  execute(actor: OwnerActor, command: ResendDeliveryCommand): DeliveryResendReceipt;
  execute(actor: OwnerActor, command: RetireDeliveryCommand): DeliveryRetireReceipt;
  execute(actor: OwnerActor, command: PrReportCommand): PrReportReceipt;
  execute(actor: OwnerActor, command: BackupCommand): BackupReceipt;
  execute(actor: OwnerActor, command: DeleteCommand): DeletionReceipt | DeletionConfirmReceipt | DeletionOperation;
  execute(actor: OwnerActor, command: ExportCommand): ExportReceipt;
  execute(actor: OwnerActor, command: UpgradeCommand): UpgradeReceipt;
  execute(actor: OwnerActor, command: RestoreCommand): RestoreReceipt;
  execute(actor: OwnerActor, command: CreateProjectCommand | ConversationCommand | JobCommand | ScheduleCommand | TeamCommand | DecisionCommand | DeliveryCommand | PrReportCommand | TaskCommand | ExtractMemoryCommand | CorrectMemoryCommand | ForgetMemoryCommand | BackupCommand | DeleteCommand | ExportCommand | UpgradeCommand | RestoreCommand): ProjectReceipt | TopicReceipt | MessageReceipt | JobReceipt | ScheduleReceipt | TeamReceipt | DecisionReceipt | DeliveryReceipt | DeliveryResendReceipt | DeliveryRetireReceipt | PrReportReceipt | TaskReceipt | MemoryReceipt | CorrectionReceipt | SuppressionReceipt | BackupReceipt | DeletionReceipt | DeletionConfirmReceipt | DeletionOperation | ExportReceipt | UpgradeReceipt | RestoreReceipt;
  execute(actor: OwnerActor, command: CreateProjectCommand | ConversationCommand | JobCommand | ScheduleCommand | TeamCommand | DecisionCommand | DeliveryCommand | PrReportCommand | TaskCommand | ExtractMemoryCommand | CorrectMemoryCommand | ForgetMemoryCommand | BackupCommand | DeleteCommand | ExportCommand | UpgradeCommand | RestoreCommand): ProjectReceipt | TopicReceipt | MessageReceipt | JobReceipt | ScheduleReceipt | TeamReceipt | DecisionReceipt | DeliveryReceipt | DeliveryResendReceipt | DeliveryRetireReceipt | PrReportReceipt | TaskReceipt | MemoryReceipt | CorrectionReceipt | SuppressionReceipt | BackupReceipt | DeletionReceipt | DeletionConfirmReceipt | DeletionOperation | ExportReceipt | UpgradeReceipt | RestoreReceipt {
    if (command?.kind === "export.create") return this.#exportCommand(actor, command);
    if (command?.kind.startsWith("restore.")) return this.#restoreCommand(actor, command as RestoreCommand);
    if (command?.kind.startsWith("upgrade.")) return this.#upgradeCommand(actor, command as UpgradeCommand);
    if (command?.kind === "backup.create" || command?.kind === "backup.prune") return this.#backupCommand(actor, command);
    if (command?.kind === "memory.delete.preview" || command?.kind === "memory.delete.confirm" || command?.kind === "memory.delete.retry") return this.#deleteCommand(actor, command);
    if (command?.kind === "memory.extract") return this.#memoryCommand(actor, command);
    if (command?.kind === "memory.correct") return this.#correctCommand(actor, command);
    if (command?.kind === "memory.forget") return this.#forgetCommand(actor, command);
    if (command?.kind === "pr.report.dismiss") return this.#prReportCommand(actor, command as DismissReportCommand);
    if (command?.kind === "schedule.create" || command?.kind === "schedule.pause" || command?.kind === "schedule.resume" ||
      command?.kind === "schedule.edit" || command?.kind === "schedule.revoke") return this.#scheduleCommand(actor, command as ScheduleCommand);
    if (isTaskCommand(command)) return this.#taskCommand(actor, command);
    if (command?.kind === "delivery.commit" || command?.kind === "delivery.resend" || command?.kind === "delivery.retire") return this.#deliveryCommand(actor, command);
    if (command?.kind === "project.create") return this.#createProject(actor, command);
    if (command?.kind === "job.enqueue" || command?.kind === "job.resume" || command?.kind === "job.stop") return this.#jobCommand(actor, command);
    if (command?.kind === "role.save" || command?.kind === "route.save" || command?.kind === "role.preview" ||
        command?.kind === "team.dispatch" || command?.kind === "team.control") return this.#teamCommand(actor, command);
    if (command?.kind === "decision.synthesize" || command?.kind === "decision.accept" || command?.kind === "decision.supersede") return this.#decisionCommand(actor, command);
    const payloadHash = digest(conversationIdentity(command as ConversationCommand, this.config.messageBytes));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as TopicReceipt | MessageReceipt;
      }
      this.#project(tx, command.projectId!);
      const now = this.#now();
      const result = mutateConversation(tx, command as ConversationCommand, now);
      this.#beforeCommit?.(command.kind === "topic.create" ? "topic" : "message");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)",
        command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  /** app.memory_claims/v1: bounded, offline inspector; unavailable generations never return claim payloads. */
  memory(actor: OwnerActor, projectId: string, after = 0, sourceAfter = 0, extractionAfter = 0, query = "") {
    requireId(projectId); requireCursor(after); requireCursor(sourceAfter); requireCursor(extractionAfter);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, projectId), limit = this.config.pageSize;
      const rows = tx.all<{ cursor: number; sourceId: string; revision: number; generation: number }>(
        "SELECT rowid AS cursor, id AS sourceId, current_revision AS revision, generation FROM sources WHERE project_id = ? AND rowid > ? AND availability = 'available' AND kind != 'external' AND id NOT IN (SELECT source_id FROM memory_derived_sources WHERE project_id = ?) ORDER BY rowid LIMIT ?", projectId, sourceAfter, projectId, limit + 1);
      const extractionRows = tx.all<{ sequence: number; record_json: string }>("SELECT sequence, record_json FROM memory_extractions WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?", projectId, extractionAfter, limit + 1);
      return { project, ...readMemory(tx, projectId, after, limit, query), query,
        sources: rows.slice(0, limit).map(row => ({ cursor: row.cursor,
          source: lookupSource(tx, projectId, { sourceId: row.sourceId, revision: row.revision, generation: row.generation }),
          decision: memorySourceDecision(tx, projectId, { sourceId: row.sourceId, revision: row.revision, generation: row.generation }),
          suppressed: suppressedSource(tx, { sourceId: row.sourceId, revision: row.revision, generation: row.generation }) })),
        sourcesNextAfter: rows.length > limit ? rows[limit - 1]!.cursor : null,
        extractions: extractionRows.slice(0, limit).map(row => {
          const e = JSON.parse(row.record_json) as MemoryExtraction;
          const job = projectJob(readJob(tx, projectId, e.jobId), this.#now());
          // Raw captured source/claim text belongs to the private attempt, never this lifecycle-aware read model.
          return { id: e.id, jobId: e.jobId, source: lookupSource(tx, projectId, e.source), state: e.state === "queued" ? job.state : e.state, reason: e.state === "queued" ? job.reason : e.reason, claimIds: e.claimIds,
            rejected: e.rejected, mode: e.mode, extractor: e.extractor, policy: e.policy, route: e.request.route, configuration: e.request.configuration,
            job };
        }), extractionsNextAfter: extractionRows.length > limit ? extractionRows[limit - 1]!.sequence : null,
        team: readTeam(tx, projectId, this.config.team), topics: readTopics(tx, projectId, 0, limit).items,
        extractionAvailable: this.#jobs?.available(tx) ?? false };
    });
  }

  /** app.memory_active_generation/v1: resolves one exact claim and its bounded transitive lineage under owner/project scope. */
  memoryClaim(actor: OwnerActor, projectId: string, reference: ClaimReference) {
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return lookupActiveClaim(tx, projectId, reference); });
  }

  /** app.memory_correction/v1: the durable correction for one claim, or null when never corrected. */
  memoryCorrection(actor: OwnerActor, projectId: string, claimId: string) {
    requireId(projectId); requireId(claimId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return readCorrection(tx, projectId, claimId); });
  }

  /** app.memory_correction/v1: what one correction would fence or retire, shown before the owner confirms. */
  correctionImpact(actor: OwnerActor, projectId: string, reference: ClaimReference): CorrectionImpact {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return correctionImpact(tx, projectId, reference); });
  }

  /** app.memory_suppression/v1: the durable forget for one claim, or null when never forgotten. */
  memorySuppression(actor: OwnerActor, projectId: string, claimId: string) {
    requireId(projectId); requireId(claimId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return readSuppression(tx, projectId, claimId); });
  }

  /** app.memory_suppression/v1: what one forget would withdraw or retire, shown before the owner confirms. */
  suppressionImpact(actor: OwnerActor, projectId: string, reference: ClaimReference): SuppressionImpact {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return suppressionImpact(tx, projectId, reference); });
  }

  /** app.suppression_ledger/v1: the durable checkpoint with live retirement status, or null when never forgotten. */
  suppressionLedger(actor: OwnerActor, projectId: string, claimId: string): SuppressionLedger | null {
    requireId(projectId); requireId(claimId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return suppressionLedger(tx, projectId, claimId); });
  }

  /** app.data_lifecycle/v1: reads one revision-bound deletion preview, or null when unknown/expired. */
  deletionPreview(actor: OwnerActor, projectId: string, previewId: string): { project: Project; preview: DeletionPreview | null } {
    requireId(projectId); requireId(previewId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), preview: readDeletionPreview(tx, projectId, previewId) };
    });
  }

  /** app.data_lifecycle/v1: reads one deletion operation with its per-scope state. */
  deletionOperation(actor: OwnerActor, projectId: string, operationId: string): { project: Project; operation: DeletionOperation | null } {
    requireId(projectId); requireId(operationId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), operation: readDeletionOperation(tx, projectId, operationId) };
    });
  }

  /** app.data_lifecycle/v1: bounded per-scope deletion operations for one project. */
  deletionOperations(actor: OwnerActor, projectId: string): { project: Project; operations: DeletionOperation[] } {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), operations: listDeletionOperations(tx, projectId) };
    });
  }

  /** app.deletion_ledger/v1: identity-only tombstones (no payloads) for exporters, backup and restore. */
  deletionLedger(actor: OwnerActor): { tombstones: ReturnType<typeof readDeletionLedger> } {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { tombstones: readDeletionLedger(tx) };
    });
  }

  /** ops.project_export/v1: what an export would publish, without creating any artifact. */
  exportPreview(actor: OwnerActor, projectId: string, includeHistory: boolean): { project: Project; preview: ExportPreview } {
    requireId(projectId);
    if (typeof includeHistory !== "boolean") throw new AppError("invalid_export_command");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId);
      return { project, preview: exportPreview(tx, projectId, { includeHistory }, project.revision) };
    });
  }

  /** ops.project_export/v1: bounded durable export artifacts for one project. */
  exports(actor: OwnerActor, projectId: string): { project: Project; manifests: ExportManifest[] } {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), manifests: listExportArtifacts(tx, projectId) };
    });
  }

  /** ops.project_export/v1: reads one export manifest without parsing the artifact or activating workers. */
  export(actor: OwnerActor, projectId: string, id: string): { project: Project; manifest: ExportManifest } {
    requireId(projectId); requireId(id);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), manifest: readExportManifest(tx, projectId, id) };
    });
  }

  #exportCommand(actor: OwnerActor, command: ExportCommand): ExportReceipt {
    const payloadHash = digest(exportIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as ExportReceipt;
      }
      const now = this.#now();
      if (project.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      const manifest = createExport(tx, { id: crypto.randomUUID(), now, projectId: command.projectId,
        projectRevision: project.revision, scope: { includeHistory: command.payload.includeHistory },
        exportDir: this.#exportDir, note: command.payload.note });
      this.#beforeCommit?.("ops");
      const result: ExportReceipt = { manifest, duplicate: false };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  /** ops.schema_migrations/v1: reads one upgrade journal with sanitized evidence. */
  upgrade(actor: OwnerActor, id: string): { journal: UpgradeJournal } {
    requireId(id);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { journal: readUpgrade(tx, id) };
    });
  }

  /** ops.schema_migrations/v1: bounded upgrade journal for the installation. */
  upgrades(actor: OwnerActor): { journals: UpgradeJournal[] } {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { journals: listUpgrades(tx) };
    });
  }

  #upgradeCommand(actor: OwnerActor, command: UpgradeCommand): UpgradeReceipt {
    const payloadHash = digest(upgradeIdentity(command));
    if (command.kind === "upgrade.prepare") {
      const id = crypto.randomUUID();
      const persistFailure = (error: unknown): never => {
        // The prepare transaction rolled back; persist an explicit failed journal so the
        // rejection stays inspectable while the live installation is untouched.
        try {
          this.store.transaction(tx => {
            recordFailedUpgrade(tx, { id, now: this.#now(), targetSchema: command.payload.targetSchema,
              engine: this.#nativeSnapshot, reason: error instanceof AppError ? error.code : "interrupted_at_snapshot" });
          });
        } catch { /* The original rejection carries the actionable reason. */ }
        throw error;
      };
      try {
        return this.store.transaction(tx => {
          this.#requireOwner(tx, actor);
          const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
          if (prior) {
            if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
            return JSON.parse(prior.result_json) as UpgradeReceipt;
          }
          const now = this.#now();
          const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
          if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
          const journal = prepareUpgrade(tx, this.store, { id, now, appRevision: revision,
            targetSchema: command.payload.targetSchema, note: command.payload.note,
            upgradeDir: this.#upgradeDir, backupDir: this.#backupDir, engine: this.#nativeSnapshot });
          this.#beforeCommit?.("ops");
          const result: UpgradeReceipt = { journal, duplicate: false };
          tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
          tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
          this.#beforeCommit?.("receipt");
          return result;
        });
      } catch (error) {
        persistFailure(error);
        throw error;
      }
    }
    // Staged steps run outside a single outer transaction: each step is idempotent, and the
    // journal records intent before file work so a crash leaves a resumable non-terminal entry.
    const checked = this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return { receipt: JSON.parse(prior.result_json) as UpgradeReceipt, journal: null as UpgradeJournal | null };
      }
      const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
      if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      return { receipt: null as UpgradeReceipt | null, journal: readUpgrade(tx, command.payload.upgradeId) };
    });
    if (checked.receipt) return checked.receipt;
    const now = this.#now();
    let journal: UpgradeJournal;
    if (command.kind === "upgrade.migrate") {
      this.store.transaction(tx => {
        const current = readUpgrade(tx, command.payload.upgradeId);
        journal = migrateUpgrade(tx, this.store, current, now);
      });
      journal = this.upgrade(actor, command.payload.upgradeId).journal;
    } else if (command.kind === "upgrade.validate") {
      journal = validateUpgrade(this.store, checked.journal!, now);
    } else if (command.kind === "upgrade.activate") {
      journal = activateUpgrade(this.store, checked.journal!, now);
    } else {
      const current = checked.journal!;
      const backup = current.snapshotBackupId
        ? this.store.read(tx => {
          const row = tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", current.snapshotBackupId!);
          if (!row) throw new AppError("backup_not_found", 404);
          return (JSON.parse(row.record_json) as BackupManifest).artifact.path;
        })
        : null;
      if (!backup) throw new AppError("upgrade_bad_state", 409);
      journal = rollbackUpgrade(this.store, current, backup, now);
    }
    this.#beforeCommit?.("ops");
    const result: UpgradeReceipt = { journal: journal!, duplicate: false };
    this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
    });
    this.#beforeCommit?.("receipt");
    this.#jobs?.cancelFenced();
    return result;
  }

  /** ops.quarantined_restore/v1: reads one quarantine with its validation report. */
  restore(actor: OwnerActor, id: string): { quarantine: RestoreQuarantine } {
    requireId(id);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { quarantine: restoreEvidence(readQuarantine(tx, id)) };
    });
  }

  /** ops.quarantined_restore/v1: bounded quarantine list for the installation. */
  restores(actor: OwnerActor): { quarantines: RestoreQuarantine[] } {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { quarantines: listQuarantines(tx).map(restoreEvidence) };
    });
  }

  #restoreCommand(actor: OwnerActor, command: RestoreCommand): RestoreReceipt {
    const payloadHash = digest(restoreIdentity(command));
    if (command.kind === "restore.prepare") {
      const id = crypto.randomUUID();
      try {
        return this.store.transaction(tx => {
          this.#requireOwner(tx, actor);
          const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
          if (prior) {
            if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
            return JSON.parse(prior.result_json) as RestoreReceipt;
          }
          const now = this.#now();
          const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
          if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
          const quarantine = prepareRestore(tx, { id, now, liveRevision: revision, backupId: command.payload.backupId, restoreDir: this.#restoreDir });
          this.#beforeCommit?.("ops");
          const result: RestoreReceipt = { quarantine, duplicate: false };
          tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
          tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
          this.#beforeCommit?.("receipt");
          return result;
        });
      } catch (error) {
        // Prepare rolls back wholly; quarantine files are orphaned and re-prepare is clean.
        throw error;
      }
    }
    // Later steps run outside a single outer transaction: each step is idempotent, and
    // quarantine files plus journal rows make a crash resumable at the same boundary.
    const checked = this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return { receipt: JSON.parse(prior.result_json) as RestoreReceipt, quarantine: null as RestoreQuarantine | null };
      }
      const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
      if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      return { receipt: null as RestoreReceipt | null, quarantine: readQuarantine(tx, command.payload.quarantineId) };
    });
    if (checked.receipt) return checked.receipt;
    const now = this.#now();
    let quarantine: RestoreQuarantine;
    if (command.kind === "restore.migrate") {
      this.store.transaction(tx => {
        quarantine = migrateQuarantine(tx, readQuarantine(tx, command.payload.quarantineId), now);
      });
      quarantine = this.restore(actor, command.payload.quarantineId).quarantine;
    } else if (command.kind === "restore.apply_ledger") {
      const payload = command.payload as { quarantineId: string; tombstones: ExternalTombstone[]; source: string; asOf: number; acknowledgedEmpty?: boolean };
      this.store.transaction(tx => {
        quarantine = applyLedger(tx, readQuarantine(tx, command.payload.quarantineId),
          { tombstones: payload.tombstones, source: payload.source, asOf: payload.asOf,
            acknowledgedEmpty: payload.acknowledgedEmpty ?? false, now, liveNow: now });
      });
      quarantine = this.restore(actor, command.payload.quarantineId).quarantine;
    } else if (command.kind === "restore.validate") {
      const current = checked.quarantine!;
      const backupCreatedAt = this.store.read(tx => {
        const row = tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", current.backupId);
        if (!row) throw new AppError("backup_not_found", 404);
        return (JSON.parse(row.record_json) as { createdAt: number }).createdAt;
      });
      quarantine = validateQuarantine(this.store, current, now, backupCreatedAt);
    } else if (command.kind === "restore.activate") {
      const revision = this.store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision);
      quarantine = activateRestore(this.store, checked.quarantine!, now, revision);
    } else {
      this.store.transaction(tx => {
        quarantine = discardRestore(tx, readQuarantine(tx, command.payload.quarantineId), now);
      });
      quarantine = this.restore(actor, command.payload.quarantineId).quarantine;
    }
    this.#beforeCommit?.("ops");
    const result: RestoreReceipt = { quarantine: quarantine!, duplicate: false };
    this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
    });
    this.#beforeCommit?.("receipt");
    this.#jobs?.cancelFenced();
    return result;
  }

  #deleteCommand(actor: OwnerActor, command: DeleteCommand): DeletionReceipt | DeletionConfirmReceipt | DeletionOperation {
    const payloadHash = digest(deleteCommandIdentity(command, this.config.team.contextBytes));
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as DeletionReceipt | DeletionConfirmReceipt | DeletionOperation;
      }
      const now = this.#now();
      const result = command.kind === "memory.delete.preview"
        ? { preview: prepareDeletionPreview(tx, command, project.revision, now), duplicate: false } satisfies DeletionReceipt
        : command.kind === "memory.delete.confirm"
          ? confirmDeletion(tx, command, project.revision, now)
          : retryDeletion(tx, command, now);
      this.#beforeCommit?.("memory");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  #forgetCommand(actor: OwnerActor, command: ForgetMemoryCommand): SuppressionReceipt {
    const payloadHash = digest(forgetIdentity(command, this.config.team.contextBytes));
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as SuppressionReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = prepareSuppression(tx, command, this.config.team.contextBytes, generation, project.revision, now);
      this.#beforeCommit?.("memory");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  #correctCommand(actor: OwnerActor, command: CorrectMemoryCommand): CorrectionReceipt {
    const payloadHash = digest(correctionIdentity(command, this.config.team.contextBytes));
    const committed = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return { receipt: JSON.parse(prior.result_json) as CorrectionReceipt, fenced: false }; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = prepareCorrection(tx, command, this.config.team.contextBytes, generation, project.revision, now);
      this.#beforeCommit?.("memory");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return { receipt: result, fenced: true };
    });
    // Abort adapters of already-running fenced attempts after commit; durable authority
    // alone already prevents their late results from publishing stale memory.
    if (committed.fenced) this.#jobs?.cancelFenced();
    return committed.receipt;
  }

  #memoryCommand(actor: OwnerActor, command: ExtractMemoryCommand): MemoryReceipt {
    const payloadHash = digest(memoryIdentity(command, this.config));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as MemoryReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = prepareExtraction(tx, command, this.config, this.#jobs, generation, now);
      this.#beforeCommit?.("memory");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return result;
    });
  }

  #scheduleCommand(actor: OwnerActor, command: ScheduleCommand): ScheduleReceipt {
    const payloadHash = digest(scheduleIdentity(command, this.config.jobs.inputBytes));
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      if (!this.#jobs) throw new AppError("scheduler_unavailable", 503);
      this.#jobs.assertOwner(tx);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as ScheduleReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = executeScheduleCommand(tx, command, this.config, this.#jobs, generation, now);
      this.#beforeCommit?.("schedule");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /**
   * Lists one project's configured schedules with next run and last result.
   * Reading never admits work, ticks occurrences or sends anything.
   */
  schedules(actor: OwnerActor, projectId: string): { project: Project; items: JobSchedule[] } {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), items: listSchedules(tx, projectId) };
    });
  }

  /**
   * Reads one schedule with its latest occurrences and the linked jobs' states.
   * This projects committed state; occurrence jobs keep their own lifecycle.
   */
  schedule(actor: OwnerActor, projectId: string, scheduleId: string): {
    project: Project; schedule: JobSchedule; occurrences: (ScheduleOccurrence & { jobState: string })[];
  } {
    requireId(projectId); requireId(scheduleId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId), schedule = readSchedule(tx, projectId, scheduleId);
      const now = this.#now();
      const occurrences = listOccurrences(tx, scheduleId, 20).map(occurrence => {
        let jobState = "missing";
        try { jobState = projectJob(readJob(tx, projectId, occurrence.jobId), now).state; } catch { /* A missing job row stays inspectable. */ }
        return { ...occurrence, jobState };
      });
      return { project, schedule, occurrences };
    });
  }

  /** Reads bounded role settings and honest effective-route status without requiring an execution adapter. */
  team(actor: OwnerActor, projectId: string | null = null) {
    if (projectId !== null) requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); const project = projectId ? this.#project(tx, projectId) : null;
      return { ...readTeam(tx, projectId, this.config.team), project, topics: projectId ? readTopics(tx, projectId, 0, this.config.pageSize).items : [],
        previewAvailable: this.#jobs?.available(tx) ?? false }; });
  }

  /** Projects the retained run, immutable inputs, committed attribution and independent job state after reload. */
  preview(actor: OwnerActor, projectId: string, runId: string) {
    requireId(projectId); requireId(runId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); const project = this.#project(tx, projectId), run = readPreview(tx, projectId, runId);
      return { project, run, job: projectJob(readJob(tx, projectId, run.jobId), this.#now()) }; });
  }

  /** Lists bounded discussions for one topic without admitting or reconnecting analysis work. */
  discussions(actor: OwnerActor, projectId: string, topicId: string) {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return listDiscussions(tx, projectId, topicId, this.config.pageSize).map(item => projectDiscussion(tx, item));
    });
  }

  /** Projects one discussion's participations, provisional progress and coverage gap from persisted state only. */
  discussion(actor: OwnerActor, projectId: string, discussionId: string) {
    requireId(projectId); requireId(discussionId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, projectId);
      const discussion = projectDiscussion(tx, readDiscussion(tx, projectId, discussionId));
      const decision = readDecisionModel(tx, projectId, discussion.topicId, discussion.id);
      return { project, discussion, decision, context: readOwnedMemoryContext(tx, projectId, "discussion", discussion.id),
        synthesisContext: decision.synthesis ? readOwnedMemoryContext(tx, projectId, "synthesis", decision.synthesis.id) : null };
    });
  }

  /** app.context_provenance/v1: what one run was allowed to use, with current lifecycle status per entry. */
  memoryContext(actor: OwnerActor, projectId: string, contextId: string): { project: Project } & MemoryContextView {
    requireId(projectId); requireId(contextId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), ...readMemoryContext(tx, projectId, contextId) };
    });
  }

  /**
   * app.decision_read_model/v1
   * Reads the topic proposal, evidence and owner decision history without admitting work or accepting a decision.
   */
  decision(actor: OwnerActor, projectId: string, topicId: string): { project: Project; topic: ReturnType<Application["conversation"]>["topic"] } & DecisionReadModel {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId), topic = readTopic(tx, projectId, topicId);
      return { project, topic, ...readDecisionModel(tx, projectId, topicId) };
    });
  }

  /**
   * app.task_read_model/v1
   * Lists proposals, accepted obligations, and closed tasks separately. This read does not accept or start work.
   */
  tasks(actor: OwnerActor, projectId: string): { project: Project; topics: ReturnType<typeof readTopics>["items"] } & TaskList {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      return { project: this.#project(tx, projectId), ...readTaskList(tx, projectId, this.config.pageSize), topics: readTopics(tx, projectId, 0, this.config.pageSize).items };
    });
  }

  /**
   * app.task_read_model/v1
   * Reads one task, its proposal history, and whether the cited source is still available.
   */
  task(actor: OwnerActor, projectId: string, taskId: string): { project: Project; topic: ReturnType<Application["conversation"]>["topic"] } & TaskReadModel {
    requireId(projectId); requireId(taskId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      const model = readTaskModel(tx, projectId, taskId);
      return { project: this.#project(tx, projectId), topic: readTopic(tx, projectId, model.task.topicId), ...model };
    });
  }

  /**
   * app.project_continuity/v1
   * Reads committed obligations and owner decisions without provider inference or live model calls.
   */
  continuity(actor: OwnerActor, projectId: string): { project: Project } & ProjectContinuity {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      return { project: this.#project(tx, projectId), ...readProjectContinuity(tx, projectId, this.config.pageSize, this.#now()) };
    });
  }

  /** app.task_completion/v1 — exposes the effective completion policy before owner close commands. */
  taskCompletionPolicy(actor: OwnerActor, projectId: string, taskId: string): { project: Project; policy: ReturnType<typeof readTaskCompletionPolicy> } {
    requireId(projectId); requireId(taskId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      return { project: this.#project(tx, projectId), policy: readTaskCompletionPolicy(tx, projectId, taskId) };
    });
  }

  /** app.task_commands/v1 — commits proposal, edit, dismissal, acceptance, or cancellation. Start is refused and writes nothing. */
  #taskCommand(actor: OwnerActor, command: TaskCommand): TaskReceipt {
    const payloadHash = taskIdentity(command, this.config.messageBytes);
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as TaskReceipt; }
      const now = this.#now();
      const result = applyTask(tx, command, actor.channel, now, this.config.messageBytes);
      fenceStaleContexts(tx, now);
      this.#beforeCommit?.("task");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /** app.decision_commands/v1 — commits synthesis admission, acceptance or supersession with the shared owner receipt. */
  #decisionCommand(actor: OwnerActor, command: DecisionCommand): DecisionReceipt {
    const payloadHash = decisionIdentity(command, this.config.team.contextBytes);
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as DecisionReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = command.kind === "decision.synthesize" ? prepareSynthesis(tx, command, this.config, this.#jobs, generation, now)
        : command.kind === "decision.accept" ? acceptDecision(tx, command, "web", now)
        : supersedeDecision(tx, command, "web", now);
      if (result.decision) commitDecisionMemorySource(tx, result.decision);
      if (command.kind === "decision.supersede") {
        retireDecisionMemorySource(tx, command.projectId, command.payload.decisionId);
        fenceUnavailableExtractions(tx, command.projectId, now);
        fenceStaleContexts(tx, now);
      }
      this.#beforeCommit?.("decision");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  #teamCommand(actor: OwnerActor, command: TeamCommand): TeamReceipt {
    const payloadHash = teamIdentity(command, this.config.team);
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor, command.kind === "team.dispatch" ? ["web", "telegram"] : ["web"]);
      if (command.projectId) this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as TeamReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = command.kind === "role.preview" ? preparePreview(tx, command, this.config, this.#jobs, generation, now)
        : command.kind === "team.dispatch" ? prepareDispatch(tx, command, this.config, this.#jobs, generation, now)
        : command.kind === "team.control" ? prepareControl(tx, command, this.config, this.#jobs, generation, now)
        : mutateTeamConfiguration(tx, command, this.config.team, now);
      this.#beforeCommit?.("team");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId ?? "owner", now);
      this.#beforeCommit?.("receipt"); return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /**
   * Lists private delivery intents for one project. The read does not claim, send, or mark a report delivered.
   * `delivery.outbox/v1` inspection.
   */
  deliveries(actor: OwnerActor, projectId: string, after = 0): { project: Project } & DeliveryPage {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), ...listDeliveryIntents(tx, projectId, after, this.config.pageSize) };
    });
  }

  /**
   * Shows one intent's provenance, status, safe failure reason, attempts and whether the source can still be read.
   * `delivery.outbox/v1` inspection. This does not send.
   */
  delivery(actor: OwnerActor, projectId: string, intentId: string): {
    project: Project; intent: DeliveryIntent; report: DeliveryReport; attempts: ReturnType<typeof listDeliveryAttempts>; sourceAvailable: boolean;
  } {
    requireId(projectId); requireId(intentId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId);
      const intent = readDeliveryIntent(tx, projectId, intentId);
      const report = readDeliveryReport(tx, projectId, intent.provenance.reportId);
      const source = tx.get<{ availability: string }>("SELECT availability FROM sources WHERE id = ? AND project_id = ?", report.sourceId, projectId);
      return { project, intent, report, attempts: listDeliveryAttempts(tx, intent.id), sourceAvailable: source?.availability === "available" };
    });
  }

  /**
   * Lists private PR review reports for one project.
   * `pr.private_report/v1` inspection; reading never admits work or sends.
   */
  prReports(actor: OwnerActor, projectId: string, monitorId?: string) {
    requireId(projectId);
    if (monitorId !== undefined) requireId(monitorId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId);
      return { project, items: listReports(tx, projectId, monitorId) };
    });
  }

  /**
   * Shows one private report with annotations, alert evaluation and linked delivery.
   * `pr.private_report/v1` + `pr.private_alerts/v1` inspection; unknown delivery never reads as delivered.
   */
  prReport(actor: OwnerActor, projectId: string, reportId: string) {
    requireId(projectId); requireId(reportId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId);
      const report = readReport(tx, projectId, reportId);
      const annotations = readAnnotations(tx, reportId);
      const evaluation = evaluateReport(report);
      const alerts = tx.all<{ record_json: string }>(
        "SELECT record_json FROM delivery_intents WHERE project_id = ? AND dedupe_key LIKE ? ORDER BY sequence",
        projectId, `pr-alert/${reportId}/%`,
      ).map(row => JSON.parse(row.record_json) as DeliveryIntent);
      return { project, report, annotations, evaluation, alerts };
    });
  }

  /**
   * Admits at most one logical private alert per qualifying finding after rechecking
   * current base/head/policy, report validity and enabled monitoring.
   * `pr.private_alerts/v1` admission; replay dedupes to the existing intent.
   */
  admitPrAlerts(actor: OwnerActor, projectId: string, reportId: string) {
    requireId(projectId); requireId(reportId);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      this.#project(tx, projectId);
      return admitReportAlerts(tx, { projectId, reportId, maxBytes: this.config.messageBytes }, this.#now());
    });
  }

  /** Commits a revisioned dismissal/feedback annotation without rewriting finding history. */
  #prReportCommand(actor: OwnerActor, command: DismissReportCommand): PrReportReceipt {
    const payloadHash = digest(prReportIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as PrReportReceipt;
      }
      const now = this.#now();
      const result = annotateReport(tx, command, now, "dismiss");
      this.#beforeCommit?.("delivery");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  /** Returns a bounded committed queue projection without starting work or requiring a provider. */
  jobs(actor: OwnerActor, projectId: string, after = 0) {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, projectId);
      const available = this.#jobs?.available(tx) ?? false;
      const page = readJobs(tx, projectId, after, this.config.pageSize), now = this.#now();
      return { project, ...page, items: page.items.map(job => projectJob(job, now)),
        choices: (this.#jobs?.choices() ?? []).filter(choice => ![reminderWorkId, summaryWorkId, "role.scripted-preview", "team.discussion", "team.specialist-analysis", coordinatorSynthesisWorkId].includes(choice.id)),
        admission: { available, nextAction: available ? "inspect_or_authorize_work" : "resolve_scheduler_ownership_or_restart" } };
    });
  }

  /** Reads committed evidence and current wall time left without changing job state or receipts. */
  job(actor: OwnerActor, projectId: string, jobId: string) {
    requireId(projectId); requireId(jobId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId);
      const authority = tx.get<{ stop_json: string | null }>("SELECT stop_json FROM job_authority WHERE job_id = ?", jobId);
      const attempts = readAttempts(tx, jobId), contexts = new Set(attempts.flatMap(a => a.native ? [`${a.native.context.id}:${a.native.context.generation}`] : []));
      for (const context of tx.all<{ id: string; generation: number }>("SELECT c.id, c.generation FROM team_contexts c JOIN team_runs r ON r.context_id = c.id WHERE r.project_id = ? AND r.job_id = ?", projectId, jobId)) contexts.add(`${context.id}:${context.generation}`);
      const reconciliations = tx.all<{ record_json: string }>("SELECT record_json FROM job_reconciliation").map(row => JSON.parse(row.record_json) as SessionReconciliation)
        .filter(record => contexts.has(`${record.context.id}:${record.context.generation}`));
      return { ...projectJob(readJob(tx, projectId, jobId), this.#now()), attempts, reconciliations,
        stop: authority?.stop_json ? JSON.parse(authority.stop_json) as JobStopOutcome : null }; });
  }

  #deliveryCommand(actor: OwnerActor, command: DeliveryCommand): DeliveryReceipt | DeliveryResendReceipt | DeliveryRetireReceipt {
    const payloadHash = deliveryCommandIdentity(command, this.config.messageBytes);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor, command.kind === "delivery.commit" ? ["web", "telegram"] : ["web"]);
      this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as DeliveryReceipt | DeliveryResendReceipt | DeliveryRetireReceipt;
      }
      const now = this.#now();
      const result = command.kind === "delivery.commit"
        ? commitDeliveryIntent(tx, { projectId: command.projectId, kind: command.payload.kind, text: command.payload.text, dedupeKey: command.payload.dedupeKey, maxBytes: this.config.messageBytes, expectedProjectRevision: command.expectedRevision }, now)
        : command.kind === "delivery.resend"
          ? resendDeliveryIntent(tx, command.projectId, command.payload.intentId, command.expectedRevision, now)
          : retireDeliveryReport(tx, command.projectId, command.payload.reportId, command.payload.action, command.expectedRevision, now);
      this.#beforeCommit?.("delivery");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  #jobCommand(actor: OwnerActor, command: JobCommand): JobReceipt {
    const payloadHash = jobCommandIdentity(command, this.config.jobs.inputBytes);
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      if (!this.#jobs) throw new AppError("scheduler_unavailable", 503);
      this.#jobs.assertOwner(tx);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as JobReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const result = this.#jobs.execute(tx, command, generation, now);
      this.#beforeCommit?.("job");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /** ops.backup_manifest/v1 reads: bounded inventory outside ordinary project data. */
  backups(actor: OwnerActor): { manifests: BackupManifest[] } {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { manifests: listBackups(tx) };
    });
  }

  /** Reads one backup manifest without parsing backup bytes or activating workers. */
  backup(actor: OwnerActor, id: string): { manifest: BackupManifest } {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { manifest: readBackupManifest(tx, id) };
    });
  }

  #backupCommand(actor: OwnerActor, command: BackupCommand): BackupReceipt {
    const payloadHash = digest(backupIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as BackupReceipt;
      }
      const now = this.#now();
      const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
      if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (command.kind === "backup.prune") {
        const pruned = enforceRetention(tx, this.#backupDir, 0, command.payload.keep);
        this.#beforeCommit?.("backup");
        const result: BackupReceipt = {
          manifest: {
            contract: "ops.backup_manifest/v1", id: "prune", createdAt: now, appSchema: tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version, jitVersion: "jit-mvp-fixture",
            appRevision: revision, projects: [], sourceGenerations: [],
            lifecycle: { available: true, checkpoint: null, reason: null },
            native: { state: "valid", refs: [], bytes: 0, engine: null, reason: null },
            content: { bytes: 0, hash: "", projects: 0, sources: 0 },
            retention: { maxBackups: 10, maxBytes: 64 * 1024 * 1024, pruned },
            state: "valid", reason: null, artifact: { path: "", bytes: 0, hash: "" },
          },
          duplicate: false,
        };
        tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
        tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
        this.#beforeCommit?.("receipt");
        return result;
      }
      const id = crypto.randomUUID();
      const snapshot = this.store.snapshotBytes();
      const hash = createHash("sha256").update(snapshot).digest("hex");
      const native = resolveNativeSnapshot(this.#nativeSnapshot);
      const pruned = enforceRetention(tx, this.#backupDir, snapshot.length);
      const artifactPath = writeArtifact(this.#backupDir, id, snapshot);
      this.#beforeCommit?.("backup");
      const appSchema = tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
      const manifest = prepareBackupManifest(tx, { id, now, appRevision: revision, appSchema, snapshotBytes: snapshot, snapshotHash: hash, native, artifactPath, pruned });
      tx.run("INSERT INTO ops_backups VALUES (?, ?, ?)", manifest.id, manifest.createdAt, JSON.stringify(manifest));
      const result: BackupReceipt = { manifest, duplicate: false };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  #createProject(actor: OwnerActor, command: CreateProjectCommand): ProjectReceipt {
    if (!command || command.kind !== "project.create" || command.projectId !== null ||
        typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
        !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
        typeof command.payload?.name !== "string" || command.payload.name.trim().length < 1 ||
        command.payload.name.length > 200) throw new AppError("invalid_project_command");
    const payloadHash = digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.name]));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as ProjectReceipt;
      }
      const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
      if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      const project: Project = { id: crypto.randomUUID(), name: command.payload.name.trim(), revision: 1,
        groupId: crypto.randomUUID(), createdAt: this.#now() };
      tx.run("INSERT INTO projects VALUES (?, ?, ?, ?)", project.id, project.name, project.revision, project.createdAt);
      tx.run("INSERT INTO project_groups VALUES (?, ?)", project.groupId, project.id);
      this.#beforeCommit?.("project");
      tx.run("UPDATE app_state SET revision = revision + 1 WHERE id = 1");
      const result: ProjectReceipt = { project, workspaceRevision: revision + 1 };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), this.#now());
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)",
        command.kind, command.requestId, project.id, this.#now());
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  #session(tx: AppTransaction, key: string): void {
    const row = tx.get<{ token_hash: string }>(`SELECT s.token_hash FROM sessions s JOIN owner o ON o.id = s.owner_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.generation = o.generation`, key, this.#now());
    if (!row) throw new AppError("authentication_required", 401);
  }

  #project(tx: AppTransaction, projectId: string): Project {
    const project = tx.get<Project>(`SELECT p.id, p.name, p.revision, g.id AS groupId, p.created_at AS createdAt
      FROM projects p JOIN project_groups g ON g.project_id = p.id WHERE p.id = ?`, projectId);
    if (!project) throw new AppError("project_not_found", 404);
    return project;
  }

  #requireOwner(tx: AppTransaction, actor: OwnerActor, channels: readonly TaskChannel[] = ["web"]): string {
    const key = actor && this.#actors.get(actor);
    if (!key) throw new AppError("authentication_required", 401);
    this.#session(tx, key);
    if (!channels.includes(actor.channel)) throw new AppError("channel_not_authorized", 403);
    return key;
  }
}

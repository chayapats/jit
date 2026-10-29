import { AttachmentSanitizer } from "./attachments/sanitizer";
import type { AttachmentSanitizerRuntime } from "./attachments/sanitizer-runtime";
import { AttachmentStorage, type AttachmentStorageOptions, type AttachmentUpload } from "./attachments/storage";
import { readAttachment, readAttachmentEvents, writeAttachmentEvent, type AttachmentView, type AttachmentEventView } from "./attachments/records";
import { bindAttachments, discardStagedAttachment, readMessageAttachments } from "./attachments/binding";
import { openServedBlob, previewable, servedFileName, type ServedAttachment } from "./attachments/serving";
import { liveProjectSql, requireLiveProject } from "./project-lifecycle";
import { previewBoxData, wipeBoxData } from "./exec/box-data";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync } from "node:fs";
import { AppError } from "./errors";
import { requireOwnerSetup, removeOwnerSetupLink } from "./ops/owner-setup";
import type { AppConfig } from "./config";
import { TransactionStore, type AppTransaction } from "./store";
import { preferencesIdentity, readPreferences, writePreferences, type PreferencesReceipt, type SetPreferencesCommand, type UiPreferences } from "./preferences";
import { localApiIdentity, readLocalApi, writeLocalApi, type LocalApiReceipt, type LocalApiSettings, type SetLocalApiCommand } from "./local-api/settings";
import { personaIdentity, readPersona, writePersona, type Persona, type PersonaReceipt, type SetPersonaCommand } from "./persona";
import { applySetup, isSetupCommand, readGeneralSpace, readSetup, setupCheckWorkId, setupComplete, setupIdentity, type GeneralSpace, type SetupCommand, type SetupReceipt, type SetupView } from "./setup";
import { jitReplyWorkId, admitJitReply, readRepliesFor, readReply, readReplyChanges, stopReply, stopReplyIdentity, type JitReplyView, type ReplyReceipt, type StopReplyCommand } from "./team/jit-reply";
import { conversationIdentity, mutateConversation, readMessages, readTopic, readTopics, requireCursor,
  type ChatReceipt, type ConversationCommand, type CreateTopicCommand, type SendMessageCommand, type StartChatCommand, type Topic, type TopicReceipt, type MessageReceipt } from "./conversation";
import { executePromotion, isPromotionCommand, promotionIdentity, readTopicPromotion, requireTopicOpen, type PromotionCommand, type PromotionReceipt, type TopicPromotionView } from "./promotion";
import { lookupSource, requireId, requireReference, type SourceReference, type SourceLookup } from "./sources";
import { readTelegramStatus } from "./telegram/channel";
import type { TelegramStatus } from "./telegram/types";
import type { SessionReconciliation } from "./jobs/reconcile";
import type { Job, JobStopOutcome } from "./jobs/types";
import { readAttempts } from "./jobs/attempts";
import { JobQueue, fenceNarrowedExecution, jobCommandIdentity, projectJob, readJob, readJobs, stopExecutionJobs } from "./jobs/queue";
import { readToolCalls, type ToolCallView } from "./exec/run-tools";
import {
  approvalCommandIdentity, decideCard, expireCards, isApprovalCommand, readAutoApproveRules, readCard, readCards, readEffectTargets, requireApprovalConfigChannel,
  writeAutoApproveRule, writeEffectTarget, type ApprovalCard, type ApprovalCommand, type AutoApproveRule, type CardState, type DecideCardCommand,
  type DeployTarget, type GitRemote, type RemoveEffectTargetCommand, type SetAutoApproveCommand, type SetEffectTargetCommand,
} from "./exec/approval-cards";
import type { EffectExecutor } from "./exec/effect-executor";
import { applyMcpCommand, isMcpCommand, mcpCommandIdentity, readMcpProposals, readMcpServers, type McpCommand, type McpProposalView, type McpReceipt, type McpServerView } from "./exec/mcp";
import type { McpGateway } from "./exec/mcp-gateway";
import type { BrowserService } from "./exec/browser";
import { computerCommandIdentity, isComputerCommand, readComputerSettings, writeComputerSettings, type ComputerSettings, type ComputerSettingsReceipt, type SetComputerSettingsCommand } from "./exec/computer";
import {
  applyTakeoverCommand, isTakeoverCommand, isTakeoverInputCommand, readTakeover, requireTakeoverChannel, takeoverCommandIdentity, takeoverInput,
  type ScreenshotMeta, type TakeoverCommand, type TakeoverInputCommand, type TakeoverInputReceipt, type TakeoverReceipt, type TakeoverView,
} from "./exec/takeover";
import {
  accessCommandIdentity, isAccessCommand, readProjectAccess, readRoleAccess, writeAccessLevel, writeHalt, writeResume, writeRoleRestriction,
  type AccessCommand, type AccessReceipt, type HaltExecutionCommand, type HaltOutcome, type ProjectAccess, type RoleAccess,
} from "./exec/access";
import { boxCommandIdentity, executionAttemptAdmitted, isBoxCommand, readBoxResets, writeBoxReset, type BoxResetReceipt, type BoxView, type ResetBoxCommand } from "./exec/box-commands";
import type { BoxManager } from "./exec/box-manager";
import {
  applyConnectionCommand, connectionCommandIdentity, isConnectionCommand, readConnections, requireConnectionChannel,
  type ConnectionCommand, type ConnectionReceipt, type ConnectionVault, type ConnectionView,
} from "./exec/connections";
import type { EnqueueJobCommand, ResumeJobCommand, JobCommand, JobReceipt } from "./jobs/types";
import { mutateTeamConfiguration, readTeam, teamIdentity } from "./team/configuration";
import { executeRoleProposal, roleProposalIdentity, type RoleProposalCommand, type RoleProposalReceipt } from "./team/role-proposals";
import { listDiscussions, prepareControl, prepareDispatch, prepareStopAll, projectDiscussion, readDiscussion } from "./team/dispatch";
import { feedIdentity, feedPath, feedTokenMatches, isFeedCommand, mintFeedToken, readFeedEvents, readScheduleFeed, writeScheduleFeed,
  type FeedCommand, type FeedEvent, type FeedReceipt, type ScheduleFeed } from "./schedule-feed";
import { allowanceIdentity, readDispatchAllowance, writeDispatchAllowance, type DispatchAllowance, type DispatchAllowanceReceipt, type SetDispatchAllowanceCommand } from "./team/allowance";
import { dispatchIdentity, executeDispatchCommand, readDispatchCard, readDispatchCards, type DispatchCardView, type DispatchCommand, type DispatchReceipt } from "./team/jit-dispatch";
import { acceptDecision, decisionIdentity, prepareSynthesis, readDecisionModel, supersedeDecision } from "./team/decisions";
import { preparePreview, readPreview } from "./team/preview";
import type { DecisionCommand, DecisionReadModel, DecisionReceipt, TeamCommand, TeamReceipt } from "./team/types";
import { coordinatorSynthesisWorkId } from "./team/types";
import {
  attentionIdentity, commitDeliveryIntent, deliveryCommandIdentity, listDeliveryAttempts, listDeliveryIntents, readAttentionLevels, readDeliveryIntent,
  readDeliveryReport, resendDeliveryIntent, retireDeliveryReport, writeAttentionLevel, type AttentionLevels, type AttentionReceipt, type SetAttentionCommand,
} from "./delivery";
import { evaluateTopicWorkGroups, evaluateWorkGroup, workGroupOfJob } from "./team/work-group";
import { annotateReport, listReports, listReviewStates, prReportIdentity, readAnnotations, readReport, reportRunEvidence } from "./pr/report";
import { admitReportAlerts, alertPolicyIdentity, evaluateReport, readAlertDecisions, readAlertPolicy, setAlertPolicy } from "./pr/alerts";
import { readAlertLinks } from "./pr/alert-links";
import { readMonitors } from "./pr/authority";
import { acceptWebhookDelivery, applyWebhookCommand, isWebhookCommand, monitorPollDue, readWebhookTrigger, webhookIdentity, webhookKeyDirectory, webhookRouteActive,
  type WebhookCommand, type WebhookDelivery, type WebhookReceipt, type WebhookTriggerView } from "./pr/webhooks";
import type {
  AlertPolicyReceipt,
  DismissReportCommand,
  PrReportCommand,
  PrReportReceipt,
  SetAlertPolicyCommand,
} from "./pr/types";
import type {
  CommitDeliveryCommand, DeliveryCommand, DeliveryIntent, DeliveryPage, DeliveryReceipt, DeliveryReport,
  DeliveryResendReceipt, DeliveryRetireReceipt, ResendDeliveryCommand, RetireDeliveryCommand,
} from "./delivery";
import {
  applyTask, countOwnerTaskQueue, isTaskCommand, readProjectContinuity, readTaskCompletionPolicy, readTaskList, readTaskModel, readTopicTasks, taskIdentity,
  type ProjectContinuity, type TaskChannel, type TaskCommand, type TaskList, type TaskReadModel, type TaskReceipt,
} from "./tasks";

import { fenceUnavailableExtractions, memoryIdentity, prepareExtraction } from "./memory/extract";
import { correctionIdentity, correctionImpact, prepareCorrection, readCorrection } from "./memory/correct";
import {
  confirmDeletion, finalizeProjectDatabasePurge, deleteCommandIdentity, lifecycleSafeManifests, listDeletionOperations, prepareDeletionPreview, purgeDeletedExports, readDeletionLedger,
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

/** Changes display data under the project revision without changing project or group identity. */
export interface RenameProjectCommand {
  kind: "project.rename"; requestId: string; projectId: string; expectedRevision: number;
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

/** app.local_api/v1: actor keys of the loopback listener; session keys are hex digests, so they never collide. */
const localApiKeyPrefix = "local-api:";

/** app.local_api/v1 pending owner actions: identities, revisions and reason codes only, never model text. */
export interface PendingActions {
  proposals: { kind: "dispatch"; id: string; projectId: string; topicId: string; revision: number; reason: string | null;
    roles: { roleId: string; roleName: string }[]; replyMessageId: string }[];
  jobs: { id: string; projectId: string; state: string; reason: string | null }[];
  more: { proposals: boolean; jobs: boolean };
}

/** Items in one project that wait on the owner (web.settings_ia/v1 sidebar badges). */
export interface ProjectAttention {
  /** Task proposals awaiting accept or dismiss. */
  proposals: number;
  /** Accepted tasks ready for the owner's close review. */
  reviews: number;
  /** Jobs paused until the owner allows a resume. */
  resumes: number;
}

/** One bounded ⌘K query result. Topics match their title only; message bodies are never searched or returned. */
export interface SearchResults {
  query: string;
  projects: Project[];
  topics: { project: Pick<Project, "id" | "name">; topic: Topic }[];
  more: { projects: boolean; topics: boolean };
}

import {
  backupIdentity, backupRetention, isJitVersion, jitAppVersion, listBackups, ownBackupDir,
  readBackupManifest, removeManagedFiles, selectRetentionVictims,
  type BackupCommand, type BackupManifest, type BackupNativePort, type BackupReceipt,
  type CreateBackupCommand, type PruneBackupsCommand, type BackupIntegrity, verifyBackupArtifacts, stageManagedBackup,
} from "./ops/backup";
import {
  buildExport, exportFailureReason, exportIdentity, exportPreview, exportRegistration, exportRetention, listExportArtifacts,
  readExportArtifact, readExportManifest, recordFailedExport, registerExport,
  type BuiltExport, type ExportCommand, type ExportFailure, type ExportLimits, type ExportManifest, type ExportPreview, type ExportReceipt,
  type FailedExportManifest, type ValidExportManifest,
} from "./ops/export";
import {
  activateUpgrade, completeAfterBootReconcile, corruptUpgrade, findUpgradeRequest, listUpgrades, migrateUpgrade, ownUpgradeDirFor, prepareUpgrade,
  readUpgrade, recoverUpgradesOnOpen, rollbackUpgrade, upgradeEvidence, upgradeIdentity, upgradeStatus, validateUpgrade,
  type UpgradeCommand, type UpgradeContext, type UpgradeFaultPoint, type UpgradeJournal, type UpgradeReceipt, type UpgradeRequest,
  type UpgradeResumeResult, type UpgradeServiceControl, type UpgradeStatus,
} from "./ops/upgrade";
import { readUpgradeFence, upgradeFenced } from "./ops/upgrade-fence";
import {
  activateRestore, activeRestore, applyRestoreLedger, readRestoreGate, completeRestoreOnBoot, discardRestore, findRestoreRequest, listRestores, migrateRestore,
  ownRestoreDirFor, prepareRestore, readRestore, recoverRestoresOnOpen, restoreEvidence, restoreIdentity, validateRestore,
  type RestoreCommand, type RestoreContext, type RestoreEvidence, type RestoreFaultPoint, type RestoreJournal, type RestoreReceipt,
  type RestoreRequest, type RestoreServiceControl,
} from "./ops/restore";
import { ledgerCheckpointPathFor, syncLedgerCheckpoint, type TrustedLedger } from "./ops/lifecycle-ledger";

/** Injectable clock and transaction fault seam for deterministic persistence checks. */
export interface ApplicationOptions {
  /** Service-supplied isolated runtime; absent means metadata-strip fallback, never a host decoder. */
  attachmentSanitizer?: AttachmentSanitizerRuntime | null;
  /** app.attachments/v1 deterministic storage/capability probes; production defaults fail closed. */
  attachments?: Pick<AttachmentStorageOptions, "diskFree" | "sanitizerAvailable">;
  now?: () => number;
  beforeCommit?(stage: "project" | "topic" | "message" | "job" | "team" | "decision" | "delivery" | "task" | "memory" | "receipt" | "schedule" | "backup" | "ops" | "setup"): void;
  jobs?: JobQueue;
  backupDir?: string;
  /** @deprecated Format-2 export artifacts live in SQLite; accepted for compatibility and ignored. */
  exportDir?: string;
  /** Tightens export registry bounds (tests); never loosens the defaults. */
  exportLimits?: Partial<ExportLimits>;
  upgradeDir?: string;
  restoreDir?: string;
  nativeSnapshot?: BackupNativePort;
  /** Producing build identity recorded in backup manifests; defaults to the shipped package version. */
  jitVersion?: string;
  /**
   * Service lifecycle owner (src/ops/upgrade-service.ts `ManagedService`).
   * When present, its current queue is the application's scheduler, and the
   * upgrade quiesces, rebuilds and reconciles through it. Without it, an
   * upgrade can quiesce a supplied `jobs` queue but leaves reconciliation to
   * the next service boot (journal `activated`).
   */
  service?: RestoreServiceControl & { readonly queue?: JobQueue | undefined; start?(): Promise<UpgradeResumeResult>; setDeletionEnvironment?(environment: import("./memory/delete").DeletionEnvironment): void };
  /** Deterministic fault seam at upgrade journal boundaries (tests only). */
  upgradeFault?(point: UpgradeFaultPoint): void;
  /** Deterministic fault seam at restore journal boundaries (tests only). */
  restoreFault?(point: RestoreFaultPoint): void;
  /**
   * Lifecycle ledger checkpoint file (app.deletion_ledger/v1). Defaults to
   * `<db>.lifecycle-ledger.json`; the service package passes its `ledgerPath`.
   */
  ledgerPath?: string;
  /**
   * exec.box_runtime/v1 (EXE03): the project boxes of this process. Without it `execution.box.reset` is
   * `box_not_configured`, and the kill switch has no box to stop.
   */
  boxes?: BoxManager;
  /** Service-owned external collateral for project deletion; ATT06 supplies attachment lifecycle here. */
  deletionContributors?: readonly import("./memory/project-delete").ProjectCollateralContributor[];
  /**
   * app.connections/v1 (EXE08): the secret files of owner connections. Without it every connection command is
   * `connection_vault_not_configured`. Stored values are fingerprinted for redaction when the application starts.
   */
  connections?: ConnectionVault;
  /**
   * app.approval_cards/v1 (EXE07): the effect executor that runs approved cards once, outside every box. Without it
   * approval is `effects_not_configured` (denial still works) and no effect tool is admitted.
   */
  effects?: EffectExecutor;
  /**
   * app.mcp_servers/v1 (EXE12): the MCP gateway whose installer runs accepted servers. Without it an accepted server
   * stays `installing` until a process with a gateway reconciles it as `failed` (`interrupted`).
   */
  mcp?: McpGateway;
  /**
   * exec.browser/v1 and app.takeover/v1 (EXE14): the browser sessions, the screenshot store and the virtual display
   * the owner's takeover input reaches. Without it takeover input is `browser_unavailable`.
   */
  browser?: BrowserService;
}

/** The committed receipt of an app.approval_cards/v1, app.auto_approve/v1 or effect target command. */
export interface ApprovalReceipt { card?: ApprovalCard; rule?: AutoApproveRule; target?: GitRemote | DeployTarget | { removed: true; name: string } }

/** Owns identity validation and revisioned app commands independently of Web or model transports. */
export class Application {
  #actors = new WeakMap<OwnerActor, string>();
  #now: () => number;
  #beforeCommit: ApplicationOptions["beforeCommit"];
  #jobsOption: JobQueue | undefined;
  #boxes: BoxManager | undefined;
  #connections: ConnectionVault | undefined;
  #effects: EffectExecutor | undefined;
  #mcp: McpGateway | undefined;
  #browser: BrowserService | undefined;
  #service: ApplicationOptions["service"];
  #upgradeFault: ApplicationOptions["upgradeFault"];
  #restoreFault: ApplicationOptions["restoreFault"];
  #ledgerPath: string;
  /** True while an asynchronous upgrade or restore command runs; other mutating commands are refused. */
  #upgradeBusy = false;
  #backupDir: string;
  #deletionEnvironment: import("./memory/delete").DeletionEnvironment;
  #exportLimits: ExportLimits;
  #restoreDir: string;
  #upgradeDir: string;
  #nativeSnapshot: BackupNativePort | undefined;
  #jitVersion: string;
  /** Backup ids whose files are staged but not yet committed; reconciliation never removes them. */
  #stagingBackups = new Set<string>();
  #attachments: AttachmentStorage;
  #sanitizer: AttachmentSanitizer;
  #sanitizerAvailable = false;

  constructor(readonly store: TransactionStore, readonly config: AppConfig, options: ApplicationOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#beforeCommit = options.beforeCommit;
    if (options.jobs && options.jobs.store !== store) throw new AppError("invalid_job_store");
    this.#jobsOption = options.jobs;
    this.#boxes = options.boxes;
    this.#connections = options.connections;
    this.#effects = options.effects;
    this.#mcp = options.mcp;
    this.#browser = options.browser;
    // app.connections/v1: from boot on, an echo of any stored value in outgoing text is redacted.
    if (this.#connections) { const vault = this.#connections; store.read(tx => vault.fingerprintStored(tx)); }
    this.#service = options.service;
    this.#upgradeFault = options.upgradeFault;
    this.#restoreFault = options.restoreFault;
    this.#ledgerPath = options.ledgerPath ?? ledgerCheckpointPathFor(store.path);
    this.#backupDir = ownBackupDir(store.path, options.backupDir);
    this.#attachments = new AttachmentStorage(store, config.attachments, { sanitizerAvailable: () => this.#sanitizerAvailable, ...options.attachments, now: this.#now,
      forbiddenDirectories: [this.#backupDir, config.execution.directory],
      backupActive: () => this.#stagingBackups.size > 0, assertWritable: () => {
        if (this.#upgradeBusy || upgradeFenced(store.path) || readRestoreGate(store.path)) throw new AppError("service_unavailable", 503);
      } });

    this.#deletionEnvironment = { backupDir: this.#backupDir, contributors: [
      ...(options.deletionContributors ?? []),
      { key: "execution_box", preview: (_tx: AppTransaction, projectId: string) => previewBoxData(this.config.execution.directory, projectId),
        confirm: () => {}, reconcile: async (projectId: string) => {
          await this.#boxes?.wipeDeletedProject(projectId);
          wipeBoxData(this.config.execution.directory, projectId);
        } },
    ] };
    options.jobs?.setDeletionEnvironment(this.#deletionEnvironment);
    options.service?.setDeletionEnvironment?.(this.#deletionEnvironment);
    this.#sanitizer = new AttachmentSanitizer(this.#attachments, options.attachmentSanitizer ?? null, { now: this.#now,
      assertCurrent: () => { this.store.read(tx => this.#jobs?.assertOwner(tx)); },
      onSettled: () => { this.#jobs?.pump(); } });

    this.#exportLimits = {
      maxExports: Math.min(exportRetention.maxExports, Math.max(1, options.exportLimits?.maxExports ?? exportRetention.maxExports)),
      maxBytes: Math.min(exportRetention.maxBytes, Math.max(1, options.exportLimits?.maxBytes ?? exportRetention.maxBytes)),
    };
    this.#restoreDir = ownRestoreDirFor(store.path, options.restoreDir);
    this.#upgradeDir = ownUpgradeDirFor(store.path, options.upgradeDir);
    this.#nativeSnapshot = options.nativeSnapshot;
    this.#jitVersion = options.jitVersion ?? jitAppVersion;
    if (!isJitVersion(this.#jitVersion)) throw new AppError("invalid_jit_version", 500);
    // ops.schema_migrations/v1: reconcile durable upgrade intent left by a crash before serving anything.
    recoverUpgradesOnOpen(store, this.#upgradeDir, this.#now());
    // ops.quarantined_restore/v1: same for restore intent (prepare interrupted, activation intent, lost fence).
    recoverRestoresOnOpen(store, this.#restoreDir, this.#now());
  }

  /** Current scheduler: the managed service's queue when one owns the lifecycle. */
  get #jobs(): JobQueue | undefined { return this.#service?.queue ?? this.#jobsOption; }

  /**
   * Service boot (serve): starts the managed service — reconciling jobs and
   * native sessions unless an upgrade fence holds — and completes an
   * activated upgrade once that reconciliation succeeded.
   */
  async boot(): Promise<{ reconciled: boolean; detail: string; upgrade: UpgradeJournal | null; restore: RestoreJournal | null }> {
    if (!this.#service?.start) throw new AppError("scheduler_unavailable", 503);
    // An activated restore finishes native deletion under its fence, then resumes the service, before normal boot.
    const restore = await completeRestoreOnBoot(this.#restoreContext(null));
    this.#syncLedger();
    const started = await this.#service.start();
    // app.approval_cards/v1: an effect that had started before the restart is `unknown`, never retried (ADR 0012).
    if (started.reconciled) this.#effects?.reconcile();
    // app.mcp_servers/v1: an install interrupted by the restart fails `interrupted`; the owner may accept again.
    if (started.reconciled) this.#mcp?.reconcile();
    const upgrade = started.reconciled ? completeAfterBootReconcile(this.#upgradeContext(null), started) : null;
    return { ...started, upgrade, restore };
  }

  /** Best-effort checkpoint refresh after lifecycle commits; a lagging checkpoint is extended on the next sync. */
  #syncLedger(): void {
    try { syncLedgerCheckpoint(this.store, this.#ledgerPath, this.#now()); } catch { /* Restore resolves trust itself and fails closed. */ }
  }

  /** Provisions exactly one owner through trusted local setup; HTTP uses the expiring capability boundary. */
  async setupOwner(password: string, reset = false): Promise<void> {
    await this.#saveOwnerPassword(password, reset);
  }

  /** Checks the installer capability; GET never creates an owner or consumes the link. */
  checkOwnerSetup(token: unknown): void {
    this.store.read(tx => requireOwnerSetup(this.store, tx, token, this.#now()));
  }

  /** Creates the first owner once, rechecking the capability under the owner commit's writer lock. Never resets. */
  async completeOwnerSetup(token: string, password: string): Promise<void> {
    this.checkOwnerSetup(token);
    await this.#saveOwnerPassword(password, false, tx => requireOwnerSetup(this.store, tx, token, this.#now()));
    removeOwnerSetupLink(this.store);
  }

  async #saveOwnerPassword(password: string, reset: boolean, authorize?: (tx: AppTransaction) => void): Promise<void> {
    if (typeof password !== "string" || password.length < 12 || password.length > 256) {
      throw new AppError("password_length_12_to_256");
    }
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.store.transaction(tx => {
      authorize?.(tx);
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
    this.store.transaction(tx => { const key = this.#requireOwner(tx, actor, ["web", "telegram"], false); tx.run("DELETE FROM sessions WHERE token_hash = ?", key); });
  }

  /** Returns one bounded owner projection; project names never select authorization identities. */
  workspace(actor: OwnerActor, offset = 0): Workspace {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new AppError("invalid_offset");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      const rows = tx.all<Project>(`SELECT p.id, p.name, p.revision, g.id AS groupId, p.created_at AS createdAt
        FROM projects p JOIN project_groups g ON g.project_id = p.id WHERE ${liveProjectSql("p")} ORDER BY p.created_at, p.id LIMIT ? OFFSET ?`,
      this.config.pageSize + 1, offset);
      return { revision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision,
        projects: rows.slice(0, this.config.pageSize), hasMore: rows.length > this.config.pageSize };
    });
  }

  /** ui.preferences/v1: the owner's saved theme and language, or the defaults. Readable while a restore is pending, like the restore console. */
  preferences(actor: OwnerActor): UiPreferences {
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web"], false); return readPreferences(tx); });
  }

  /** delivery.attention_levels/v1: the owner's notification level per channel, or the defaults (`needs-me`, revision 0; S12-D06). */
  attentionLevels(actor: OwnerActor): AttentionLevels {
    return this.store.read(tx => { this.#requireOwner(tx, actor); return readAttentionLevels(tx); });
  }

  /** app.local_api/v1: whether the owner turned the loopback API on, or the default (off, revision 0). */
  localApi(actor: OwnerActor): LocalApiSettings {
    return this.store.read(tx => { this.#requireOwner(tx, actor); return readLocalApi(tx); });
  }

  /**
   * app.local_api/v1: issues the Web-channel owner actor the in-process loopback listener uses, or null while the
   * API is off or before owner setup. The listener proves the caller holds the token file before it uses the actor;
   * the actor itself carries no authority beyond a Web session. It stays valid only while the setting keeps this
   * revision and the owner keeps this credential generation, so turning the API off or resetting the owner revokes
   * it at the next operation, before the listener stops.
   */
  issueLocalApiActor(): { actor: OwnerActor; revision: number; generation: number } | null {
    const state = this.store.read(tx => {
      const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
      const settings = readLocalApi(tx);
      return owner && settings.enabled ? { revision: settings.revision, generation: owner.generation } : null;
    });
    if (!state) return null;
    const actor: OwnerActor = Object.freeze({ ownerId: "owner", channel: "web" });
    this.#actors.set(actor, `${localApiKeyPrefix}${state.generation}:${state.revision}`);
    return { actor, ...state };
  }

  /**
   * app.local_api/v1: the committed `message.send` receipt with this request id and its commit time, or null.
   * A read of the owner's own receipt; it never replays or executes the command.
   */
  messageReceipt(actor: OwnerActor, requestId: string): { receipt: MessageReceipt; committedAt: number } | null {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new AppError("invalid_request_id");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const row = tx.get<{ result_json: string; committed_at: number }>(`SELECT r.result_json, r.committed_at FROM command_receipts r
        WHERE r.actor_id = 'owner' AND r.request_id = ? AND EXISTS (SELECT 1 FROM audit a WHERE a.actor_id = 'owner'
          AND a.request_id = r.request_id AND a.command_kind = 'message.send')`, requestId);
      return row ? { receipt: JSON.parse(row.result_json) as MessageReceipt, committedAt: row.committed_at } : null;
    });
  }

  /** app.local_api/v1: the project of one topic, resolved by the topic's stable identity under the owner. */
  topicScope(actor: OwnerActor, topicId: string): { project: Project; topic: Topic } {
    requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const row = tx.get<{ projectId: string }>("SELECT project_id AS projectId FROM topics WHERE id = ?", topicId);
      if (!row) throw new AppError("topic_not_found", 404);
      return { project: this.#project(tx, row.projectId), topic: readTopic(tx, row.projectId, topicId) };
    });
  }

  /**
   * app.local_api/v1 pending owner actions: dispatch proposals still waiting for the owner and jobs waiting on the
   * owner, newest first, at most `limit` of each with a flag when more exist. A read only.
   */
  pendingActions(actor: OwnerActor, limit: number): PendingActions {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AppError("invalid_limit");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const proposals = tx.all<{ id: string; projectId: string }>(`SELECT id, project_id AS projectId FROM dispatch_proposals
        WHERE state = 'proposed' ORDER BY updated_at DESC, id LIMIT ?`, limit + 1);
      const now = this.#now();
      const jobs = tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE state = 'waiting' ORDER BY sequence DESC LIMIT ?", limit + 1);
      return {
        proposals: proposals.slice(0, limit).map(row => {
          const card = readDispatchCard(tx, row.projectId, row.id, this.config.team);
          return { kind: "dispatch" as const, id: card.id, projectId: card.projectId, topicId: card.topicId, revision: card.revision,
            reason: card.reason, roles: card.roles, replyMessageId: card.replyMessageId };
        }),
        jobs: jobs.slice(0, limit).map(row => {
          const job = projectJob(JSON.parse(row.record_json) as Job, now);
          return { id: job.id, projectId: job.projectId, state: job.state, reason: job.reason };
        }),
        more: { proposals: proposals.length > limit, jobs: jobs.length > limit },
      };
    });
  }

  /** app.local_api/v1: the project of one dispatch proposal, so a route that names only the proposal can scope its command. */
  dispatchProposalProject(actor: OwnerActor, proposalId: string): string {
    requireId(proposalId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const row = tx.get<{ projectId: string }>("SELECT project_id AS projectId FROM dispatch_proposals WHERE id = ?", proposalId);
      if (!row) throw new AppError("dispatch_proposal_not_found", 404);
      return row.projectId;
    });
  }

  /**
   * web.settings_ia/v1 sidebar badges: counts of items waiting on the owner for at most 50 named projects.
   * Unknown identifiers count as zero; nothing is created, started or acknowledged.
   */
  attention(actor: OwnerActor, projectIds: readonly string[]): Record<string, ProjectAttention> {
    if (!Array.isArray(projectIds) || projectIds.length > 50) throw new AppError("invalid_project_list");
    for (const id of projectIds) requireId(id);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      // Close reviews use the task list's current-evidence projection, so badge and task page agree.
      const tasks = countOwnerTaskQueue(tx, projectIds, 500);
      const result: Record<string, ProjectAttention> = Object.fromEntries(projectIds.map(id => [id, { ...tasks[id]!, resumes: 0 }]));
      if (!projectIds.length) return result;
      const marks = projectIds.map(() => "?").join(", ");
      for (const row of tx.all<{ projectId: string; count: number }>(`SELECT project_id AS projectId, count(*) AS count FROM jobs
          WHERE project_id IN (${marks}) AND state = 'waiting' GROUP BY project_id`, ...projectIds)) result[row.projectId]!.resumes = row.count;
      return result;
    });
  }

  /**
   * web.settings_ia/v1 ⌘K query: a bounded, read-only match on project names and topic titles. The query is at
   * most `limits.query` code points; each kind returns at most its limit, newest first, with a flag when more
   * matched. An empty query reads nothing. Message bodies, sources and memory are never searched.
   */
  search(actor: OwnerActor, query: unknown, limits: { query: number; projects: number; topics: number }): SearchResults {
    if (typeof query !== "string" || Array.from(query).length > limits.query || /[\u0000-\u001f\u007f]/.test(query)) throw new AppError("invalid_query");
    const needle = query.trim();
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      if (!needle) return { query: needle, projects: [], topics: [], more: { projects: false, topics: false } };
      const projects = tx.all<Project>(`SELECT p.id, p.name, p.revision, g.id AS groupId, p.created_at AS createdAt
        FROM projects p JOIN project_groups g ON g.project_id = p.id WHERE ${liveProjectSql("p")} AND instr(lower(p.name), lower(?)) > 0
        ORDER BY p.created_at DESC, p.id LIMIT ?`, needle, limits.projects + 1);
      // Candidates are bounded (4× the topic limit) and projected through the normal topic read, so an unavailable
      // title is never returned and does not use up a result slot.
      const scan = limits.topics * 4;
      const rows = tx.all<{ id: string; projectId: string; projectName: string }>(`SELECT t.id, t.project_id AS projectId, p.name AS projectName
        FROM topics t JOIN projects p ON p.id = t.project_id JOIN sources s ON s.id = t.source_id
        JOIN source_versions v ON v.source_id = t.source_id AND v.revision = t.source_revision AND v.generation = t.source_generation
        WHERE ${liveProjectSql("p")} AND s.availability = 'available' AND v.content_text IS NOT NULL AND instr(lower(v.content_text), lower(?)) > 0
        ORDER BY t.created_at DESC, t.id LIMIT ?`, needle, scan);
      const visible = rows.map(row => ({ project: { id: row.projectId, name: row.projectName }, topic: readTopic(tx, row.projectId, row.id) }))
        .filter(item => item.topic.title !== null);
      return { query: needle, projects: projects.slice(0, limits.projects), topics: visible.slice(0, limits.topics),
        more: { projects: projects.length > limits.projects, topics: visible.length > limits.topics || rows.length === scan } };
    });
  }

  /** Resolves one topic and its project without reading messages (topic panel). */
  topic(actor: OwnerActor, projectId: string, topicId: string): { project: Project; topic: Topic } {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); return { project: this.#project(tx, projectId), topic: readTopic(tx, projectId, topicId) }; });
  }

  /** Topic panel tasks: the topic's open tasks under the task list's current-evidence projection, newest first. */
  topicTasks(actor: OwnerActor, projectId: string, topicId: string, limit: number) {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return { project, ...readTopicTasks(tx, projectId, topicId, limit) };
    });
  }

  /** Topic panel jobs: jobs waiting on the owner first, then the newest, at most `limit`; a read only. */
  recentJobs(actor: OwnerActor, projectId: string, limit: number) {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId), now = this.#now();
      const rows = tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? ORDER BY (state = 'waiting') DESC, sequence DESC LIMIT ?", projectId, limit);
      return { project, items: rows.map(row => projectJob(JSON.parse(row.record_json) as Job, now)) };
    });
  }

  /** telegram.owner_binding/v1 status for the settings page: a read only; binding and revocation keep their own commands. */
  telegramStatus(actor: OwnerActor): TelegramStatus {
    return this.store.read(tx => { this.#requireOwner(tx, actor); return readTelegramStatus(tx, this.config); });
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

  /**
   * app.jit_reply/v1: Jit's reply to each given owner message of one topic, keyed by message id.
   * Reads persisted state only; it never admits, resumes or reconnects work.
   */
  replies(actor: OwnerActor, projectId: string, topicId: string, messageIds: readonly string[]): Map<string, JitReplyView> {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return readRepliesFor(tx, projectId, topicId, messageIds);
    });
  }

  /**
   * app.jit_reply/v2 event replay: replies of one topic whose persisted state changed after `cursor`, in cursor
   * order. The optional limit narrows the configured page size (e.g. one row per SSE demand).
   * The topic event stream is built only from this read, so reconnecting never starts work.
   */
  replyStream(actor: OwnerActor, projectId: string, topicId: string, cursor: number, limit = this.config.pageSize): JitReplyView[] {
    requireId(projectId); requireId(topicId); requireCursor(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.config.pageSize) throw new AppError("invalid_limit");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return readReplyChanges(tx, projectId, topicId, cursor, limit);
    });
  }

  /** app.schedule_feed/v1: whether the owner's `.ics` feed is on and whether titles include the purpose. Never the token. */
  scheduleFeedSettings(actor: OwnerActor): ScheduleFeed {
    return this.store.read(tx => { this.#requireOwner(tx, actor); return readScheduleFeed(tx); });
  }

  /**
   * app.schedule_feed/v1 feed read. The path token is the only credential (calendar apps send no cookie), so there
   * is no actor: a malformed, wrong or turned-off token answers null after a constant-time check. While a restore
   * is incomplete this throws `restore_incomplete`. Reading writes nothing, admits nothing and creates no audit row.
   */
  scheduleFeed(token: string): { events: FeedEvent[]; includePurpose: boolean; language: UiPreferences["language"] } | null {
    return this.store.read(tx => {
      if (readRestoreGate(this.store.path)) throw new AppError("restore_incomplete", 423);
      if (!feedTokenMatches(tx, token)) return null;
      return { events: readFeedEvents(tx, this.#now()), includePurpose: readScheduleFeed(tx).includePurpose, language: readPreferences(tx).language };
    });
  }

  /** app.access_level/v1: the project's access level and kill switch state; `read`, revision 0, not halted by default. */
  projectAccess(actor: OwnerActor, projectId: string): ProjectAccess {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readProjectAccess(tx, projectId, this.config); });
  }

  /** app.access_level/v1: the latest restrict-only override of every restricted role, with its effective level. */
  roleAccess(actor: OwnerActor, projectId: string): RoleAccess[] {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readRoleAccess(tx, projectId); });
  }

  /** app.dispatch_allowance/v1: the project's current allowance, or the product default (revision 0). */
  dispatchAllowance(actor: OwnerActor, projectId: string): DispatchAllowance {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return readDispatchAllowance(tx, projectId, this.config); });
  }

  /**
   * app.dispatch_allowance/v1: proposal and team cards of one topic, keyed by the dispatching Jit reply message.
   * Reads persisted state only; it never admits, resumes or reconnects work.
   */
  dispatchCards(actor: OwnerActor, projectId: string, topicId: string, messageIds: readonly string[]): Map<string, DispatchCardView> {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return readDispatchCards(tx, projectId, topicId, messageIds, this.config.team);
    });
  }

  /** app.dispatch_allowance/v1: one proposal or team card by id. */
  dispatchCard(actor: OwnerActor, projectId: string, proposalId: string): DispatchCardView {
    requireId(projectId); requireId(proposalId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return readDispatchCard(tx, projectId, proposalId, this.config.team); });
  }

  /** app.persona/v1: the current owner persona, or the defaults (revision 0). */
  persona(actor: OwnerActor): Persona {
    return this.store.read(tx => { this.#requireOwner(tx, actor); return readPersona(tx); });
  }

  /** app.setup/v1: setup progress and Jit's route state, from persisted state only; it never starts a check. */
  setup(actor: OwnerActor): SetupView {
    return this.store.read(tx => { this.#requireOwner(tx, actor); return readSetup(tx, this.config); });
  }

  /** app.general_space/v1: the installation's one General space, or null before setup creates it. */
  generalSpace(actor: OwnerActor): GeneralSpace | null {
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); return readGeneralSpace(tx); });
  }

  /**
   * app.topic_promotion/v1: whether this topic was promoted (read-only, with its continuation) or continues a promoted
   * General space topic (with the origin read live through its own project, up to the linked revision). A read only.
   */
  promotion(actor: OwnerActor, projectId: string, topicId: string): TopicPromotionView {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return readTopicPromotion(tx, projectId, topicId);
    });
  }

  /** Streams one staged file after verified Web CSRF/Origin; revalidates session and scope before each chunk and at commit. */
  uploadAttachment(actor: OwnerActor, projectId: string, topicId: string, upload: AttachmentUpload): Promise<AttachmentView> {
    const authorize = (tx: AppTransaction) => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      if (readGeneralSpace(tx)?.projectId === projectId && !setupComplete(tx)) throw new AppError("setup_incomplete", 409);
    };
    this.store.read(authorize);
    const ingest = () => this.#attachments.upload(projectId, topicId, upload, authorize);
    if (!this.#sanitizer.runtime || !this.config.attachments.enabled) return ingest();
    return this.#sanitizer.available().then(available => { this.#sanitizerAvailable = available; return ingest(); });
  }

  /** Reads scoped attachment metadata even when ingestion is disabled; never returns file content. */
  attachment(actor: OwnerActor, projectId: string, topicId: string, id: string): AttachmentView {
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return readAttachment(tx, projectId, topicId, id); });
  }

  /** Reads bounded newest-first attachment audit metadata inside an authenticated project. */
  attachmentEvents(actor: OwnerActor, projectId: string, options: { before?: number; limit?: number; attachmentId?: string } = {}): AttachmentEventView[] {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); return readAttachmentEvents(tx, projectId, options); });
  }

  /** Service-only staged GC and orphan sweep; respects upgrade/restore fences and in-flight backups, including with gate off. */
  sweepAttachments(): { expired: number; removed: number } { return this.#attachments.sweep(); }

  /**
   * app.attachments/v1 (ATT03): what the composer may offer. `enabled` is the ingestion gate; `sanitizer` says whether
   * the container sanitizer is reachable, without which WebP and PDF are refused at upload. Configuration only.
   */
  attachmentComposer(): { enabled: boolean; messageFiles: number; fileBytes: number; sanitizer: boolean } {
    const limits = this.config.attachments;
    return { enabled: limits.enabled, messageFiles: limits.messageFiles, fileBytes: limits.fileBytes, sanitizer: this.#attachments.options.sanitizerAvailable?.() ?? false };
  }

  /**
   * The attachments bound to the given messages of one topic, keyed by message id (tombstones included). A read that
   * works with the gate off, so existing files still render. Metadata only; never file content.
   */
  messageAttachments(actor: OwnerActor, projectId: string, topicId: string, messageIds: readonly string[]): Map<string, AttachmentView[]> {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => { this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      return readMessageAttachments(tx, projectId, topicId, messageIds); });
  }

  /**
   * The no-script `?send=1` replay check (ATT03), read before any file part: the committed `message.send` receipt with
   * this request id, or null. A request id already used by another command, or by a message in another topic, is
   * 409 `request_id_conflict`, so a resubmitted form never uploads files it cannot bind.
   */
  sendReplay(actor: OwnerActor, projectId: string, topicId: string, requestId: string): MessageReceipt | null {
    requireId(projectId); requireId(topicId);
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) throw new AppError("invalid_conversation_command");
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const row = tx.get<{ result: string; kind: string | null }>(`SELECT r.result_json AS result, (SELECT a.command_kind FROM audit a
        WHERE a.actor_id = 'owner' AND a.request_id = r.request_id) AS kind FROM command_receipts r WHERE r.actor_id = 'owner' AND r.request_id = ?`, requestId);
      if (!row) return null;
      const receipt = row.kind === "message.send" ? JSON.parse(row.result) as MessageReceipt : null;
      if (!receipt || receipt.message.projectId !== projectId || receipt.message.topicId !== topicId) throw new AppError("request_id_conflict", 409);
      return receipt;
    });
  }

  /**
   * Discards one staged attachment (the composer chip ×, ATT03) with an idempotent request id: the same request id
   * and revision return the same result. Allowed with the gate off, so nothing that exists becomes undeletable.
   */
  discardAttachment(actor: OwnerActor, projectId: string, topicId: string, id: string, input: { requestId: string; expectedRevision: number }): { attachment: AttachmentView } {
    for (const value of [projectId, topicId, id]) requireId(value);
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new AppError("invalid_attachment_command");
    const payloadHash = digest(JSON.stringify(["attachment.discard", projectId, topicId, id, input.expectedRevision]));
    this.#attachmentWritable(actor);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", input.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as { attachment: AttachmentView };
      }
      this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      const now = this.#now();
      const result = { attachment: discardStagedAttachment(tx, { projectId, topicId, id, expectedRevision: input.expectedRevision, now }) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", input.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', 'attachment.discard', ?, ?, ?)", input.requestId, projectId, now);
      return result;
    });
  }

  /**
   * Discards the files a failed no-script send staged (ATT03), so a refused message does not hold quota until the staged
   * lifetime ends. Best effort: an id that is already bound or gone is left alone. Never touches a bound attachment.
   */
  abandonStagedAttachments(actor: OwnerActor, projectId: string, topicId: string, ids: readonly string[]): void {
    if (!ids.length) return;
    this.#attachmentWritable(actor);
    this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId);
      const now = this.#now();
      for (const id of ids) {
        try { discardStagedAttachment(tx, { projectId, topicId, id, expectedRevision: null, now }); }
        catch (error) { if (!(error instanceof AppError)) throw error; }
      }
    });
  }

  /**
   * Opens the bytes behind `preview` or `download` (S13-D05, ATT03) after the owner and scope checks; the caller streams
   * and closes the returned descriptor. A rejected or deleted attachment is 410 `attachment_unavailable`.
   * - `preview` serves only the `clean` file of a `ready` image re-encoded by the container (PNG or JPEG with a
   *   matching signature), otherwise 404 `attachment_preview_unavailable`; an original or fallback image never.
   *   Previews are not audited.
   * - `download` serves `clean` when it exists, otherwise the original of a PDF or text file. An image is never served
   *   before it is sanitized (409 `attachment_processing`). Each download writes a `download` event in the same
   *   transaction that opened the file.
   */
  attachmentContent(actor: OwnerActor, projectId: string, topicId: string, id: string, variant: "preview" | "download"): ServedAttachment {
    for (const value of [projectId, topicId, id]) requireId(value);
    if (variant === "download") this.#attachmentWritable(actor);
    // The descriptor lives outside the callback so a failed commit (or a retried callback) never leaks it.
    let opened: number | null = null;
    const release = () => { if (opened !== null) { try { closeSync(opened); } catch { /* already closed */ } opened = null; } };
    const open = (tx: AppTransaction): ServedAttachment => {
      release();
      this.#requireOwner(tx, actor); this.#project(tx, projectId); readTopic(tx, projectId, topicId);
      const row = tx.get<{ state: string; kind: string; sanitizedBy: string | null; name: string | null; mediaType: string; sha256: string | null; bytes: number;
        cleanSha256: string | null; cleanMediaType: string | null; cleanBytes: number | null }>(`SELECT state, kind, sanitized_by AS sanitizedBy, display_name AS name,
        media_type AS mediaType, sha256, bytes, clean_sha256 AS cleanSha256, clean_media_type AS cleanMediaType, clean_bytes AS cleanBytes
        FROM attachments WHERE id = ? AND project_id = ? AND topic_id = ?`, id, projectId, topicId);
      if (!row) throw new AppError("attachment_not_found", 404);
      if (row.state === "rejected" || row.state === "deleted" || row.name === null) throw new AppError("attachment_unavailable", 410);
      let hash: string, bytes: number, mediaType: string;
      if (variant === "preview") {
        if (row.kind !== "image" || row.state !== "ready" || row.sanitizedBy !== "container" || !row.cleanSha256 || !row.cleanBytes ||
          !previewable(row.cleanMediaType)) throw new AppError("attachment_preview_unavailable", 404);
        hash = row.cleanSha256; bytes = row.cleanBytes; mediaType = row.cleanMediaType!;
      } else if (row.cleanSha256 && row.cleanBytes && row.cleanMediaType) {
        hash = row.cleanSha256; bytes = row.cleanBytes; mediaType = row.cleanMediaType;
      } else if (row.kind === "image") {
        throw new AppError("attachment_processing", 409);
      } else if (row.sha256) {
        hash = row.sha256; bytes = row.bytes; mediaType = row.mediaType;
      } else throw new AppError("attachment_unavailable", 410);
      const fd = openServedBlob(this.#attachments.blobPath(projectId, hash), bytes, variant === "preview" ? mediaType : null);
      opened = fd;
      if (variant === "download") writeAttachmentEvent(tx, { projectId, attachmentId: id, kind: "download", status: "ok", bytes, createdAt: this.#now() });
      return { fd, bytes, mediaType, name: servedFileName(row.name, mediaType) };
    };
    try {
      const served = variant === "download" ? this.store.transaction(open) : this.store.read(open);
      opened = null;
      return served;
    } catch (error) { release(); throw error; }
  }

  /** Attachment writes outside `execute` (discard, download audit) honour the same upgrade and restore fences. */
  #attachmentWritable(actor: OwnerActor): void {
    if (this.#upgradeBusy || upgradeFenced(this.store.path) || readRestoreGate(this.store.path)) {
      this.store.read(tx => this.#requireOwner(tx, actor, ["web"], false));
      throw new AppError("service_unavailable", 503);
    }
  }

  /** Service-only bounded pending-row processing; respects lifecycle and scheduler ownership fences with the gate off. */
  processAttachments(): Promise<number> { return this.#sanitizer.pump(); }

  /** Cancels isolated parsers and waits for cleanup before service storage closes. */
  closeAttachmentSanitizer(): Promise<void> { return this.#sanitizer.close(); }

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
  execute(actor: OwnerActor, command: RenameProjectCommand): ProjectReceipt;
  execute(actor: OwnerActor, command: SetPreferencesCommand): PreferencesReceipt;
  execute(actor: OwnerActor, command: SetLocalApiCommand): LocalApiReceipt;
  execute(actor: OwnerActor, command: SetAttentionCommand): AttentionReceipt;
  execute(actor: OwnerActor, command: SetPersonaCommand): PersonaReceipt;
  execute(actor: OwnerActor, command: SetupCommand): SetupReceipt;
  execute(actor: OwnerActor, command: StopReplyCommand): ReplyReceipt;
  execute(actor: OwnerActor, command: RoleProposalCommand): RoleProposalReceipt;
  execute(actor: OwnerActor, command: SetDispatchAllowanceCommand): DispatchAllowanceReceipt;
  execute(actor: OwnerActor, command: FeedCommand): FeedReceipt;
  execute(actor: OwnerActor, command: AccessCommand): AccessReceipt;
  execute(actor: OwnerActor, command: ResetBoxCommand): Promise<BoxResetReceipt>;
  execute(actor: OwnerActor, command: ConnectionCommand): ConnectionReceipt;
  execute(actor: OwnerActor, command: DecideCardCommand | SetAutoApproveCommand | SetEffectTargetCommand | RemoveEffectTargetCommand): ApprovalReceipt;
  execute(actor: OwnerActor, command: McpCommand): McpReceipt;
  execute(actor: OwnerActor, command: TakeoverCommand): TakeoverReceipt;
  execute(actor: OwnerActor, command: TakeoverInputCommand): Promise<TakeoverInputReceipt>;
  execute(actor: OwnerActor, command: SetComputerSettingsCommand): ComputerSettingsReceipt;
  execute(actor: OwnerActor, command: DispatchCommand): DispatchReceipt;
  execute(actor: OwnerActor, command: CreateTopicCommand): TopicReceipt;
  execute(actor: OwnerActor, command: SendMessageCommand): MessageReceipt;
  execute(actor: OwnerActor, command: StartChatCommand): ChatReceipt;
  execute(actor: OwnerActor, command: PromotionCommand): PromotionReceipt;
  execute(actor: OwnerActor, command: TeamCommand): TeamReceipt;
  execute(actor: OwnerActor, command: DecisionCommand): DecisionReceipt;
  execute(actor: OwnerActor, command: TaskCommand): TaskReceipt;
  execute(actor: OwnerActor, command: CorrectMemoryCommand): CorrectionReceipt;
  execute(actor: OwnerActor, command: ForgetMemoryCommand): SuppressionReceipt;
  execute(actor: OwnerActor, command: CommitDeliveryCommand): DeliveryReceipt;
  execute(actor: OwnerActor, command: ResendDeliveryCommand): DeliveryResendReceipt;
  execute(actor: OwnerActor, command: RetireDeliveryCommand): DeliveryRetireReceipt;
  execute(actor: OwnerActor, command: PrReportCommand): PrReportReceipt;
  execute(actor: OwnerActor, command: SetAlertPolicyCommand): AlertPolicyReceipt;
  execute(actor: OwnerActor, command: WebhookCommand): WebhookReceipt;
  execute(actor: OwnerActor, command: CreateBackupCommand): Promise<BackupReceipt>;
  execute(actor: OwnerActor, command: PruneBackupsCommand): BackupReceipt;
  execute(actor: OwnerActor, command: BackupCommand): BackupReceipt | Promise<BackupReceipt>;
  execute(actor: OwnerActor, command: DeleteCommand): DeletionReceipt | DeletionConfirmReceipt | DeletionOperation;
  execute(actor: OwnerActor, command: ExportCommand): ExportReceipt;
  execute(actor: OwnerActor, command: UpgradeCommand): Promise<UpgradeReceipt>;
  execute(actor: OwnerActor, command: RestoreCommand): Promise<RestoreReceipt>;
  execute(actor: OwnerActor, command: CreateProjectCommand | RenameProjectCommand | SetPreferencesCommand | SetLocalApiCommand | SetAttentionCommand | SetPersonaCommand | SetupCommand | StopReplyCommand | RoleProposalCommand | PromotionCommand | SetDispatchAllowanceCommand | FeedCommand | AccessCommand | ResetBoxCommand | ConnectionCommand | ApprovalCommand | McpCommand | TakeoverCommand | TakeoverInputCommand | SetComputerSettingsCommand | DispatchCommand | ConversationCommand | JobCommand | ScheduleCommand | TeamCommand | DecisionCommand | DeliveryCommand | PrReportCommand | SetAlertPolicyCommand | WebhookCommand | TaskCommand | ExtractMemoryCommand | CorrectMemoryCommand | ForgetMemoryCommand | BackupCommand | DeleteCommand | ExportCommand | UpgradeCommand | RestoreCommand): ProjectReceipt | PreferencesReceipt | LocalApiReceipt | AttentionReceipt | PersonaReceipt | SetupReceipt | ReplyReceipt | RoleProposalReceipt | PromotionReceipt | DispatchAllowanceReceipt | FeedReceipt | AccessReceipt | Promise<BoxResetReceipt> | ConnectionReceipt | ApprovalReceipt | McpReceipt | TakeoverReceipt | Promise<TakeoverInputReceipt> | ComputerSettingsReceipt | DispatchReceipt | TopicReceipt | MessageReceipt | ChatReceipt | JobReceipt | ScheduleReceipt | TeamReceipt | DecisionReceipt | DeliveryReceipt | DeliveryResendReceipt | DeliveryRetireReceipt | PrReportReceipt | AlertPolicyReceipt | WebhookReceipt | TaskReceipt | MemoryReceipt | CorrectionReceipt | SuppressionReceipt | BackupReceipt | Promise<BackupReceipt> | DeletionReceipt | DeletionConfirmReceipt | DeletionOperation | ExportReceipt | Promise<UpgradeReceipt> | Promise<RestoreReceipt>;
  execute(actor: OwnerActor, command: CreateProjectCommand | RenameProjectCommand | SetPreferencesCommand | SetLocalApiCommand | SetAttentionCommand | SetPersonaCommand | SetupCommand | StopReplyCommand | RoleProposalCommand | PromotionCommand | SetDispatchAllowanceCommand | FeedCommand | AccessCommand | ResetBoxCommand | ConnectionCommand | ApprovalCommand | McpCommand | TakeoverCommand | TakeoverInputCommand | SetComputerSettingsCommand | DispatchCommand | ConversationCommand | JobCommand | ScheduleCommand | TeamCommand | DecisionCommand | DeliveryCommand | PrReportCommand | SetAlertPolicyCommand | WebhookCommand | TaskCommand | ExtractMemoryCommand | CorrectMemoryCommand | ForgetMemoryCommand | BackupCommand | DeleteCommand | ExportCommand | UpgradeCommand | RestoreCommand): ProjectReceipt | PreferencesReceipt | LocalApiReceipt | AttentionReceipt | PersonaReceipt | SetupReceipt | ReplyReceipt | RoleProposalReceipt | PromotionReceipt | DispatchAllowanceReceipt | FeedReceipt | AccessReceipt | Promise<BoxResetReceipt> | ConnectionReceipt | ApprovalReceipt | McpReceipt | TakeoverReceipt | Promise<TakeoverInputReceipt> | ComputerSettingsReceipt | DispatchReceipt | TopicReceipt | MessageReceipt | ChatReceipt | JobReceipt | ScheduleReceipt | TeamReceipt | DecisionReceipt | DeliveryReceipt | DeliveryResendReceipt | DeliveryRetireReceipt | PrReportReceipt | AlertPolicyReceipt | WebhookReceipt | TaskReceipt | MemoryReceipt | CorrectionReceipt | SuppressionReceipt | BackupReceipt | Promise<BackupReceipt> | DeletionReceipt | DeletionConfirmReceipt | DeletionOperation | ExportReceipt | Promise<UpgradeReceipt> | Promise<RestoreReceipt> {
    if (command?.kind === "message.send" && !this.config.attachments.enabled) {
      const ids = (command.payload as unknown as { attachmentIds?: unknown })?.attachmentIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 0)) {
        this.store.read(tx => this.#requireOwner(tx, actor)); throw new AppError("attachments_disabled", 404);
      }
    }
    if (command?.kind?.startsWith("upgrade.")) return this.#upgradeCommand(actor, command as UpgradeCommand);
    if (command?.kind?.startsWith("restore.")) return this.#restoreCommand(actor, command as RestoreCommand);
    // ops.schema_migrations/v1 admission fence (held by an upgrade or, ops.quarantined_restore/v1, a restore):
    // while it is present, no managed write is admitted.
    if (this.#upgradeBusy || upgradeFenced(this.store.path)) {
      this.store.read(tx => this.#requireOwner(tx, actor, ["web", "telegram"]));
      throw new AppError(readUpgradeFence(this.store.path)?.holder === "restore" ? "restore_in_progress" : "upgrade_in_progress", 409);
    }
    // app.general_space/v1: until the ceremony commits Jit's greeting, the General space takes no project command
    // from any ingress, so the greeting is always its first message. Stopping or resuming the route check stays open.
    const scope = (command as { projectId?: unknown } | null)?.projectId;
    if (typeof scope === "string" && command.kind !== "job.stop" && command.kind !== "job.resume") {
      this.store.read(tx => {
        this.#requireOwner(tx, actor, ["web", "telegram"]);
        // Completion is monotonic, so this check cannot go stale before the command's own transaction.
        if (readGeneralSpace(tx)?.projectId === scope && !setupComplete(tx)) throw new AppError("setup_incomplete", 409);
      });
    }
    if (command?.kind === "export.create") return this.#exportCommand(actor, command);
    if (command?.kind === "backup.create") return this.#createBackup(actor, command);
    if (command?.kind === "backup.prune") return this.#pruneBackups(actor, command);
    if (command?.kind === "memory.delete.preview" || command?.kind === "memory.delete.confirm" || command?.kind === "memory.delete.retry" || command?.kind === "project.delete.preview" || command?.kind === "project.delete.confirm" || command?.kind === "project.delete.retry") return this.#deleteCommand(actor, command);
    if (command?.kind === "memory.extract") return this.#memoryCommand(actor, command);
    if (command?.kind === "memory.correct") return this.#correctCommand(actor, command);
    if (command?.kind === "memory.forget") return this.#forgetCommand(actor, command);
    if (command?.kind === "pr.report.dismiss") return this.#prReportCommand(actor, command as DismissReportCommand);
    if (command?.kind === "pr.alert_policy.set") return this.#alertPolicyCommand(actor, command as SetAlertPolicyCommand);
    if (isWebhookCommand(command)) return this.#webhookCommand(actor, command);
    if (command?.kind === "schedule.create" || command?.kind === "schedule.pause" || command?.kind === "schedule.resume" ||
      command?.kind === "schedule.edit" || command?.kind === "schedule.revoke") return this.#scheduleCommand(actor, command as ScheduleCommand);
    if (isTaskCommand(command)) return this.#taskCommand(actor, command);
    if (command?.kind === "delivery.commit" || command?.kind === "delivery.resend" || command?.kind === "delivery.retire") return this.#deliveryCommand(actor, command);
    if (command?.kind === "project.create") return this.#createProject(actor, command);
    if (command?.kind === "project.rename") return this.#renameProject(actor, command);
    if (command?.kind === "ui.preferences.set") return this.#setPreferences(actor, command);
    if (command?.kind === "local_api.set") return this.#setLocalApi(actor, command);
    if (command?.kind === "attention.set") return this.#setAttention(actor, command);
    if (command?.kind === "persona.set") return this.#setPersona(actor, command);
    if (isSetupCommand(command)) return this.#setupCommand(actor, command);
    if (command?.kind === "jit.reply.stop") return this.#stopReply(actor, command);
    if (command?.kind === "role.proposal.accept" || command?.kind === "role.proposal.reject" || command?.kind === "role.proposal.revise") return this.#roleProposalCommand(actor, command);
    if (isPromotionCommand(command)) return this.#promotionCommand(actor, command);
    if (command?.kind === "dispatch.allowance.set") return this.#setAllowance(actor, command);
    if (isFeedCommand(command)) return this.#feedCommand(actor, command);
    if (isAccessCommand(command)) return this.#accessCommand(actor, command);
    if (isBoxCommand(command)) return this.#boxResetCommand(actor, command);
    if (isConnectionCommand(command)) return this.#connectionCommand(actor, command);
    if (isApprovalCommand(command)) return this.#approvalCommand(actor, command);
    if (isMcpCommand(command)) return this.#mcpCommand(actor, command);
    if (isTakeoverCommand(command)) return this.#takeoverCommand(actor, command);
    if (isTakeoverInputCommand(command)) return this.#takeoverInputCommand(actor, command);
    if (isComputerCommand(command)) return this.#computerCommand(actor, command);
    if (command?.kind === "dispatch.proposal.accept" || command?.kind === "dispatch.proposal.dismiss" || command?.kind === "dispatch.answer") return this.#dispatchCommand(actor, command);
    if (command?.kind === "job.enqueue" || command?.kind === "job.resume" || command?.kind === "job.stop") return this.#jobCommand(actor, command);
    if (command?.kind === "role.save" || command?.kind === "role.archive" || command?.kind === "route.save" || command?.kind === "role.preview" ||
        command?.kind === "team.dispatch" || command?.kind === "team.control" || command?.kind === "team.stop_all") return this.#teamCommand(actor, command);
    if (command?.kind === "decision.synthesize" || command?.kind === "decision.accept" || command?.kind === "decision.supersede") return this.#decisionCommand(actor, command);
    const payloadHash = digest(conversationIdentity(command as ConversationCommand, this.config.messageBytes));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as TopicReceipt | MessageReceipt | ChatReceipt;
      }
      this.#project(tx, command.projectId!);
      const now = this.#now();
      const result = mutateConversation(tx, command as ConversationCommand, now);
      // app.attachments/v1 (ATT03): staged files become bound to the message in its own transaction.
      const attachmentIds = command.kind === "message.send" ? command.payload.attachmentIds ?? [] : [];
      if (attachmentIds.length) bindAttachments(tx, { projectId: command.projectId!, topicId: (command as SendMessageCommand).payload.topicId,
        messageId: (result as MessageReceipt).message.id, ids: attachmentIds, messageFiles: this.config.attachments.messageFiles, now });
      // app.jit_reply/v1: the message and its one reply admission commit together (ADR 0029). A chat started from
      // the home composer is a new topic plus its first message, answered the same way.
      if (command.kind === "message.send" || command.kind === "chat.start") admitJitReply(tx, { message: (result as MessageReceipt | ChatReceipt).message, requestId: command.requestId,
        replyTo: command.kind === "message.send" ? command.payload.replyTo ?? null : null, config: this.config, queue: this.#jobs, generation: tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation, now });
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
      return { project: this.#project(tx, projectId, true), preview: readDeletionPreview(tx, projectId, previewId) };
    });
  }

  /** app.data_lifecycle/v1: reads one deletion operation with its per-scope state. */
  deletionOperation(actor: OwnerActor, projectId: string, operationId: string): { project: Project; operation: DeletionOperation | null } {
    requireId(projectId); requireId(operationId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId, true), operation: readDeletionOperation(tx, projectId, operationId) };
    });
  }

  /** app.data_lifecycle/v1: bounded per-scope deletion operations for one project. */
  deletionOperations(actor: OwnerActor, projectId: string): { project: Project; operations: DeletionOperation[] } {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId, true), operations: listDeletionOperations(tx, projectId) };
    });
  }

  /** Lists recent whole-project cleanup operations, including tombstones hidden from project navigation. */
  projectDeletionOperations(actor: OwnerActor): DeletionOperation[] {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return tx.all<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE json_extract(record_json, '$.scope.kind') = 'project' ORDER BY rowid DESC LIMIT 50")
        .map(row => JSON.parse(row.record_json) as DeletionOperation);
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

  /** ops.project_export/v1: owner-only artifact bytes (hash-verified) read from the committed valid row. */
  exportArtifact(actor: OwnerActor, projectId: string, id: string): { manifest: ValidExportManifest; body: Uint8Array } {
    requireId(projectId); requireId(id);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, projectId);
      return readExportArtifact(tx, projectId, id);
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

  /**
   * ops.project_export/v1 create. One transaction authorizes, dedupes, checks the expected
   * revision, builds the artifact, re-checks the lifecycle mark, stores the valid registration
   * with its bytes, applies retention from that final outcome and binds the receipt. An
   * artifact therefore exists iff its committed row is valid. A failure rolls everything back
   * (older exports included) and a separate transaction records a durable failed export bound
   * to the request ID. Replays follow the registration's current state: valid returns it,
   * failed re-throws, pruned/deleted throws `export_expired`.
   */
  #exportCommand(actor: OwnerActor, command: ExportCommand): ExportReceipt {
    const payloadHash = digest(exportIdentity(command));
    const id = crypto.randomUUID();
    const work: { stage?: ExportFailure["stage"]; now?: number; projectRevision?: number } = {};
    const failed = (manifest: FailedExportManifest) => new AppError(manifest.failure.reason,
      manifest.failure.reason === "export_failed" ? 500 : manifest.failure.reason === "export_storage_unavailable" ? 503 : manifest.failure.reason === "export_too_large" ? 413 : 409,
      { projectId: manifest.projectId, exportId: manifest.id, path: `/projects/${manifest.projectId}/exports/${manifest.id}` });
    const saveReceipt = (tx: AppTransaction, manifest: ExportManifest, now: number) => {
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify({ manifest, duplicate: false }), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
    };
    try {
      return this.store.transaction(tx => {
        this.#requireOwner(tx, actor); const project = this.#project(tx, command.projectId);
        const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
        if (prior) {
          if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
          const stored = JSON.parse(prior.result_json) as { manifest: { id: string; projectId: string } };
          const current = exportRegistration(tx, stored.manifest.id);
          if (!current) {
            throw new AppError("export_expired", 410, { projectId: stored.manifest.projectId, exportId: stored.manifest.id, path: `/projects/${stored.manifest.projectId}/exports` });
          }
          if (current.state === "failed") throw failed(current);
          return { manifest: current, duplicate: false };
        }
        const now = this.#now();
        if (project.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
        work.now = now; work.projectRevision = project.revision; work.stage = "stage";
        const built: BuiltExport = buildExport(tx, { id, now, projectId: command.projectId, projectRevision: project.revision,
          scope: { includeHistory: command.payload.includeHistory }, note: command.payload.note, limits: this.#exportLimits });
        this.#beforeCommit?.("ops");
        work.stage = "publish";
        const manifest = registerExport(tx, built);
        work.stage = "commit";
        saveReceipt(tx, manifest, now);
        this.#beforeCommit?.("receipt");
        return { manifest, duplicate: false };
      });
    } catch (error) {
      // Rejections before building (auth, conflict, stale revision, replays) stay plain rejections.
      if (!work.stage || work.now === undefined || work.projectRevision === undefined) throw error;
      const failure: ExportFailure = { reason: exportFailureReason(error), stage: work.stage };
      let manifest: FailedExportManifest;
      try {
        manifest = this.store.transaction(tx => {
          const recorded = recordFailedExport(tx, { id, now: work.now!, projectId: command.projectId, projectRevision: work.projectRevision!,
            scope: { includeHistory: command.payload.includeHistory }, failure, limits: this.#exportLimits });
          saveReceipt(tx, recorded, work.now!);
          return recorded;
        });
      } catch {
        // The failure record could not commit either; the original rejection stays actionable.
        throw error instanceof AppError ? error : new AppError("export_failed", 500);
      }
      throw failed(manifest);
    }
  }

  /** ops.schema_migrations/v1: reads one upgrade journal with sanitized evidence and its recovery choices. */
  upgrade(actor: OwnerActor, id: string): { journal: ReturnType<typeof upgradeEvidence> } {
    requireId(id);
    this.store.read(tx => this.#requireOwner(tx, actor));
    let journal: UpgradeJournal;
    try { journal = readUpgrade(this.#upgradeDir, id); }
    catch (error) {
      // A malformed control-plane journal is shown as its durable blocked corrupt view, never acted on.
      if (!(error instanceof AppError) || error.code !== "upgrade_corrupt") throw error;
      journal = corruptUpgrade(id);
    }
    return { journal: upgradeEvidence(journal) };
  }

  /** ops.schema_migrations/v1: bounded upgrade journal for the installation. */
  upgrades(actor: OwnerActor): { journals: ReturnType<typeof upgradeEvidence>[] } {
    this.store.read(tx => this.#requireOwner(tx, actor));
    return { journals: listUpgrades(this.#upgradeDir).map(upgradeEvidence) };
  }

  /**
   * ops.schema_migrations/v1: current/target schema, declared engine
   * compatibility, fence and active attempt. Reads only; never invokes the
   * native snapshot. Works on an installation still at an older schema.
   */
  upgradeStatus(actor: OwnerActor): UpgradeStatus {
    this.store.read(tx => this.#requireOwner(tx, actor));
    return upgradeStatus(this.store, this.#upgradeDir, this.#nativeSnapshot);
  }

  #upgradeContext(actor: OwnerActor | null): UpgradeContext {
    return {
      store: this.store, upgradeDir: this.#upgradeDir, backupDir: this.#backupDir, port: this.#nativeSnapshot,
      jitVersion: this.#jitVersion, now: this.#now, inflight: this.#stagingBackups, service: this.#upgradeService(),
      authorize: tx => { if (actor) this.#requireOwner(tx, actor); },
      ...(this.#upgradeFault ? { fault: this.#upgradeFault } : {}),
    };
  }

  /** The service control the upgrade drives; without a managed service, reconciliation waits for the next boot. */
  #upgradeService(): UpgradeServiceControl {
    if (this.#service) return this.#service;
    const queue = this.#jobsOption;
    return {
      quiesce: async () => {
        if (queue) {
          queue.close();
          await queue.idle();
          const unsettled = this.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE occupies = 1 OR state = 'admitted'")!.n);
          return unsettled ? { settled: false, fencedJobs: unsettled, detail: `unsettled_${unsettled}` } : { settled: true, fencedJobs: 0, detail: "admission_stopped_no_inflight" };
        }
        // No scheduler in this process (offline CLI): another live instance must not own admission or delivery.
        const owner = this.store.read(tx => {
          const pid = (table: string) => { try { return tx.get<{ pid: number }>(`SELECT pid FROM ${table} WHERE id = 1`)?.pid ?? null; } catch { return null; } };
          return [pid("job_scheduler"), pid("delivery_worker")].filter((value): value is number => value !== null);
        });
        const alive = owner.some(pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
        return alive ? { settled: false, fencedJobs: 0, detail: "another_instance_owns_admission" } : { settled: true, fencedJobs: 0, detail: "no_scheduler_in_process" };
      },
      resume: async () => ({ reconciled: false, detail: queue ? "service_restart_required" : "no_scheduler_in_process" }),
    };
  }

  /**
   * ops.schema_migrations/v1 commands. Shape validation, owner
   * authentication, request identity and revision are checked first and
   * outside any failure-recording scope: a forged actor, stale revision or
   * conflicting request id never writes upgrade evidence. Accepted requests
   * are receipts in the control-plane journal (outside the swapped database)
   * and are mirrored into ordinary receipts/audit when the attempt ends.
   */
  async #upgradeCommand(actor: OwnerActor, command: UpgradeCommand): Promise<UpgradeReceipt> {
    const payloadHash = digest(upgradeIdentity(command));
    const checked = this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return {
        receipt: tx.get<{ payload_hash: string }>("SELECT payload_hash FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId),
        revision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision,
      };
    });
    const prior = findUpgradeRequest(this.#upgradeDir, command.requestId);
    if (prior) {
      if (prior.request.payloadHash !== payloadHash || prior.request.kind !== command.kind) throw new AppError("request_id_conflict", 409);
      return { journal: upgradeEvidence(prior.journal), duplicate: true };
    }
    if (checked.receipt) throw new AppError("request_id_conflict", 409);
    if (checked.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    if (this.#upgradeBusy) throw new AppError("upgrade_in_progress", 409);
    // ops.quarantined_restore/v1: a restore attempt owns the installation until it ends.
    if (command.kind === "upgrade.prepare" && activeRestore(this.#restoreDir)) throw new AppError("restore_in_progress", 409);
    this.#upgradeBusy = true;
    try {
      const ctx = this.#upgradeContext(actor);
      const request: UpgradeRequest = { requestId: command.requestId, kind: command.kind, payloadHash, at: this.#now() };
      let journal: UpgradeJournal;
      if (command.kind === "upgrade.prepare") {
        journal = await prepareUpgrade(ctx, { request, targetSchema: command.payload.targetSchema, note: command.payload.note });
      } else {
        const current = readUpgrade(this.#upgradeDir, command.payload.upgradeId);
        journal = command.kind === "upgrade.migrate" ? migrateUpgrade(ctx, current, request)
          : command.kind === "upgrade.validate" ? validateUpgrade(ctx, current, request)
            : command.kind === "upgrade.activate" ? await activateUpgrade(ctx, current, request)
              : await rollbackUpgrade(ctx, current, request);
      }
      return { journal: upgradeEvidence(journal), duplicate: false };
    } finally {
      this.#upgradeBusy = false;
      this.#jobs?.cancelFenced();
    }
  }

  /** ops.quarantined_restore/v1: one restore journal with its owner report and valid next actions. */
  restore(actor: OwnerActor, id: string): { quarantine: RestoreEvidence } {
    requireId(id);
    this.store.read(tx => this.#requireOwner(tx, actor, ["web"], false));
    return { quarantine: restoreEvidence(readRestore(this.#restoreDir, id)) };
  }

  /**
   * ops.quarantined_restore/v1 console: the installation revision restore commands expect and the
   * restore holding the read gate (null once normal service is allowed). Never gated.
   */
  restoreConsole(actor: OwnerActor): { revision: number; gatedBy: string | null } {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web"], false);
      return { revision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision, gatedBy: readRestoreGate(this.store.path) };
    });
  }

  /**
   * ops.quarantined_restore/v1: bounded restore journals plus the current
   * trust state of the installation lifecycle ledger (read-only; never writes
   * the checkpoint).
   */
  restores(actor: OwnerActor): { quarantines: RestoreEvidence[]; ledger: Omit<Extract<TrustedLedger, { state: "trusted" }>, "entries"> | Extract<TrustedLedger, { state: "untrusted" }> } {
    this.store.read(tx => this.#requireOwner(tx, actor, ["web"], false));
    const ledger = syncLedgerCheckpoint(this.store, this.#ledgerPath, this.#now(), { write: false });
    const summary = ledger.state === "trusted" ? (({ entries: _entries, ...rest }) => rest)(ledger) : ledger;
    return { quarantines: listRestores(this.#restoreDir).map(restoreEvidence), ledger: summary };
  }

  #restoreContext(actor: OwnerActor | null): RestoreContext {
    return {
      store: this.store, deletionEnvironment: this.#deletionEnvironment, restoreDir: this.#restoreDir, backupDir: this.#backupDir, ledgerPath: this.#ledgerPath,
      port: this.#nativeSnapshot, jitVersion: this.#jitVersion, now: this.#now, service: this.#upgradeService(),
      authorize: tx => { if (actor) this.#requireOwner(tx, actor, ["web"], false); },
      ...(this.#restoreFault ? { fault: this.#restoreFault } : {}),
    };
  }

  /**
   * ops.quarantined_restore/v1 commands. Shape, owner session, request
   * identity and revision are checked first and never write evidence.
   * Accepted requests are receipts in the control-plane journal (outside the
   * swapped database), mirrored into ordinary receipts/audit when the attempt
   * ends. Restore and upgrade share one busy flag and one durable fence.
   */
  async #restoreCommand(actor: OwnerActor, command: RestoreCommand): Promise<RestoreReceipt> {
    const payloadHash = digest(restoreIdentity(command));
    const checked = this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web"], false);
      return {
        receipt: tx.get<{ payload_hash: string }>("SELECT payload_hash FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId),
        revision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision,
      };
    });
    const prior = findRestoreRequest(this.#restoreDir, command.requestId);
    if (prior) {
      if (prior.request.payloadHash !== payloadHash || prior.request.kind !== command.kind) throw new AppError("request_id_conflict", 409);
      return { quarantine: restoreEvidence(prior.journal), duplicate: true };
    }
    if (checked.receipt) throw new AppError("request_id_conflict", 409);
    if (checked.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    if (this.#upgradeBusy) throw new AppError("restore_in_progress", 409);
    this.#upgradeBusy = true;
    try {
      const ctx = this.#restoreContext(actor);
      const request: RestoreRequest = { requestId: command.requestId, kind: command.kind, payloadHash, at: this.#now() };
      let journal: RestoreJournal;
      if (command.kind === "restore.prepare") {
        const upgradeActive = listUpgrades(this.#upgradeDir, 100).some(j => ["preparing", "prepared", "staged", "ready", "activating", "activated", "blocked"].includes(j.state));
        journal = await prepareRestore(ctx, { request, backupId: command.payload.backupId, note: command.payload.note, upgradeActive });
      } else {
        const current = readRestore(this.#restoreDir, command.payload.quarantineId);
        journal = command.kind === "restore.migrate" ? migrateRestore(ctx, current, request)
          : command.kind === "restore.apply_ledger" ? applyRestoreLedger(ctx, current, request)
            : command.kind === "restore.validate" ? validateRestore(ctx, current, request)
              : command.kind === "restore.activate" ? await activateRestore(ctx, current, request)
                : await discardRestore(ctx, current, request);
      }
      return { quarantine: restoreEvidence(journal), duplicate: false };
    } finally {
      this.#upgradeBusy = false;
      this.#jobs?.cancelFenced();
    }
  }

  #deleteCommand(actor: OwnerActor, command: DeleteCommand): DeletionReceipt | DeletionConfirmReceipt | DeletionOperation {
    const payloadHash = digest(deleteCommandIdentity(command, this.config.team.contextBytes));
    // Private commit metadata: only a newly created or re-armed operation earns post-commit work. Receipt
    // replays and duplicate confirmations never queue a pass (the replayed receipt keeps duplicate:false).
    const { result, operationId } = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); const project = this.#project(tx, command.projectId, command.kind.startsWith("project.delete."));
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return { result: JSON.parse(prior.result_json) as DeletionReceipt | DeletionConfirmReceipt | DeletionOperation, operationId: null };
      }
      const now = this.#now();
      let operationId: string | null = null;
      let result: DeletionReceipt | DeletionConfirmReceipt | DeletionOperation;
      if (command.kind === "memory.delete.preview" || command.kind === "project.delete.preview") {
        result = { preview: prepareDeletionPreview(tx, command, project.revision, now, this.#deletionEnvironment), duplicate: false } satisfies DeletionReceipt;
      } else if (command.kind === "memory.delete.confirm" || command.kind === "project.delete.confirm") {
        const confirmed = confirmDeletion(tx, command, project.revision, now, this.#deletionEnvironment);
        if (!confirmed.duplicate) operationId = confirmed.operation.id;
        result = confirmed;
      } else if (command.kind === "memory.delete.retry" || command.kind === "project.delete.retry") {
        const retried = retryDeletion(tx, command, now);
        if (retried.state === "pending" && retried.reason === "retry_requested") operationId = retried.id;
        result = retried;
      } else throw new AppError("invalid_memory_delete");
      this.#beforeCommit?.("memory");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return { result, operationId };
    });
    this.#jobs?.cancelFenced();
    if (operationId) {
      if (command.kind === "project.delete.confirm") {
        this.#effects?.accessChanged(command.projectId);
        this.#browser?.accessChanged(command.projectId);
        for (const server of this.store.read(tx => tx.all<{ id: string }>("SELECT id FROM mcp_servers WHERE project_id = ?", command.projectId))) this.#mcp?.serverRemoved(server.id);
      }
      // app.deletion_ledger/v1: the committed tombstones are in the installation ledger; refresh its checkpoint.
      this.#syncLedger();
      // Committed: purge app-owned export files now, then hand native contexts to one budgeted pass.
      try { purgeDeletedExports(this.store, this.#now(), operationId); } catch { /* Per-file state stays pending for reconcile. */ }
      finalizeProjectDatabasePurge(this.store, this.#now(), operationId);
      void this.#jobs?.reconcilePendingDeletions();
    }
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
    this.#syncLedger();
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
      }
      // app.context_packet/v1: an accepted or superseded decision changes every packet's pinned set, so pending
      // runs that pinned the previous set are fenced here and cancelled after commit.
      if (result.decision) fenceStaleContexts(tx, now);
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
      // app.topic_promotion/v1: a promoted origin takes no new team work; it would add conversation after the link.
      if ((command.kind === "team.dispatch" || command.kind === "role.preview") && command.projectId) requireTopicOpen(tx, command.projectId, command.payload.topicId);
      const result = command.kind === "role.preview" ? preparePreview(tx, command, this.config, this.#jobs, generation, now)
        : command.kind === "team.dispatch" ? prepareDispatch(tx, command, this.config, this.#jobs, generation, now)
        : command.kind === "team.control" ? prepareControl(tx, command, this.config, this.#jobs, generation, now)
        : command.kind === "team.stop_all" ? this.#stopAll(tx, command, generation, now)
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
   * Lists private PR review reports and per-candidate review states for one project.
   * `pr.private_report/v1` + `pr.private_alerts/v1` inspection; reading never admits work or sends.
   * Returns `{project, items, reviews, pending, policy}`: `reviews` is every candidate's projected
   * state (`listReviewStates`); `pending` is the subset still awaiting a report for that projection
   * (`not_reviewed` or `running`, always `reportId: null`).
   */
  prReports(actor: OwnerActor, projectId: string, monitorId?: string) {
    requireId(projectId);
    if (monitorId !== undefined) requireId(monitorId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId);
      // Per-candidate states keep not-reviewed, running, failed and stale distinguishable.
      const reviews = listReviewStates(tx, projectId, monitorId);
      const pending = reviews.filter(review => review.observed === "not_reviewed" || review.observed === "running");
      return { project, items: listReports(tx, projectId, monitorId), reviews, pending, policy: readAlertPolicy(tx, projectId) };
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
      const policy = readAlertPolicy(tx, projectId);
      // Preview under the current policy; `decisions` is the stored record of what admission actually did.
      const evaluation = evaluateReport(report, policy);
      const decisions = readAlertDecisions(tx, reportId);
      const links = readAlertLinks(tx, reportId);
      const alerts = tx.all<{ record_json: string }>(
        `SELECT record_json FROM delivery_intents WHERE project_id = ? AND (dedupe_key LIKE ? OR id IN (SELECT intent_id FROM pr_alerts WHERE report_id = ?)) ORDER BY sequence`,
        projectId, `pr-alert/${reportId}/%`, reportId,
      ).map(row => {
        const intent = JSON.parse(row.record_json) as DeliveryIntent;
        return { ...intent, findingId: links.find(link => link.intentId === intent.id)?.findingId ?? null };
      });
      // Immutable source manifest, transmitted manifest and bounded attempt summaries.
      const evidence = reportRunEvidence(tx, projectId, report);
      return { project, report, annotations, evaluation, alerts, evidence, policy, decisions, decision: decisions.at(-1) ?? null };
    });
  }

  /**
   * Admits at most one logical private alert per qualifying finding after rechecking
   * current base/head/policy, report validity, owner dismissal and enabled monitoring.
   * `pr.private_alerts/v1` owner re-admission (the `pr.review` report commit admits automatically);
   * replay dedupes to the existing intent and stored decision.
   */
  admitPrAlerts(actor: OwnerActor, projectId: string, reportId: string) {
    requireId(projectId); requireId(reportId);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      this.#project(tx, projectId);
      return admitReportAlerts(tx, { projectId, reportId, maxBytes: this.config.messageBytes, trigger: "owner_admit" }, this.#now());
    });
  }

  /**
   * app.webhook_triggers/v1 owner view: every PR monitor of the project with its trigger state, next poll instant and
   * the last poll failure (a reason code, cleared by the next successful poll).
   * Never returns a secret or its sealed form.
   */
  prWebhooks(actor: OwnerActor, projectId: string): { project: Project; monitors: { id: string; repository: string; state: string; pollDueAt: number;
    pollFailure: { reason: string; at: number } | null; trigger: WebhookTriggerView }[] } {
    requireId(projectId);
    const directory = webhookKeyDirectory(this.store.path);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      const project = this.#project(tx, projectId);
      if (!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_monitors'")) return { project, monitors: [] };
      return { project, monitors: readMonitors(tx, projectId).map(monitor => {
        const poll = monitorPollDue(tx, projectId, monitor.id);
        return { id: monitor.id, repository: `${monitor.repository.owner}/${monitor.repository.name}`, state: monitor.state,
          pollDueAt: poll.dueAt, pollFailure: poll.failure, trigger: readWebhookTrigger(tx, projectId, monitor.id, directory) };
      }) };
    });
  }

  /** app.webhook_triggers/v1: whether a route id names an active trigger. Not an owner read; it discloses nothing else. */
  webhookRouteActive(routeId: string): boolean {
    return this.store.read(tx => webhookRouteActive(tx, routeId));
  }

  /**
   * app.webhook_triggers/v1: verifies one signed delivery and, only if every check passes, records its delivery id
   * and moves the monitor's next poll earlier. Not an owner command: the sender holds no owner authority, and the
   * payload is never parsed or stored. Refused while an upgrade or restore holds the installation.
   */
  acceptWebhook(delivery: WebhookDelivery): { dueAt: number } {
    if (this.#upgradeBusy || upgradeFenced(this.store.path) || readRestoreGate(this.store.path)) throw new AppError("service_unavailable", 503);
    const directory = webhookKeyDirectory(this.store.path);
    return this.store.transaction(tx => acceptWebhookDelivery(tx, delivery, this.#now(), directory));
  }

  /** app.webhook_triggers/v1 owner command. The stored receipt never holds the secret: a replay answers `secret: null`. */
  #webhookCommand(actor: OwnerActor, command: WebhookCommand): WebhookReceipt {
    const payloadHash = digest(webhookIdentity(command));
    const directory = webhookKeyDirectory(this.store.path);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as WebhookReceipt;
      }
      const now = this.#now();
      const result = applyWebhookCommand(tx, command, now, directory);
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify({ ...result, secret: null }), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      return result;
    });
  }

  /** Reads the current project alert policy (explicit default until the owner or first admission persists it). */
  prAlertPolicy(actor: OwnerActor, projectId: string) {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return { project: this.#project(tx, projectId), policy: readAlertPolicy(tx, projectId) };
    });
  }

  /** Writes the next owner alert policy version under the shared command receipt pattern. */
  #alertPolicyCommand(actor: OwnerActor, command: SetAlertPolicyCommand): AlertPolicyReceipt {
    const payloadHash = digest(alertPolicyIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web"]);
      this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as AlertPolicyReceipt;
      }
      const now = this.#now();
      const result = setAlertPolicy(tx, command, now, this.config.messageBytes);
      this.#beforeCommit?.("delivery");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
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
        choices: (this.#jobs?.choices() ?? []).filter(choice => ![reminderWorkId, summaryWorkId, "role.scripted-preview", "team.discussion", "team.specialist-analysis", coordinatorSynthesisWorkId, jitReplyWorkId, setupCheckWorkId].includes(choice.id)),
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
      // Attempts keep their request manifests; owner reads project them lifecycle-safely.
      return { ...projectJob(readJob(tx, projectId, jobId), this.#now()), attempts: lifecycleSafeManifests(tx, attempts), reconciliations,
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
        // delivery.attention_levels/v1: the owner asked for this notice explicitly, so every level creates it.
        ? commitDeliveryIntent(tx, { projectId: command.projectId, kind: command.payload.kind, text: command.payload.text, dedupeKey: command.payload.dedupeKey, maxBytes: this.config.messageBytes, expectedProjectRevision: command.expectedRevision,
          attention: { class: "needs_owner", item: null, workGroupId: null } }, now)
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
      // delivery.attention_levels/v1: resuming or stopping a waiting team job answers its notice in this transaction.
      if (command.kind !== "job.enqueue") evaluateWorkGroup(tx, workGroupOfJob(tx, command.projectId, command.payload.jobId), this.config.team, now, "owner_answered");
      this.#beforeCommit?.("job");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt"); return result;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /** ops.backup_manifest/v1 reads: bounded inventory outside ordinary project data. */
  backups(actor: OwnerActor): { manifests: BackupManifest[]; integrity: Record<string, BackupIntegrity> } {
    const listed = this.store.read(tx => {
      // Identity-only inventory of recoverable source artifacts: part of restore remediation, so not read-gated.
      this.#requireOwner(tx, actor, ["web"], false);
      return listBackups(tx);
    });
    // The inventory is installation-bounded (retention: 10 backups, 64 MiB), so every
    // listed entry is verified; an invalid entry is never labelled valid.
    const integrity: Record<string, BackupIntegrity> = {};
    const manifests = listed.map(manifest => {
      let verdict: BackupIntegrity;
      try { verdict = verifyBackupArtifacts(manifest, this.#backupDir); }
      catch { verdict = { state: "invalid", reason: "manifest_unverifiable" }; }
      integrity[manifest.id] = verdict;
      return verdict.state === "verified" ? manifest : { ...manifest, state: "incomplete" as const, reason: verdict.reason };
    });
    return { manifests, integrity };
  }

  /**
   * Reads one backup manifest and verifies its managed files (location, type,
   * size, SHA-256, native contract) without parsing them or activating
   * workers. Missing or corrupt files present the backup as `incomplete` with
   * `integrity.state: "invalid"`.
   */
  backup(actor: OwnerActor, id: string): { manifest: BackupManifest; integrity: BackupIntegrity } {
    const manifest = this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return readBackupManifest(tx, id);
    });
    const integrity = verifyBackupArtifacts(manifest, this.#backupDir);
    return integrity.state === "verified"
      ? { manifest, integrity }
      : { manifest: { ...manifest, state: "incomplete", reason: integrity.reason }, integrity };
  }

  #priorBackupReceipt(tx: AppTransaction, command: BackupCommand, payloadHash: string): BackupReceipt | null {
    const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
    if (!prior) return null;
    if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
    return JSON.parse(prior.result_json) as BackupReceipt;
  }

  /**
   * backup.prune: removes the oldest inventory rows inside one transaction and
   * deletes their files only after that transaction commits.
   */
  #pruneBackups(actor: OwnerActor, command: PruneBackupsCommand): BackupReceipt {
    const payloadHash = digest(backupIdentity(command));
    let victims: string[] = [];
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = this.#priorBackupReceipt(tx, command, payloadHash);
      if (prior) return prior;
      const now = this.#now();
      const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
      if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      const selected = selectRetentionVictims(tx, this.#backupDir, null, command.payload.keep);
      victims = selected.files;
      this.#beforeCommit?.("backup");
      const receipt: BackupReceipt = {
        manifest: {
          contract: "ops.backup_manifest/v1", id: "prune", createdAt: now, appSchema: tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version, jitVersion: this.#jitVersion,
          appRevision: revision, projects: [], sourceGenerations: [],
          inventory: { complete: true, projects: { total: 0, recorded: 0 }, sources: { total: 0, recorded: 0 } },
          lifecycle: { available: true, checkpoint: null, reason: null },
          native: { state: "valid", refs: [], bytes: 0, engine: null, reason: null, contract: null, formatVersion: null, artifacts: [] },
          content: { bytes: 0, hash: "", projects: 0, sources: 0 },
          retention: { maxBackups: backupRetention.maxBackups, maxBytes: backupRetention.maxBytes, pruned: selected.pruned },
          credentials: { included: false, excludedTables: [], scrubbed: [], restore: "owner_credential_setup_required" },
          state: "valid", reason: null, artifact: { path: "", bytes: 0, hash: "" },
        },
        duplicate: false,
      };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
    removeManagedFiles(victims);
    return result;
  }

  /** backup.create — staged ops.backup_manifest/v1 creation through {@link stageManagedBackup}. */
  async #createBackup(actor: OwnerActor, command: CreateBackupCommand): Promise<BackupReceipt> {
    const payloadHash = digest(backupIdentity(command));
    return stageManagedBackup<BackupReceipt>({
      store: this.store, backupDir: this.#backupDir, port: this.#nativeSnapshot, jitVersion: this.#jitVersion,
      now: this.#now, inflight: this.#stagingBackups,
      guard: (tx, phase) => {
        this.#requireOwner(tx, actor);
        const prior = this.#priorBackupReceipt(tx, command, payloadHash);
        if (prior) return prior;
        if (phase === "capture") {
          const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
          if (revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
        }
        return null;
      },
      beforeCommit: () => this.#beforeCommit?.("backup"),
      record: (tx, manifest, now) => {
        const receipt: BackupReceipt = { manifest, duplicate: false };
        tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
        tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
        this.#beforeCommit?.("receipt");
        return receipt;
      },
    });
  }

  #setPreferences(actor: OwnerActor, command: SetPreferencesCommand): PreferencesReceipt {
    const payloadHash = preferencesIdentity(command);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as PreferencesReceipt;
      }
      const now = this.#now();
      const result: PreferencesReceipt = { preferences: writePreferences(tx, command, now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      return result;
    });
  }

  /** app.local_api/v1: the only writer of the loopback API setting. Revisioned, idempotent by request id and audited. */
  #setLocalApi(actor: OwnerActor, command: SetLocalApiCommand): LocalApiReceipt {
    const payloadHash = localApiIdentity(command);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as LocalApiReceipt;
      }
      const now = this.#now();
      const result: LocalApiReceipt = { localApi: writeLocalApi(tx, command, now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      return result;
    });
  }

  /**
   * delivery.attention_levels/v1: the only writer of a channel's notification level. Revisioned per channel,
   * idempotent by request id and audited. It never touches an intent that already exists.
   */
  #setAttention(actor: OwnerActor, command: SetAttentionCommand): AttentionReceipt {
    const payloadHash = attentionIdentity(command);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as AttentionReceipt;
      }
      const now = this.#now();
      const result: AttentionReceipt = { attention: writeAttentionLevel(tx, command, now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      return result;
    });
  }

  /** app.persona/v1: the only writer of the persona. Revisioned, idempotent by request id and audited. */
  #setPersona(actor: OwnerActor, command: SetPersonaCommand): PersonaReceipt {
    const payloadHash = personaIdentity(command);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const receipt = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(receipt.result_json) as PersonaReceipt;
      }
      const now = this.#now();
      const result: PersonaReceipt = { persona: writePersona(tx, command, now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      return result;
    });
  }

  /** app.dispatch_allowance/v1: the only writer of a project's allowance. Revisioned, idempotent by request id and audited. */
  #setAllowance(actor: OwnerActor, command: SetDispatchAllowanceCommand): DispatchAllowanceReceipt {
    const payloadHash = digest(allowanceIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as DispatchAllowanceReceipt; }
      const now = this.#now();
      const result: DispatchAllowanceReceipt = { allowance: writeDispatchAllowance(tx, command, this.config, now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      return result;
    });
  }

  /**
   * app.schedule_feed/v1: the only writer of the feed. Revisioned, idempotent by request id and audited. The
   * receipt row stores `url: null`; the minted URL is returned once, from the transaction that stored its hash.
   */
  #feedCommand(actor: OwnerActor, command: FeedCommand): FeedReceipt {
    const payloadHash = digest(feedIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as FeedReceipt; }
      const now = this.#now();
      const token = command.kind === "feed.create" || command.kind === "feed.rotate" ? mintFeedToken() : "";
      const feed = writeScheduleFeed(tx, command, token, now);
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify({ feed, url: null } satisfies FeedReceipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      return { feed, url: token ? `${this.config.origin}${feedPath(token)}` : null };
    });
  }

  /**
   * app.access_level/v1: the only writer of access levels, role overrides and the kill switch. Accepted from `web`,
   * `telegram` and local API owner actors; widening and resume are refused for every channel but `web`
   * (exec/access.ts), and the local API counts as `local-api`, never `web`. Revisioned,
   * idempotent by request id (a replay returns the first receipt) and audited in the state transaction.
   */
  #accessCommand(actor: OwnerActor, command: AccessCommand): AccessReceipt {
    const payloadHash = digest(accessCommandIdentity(command));
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as AccessReceipt; }
      const now = this.#now();
      let halt: HaltOutcome | undefined;
      const channel = this.#commandChannel(actor);
      let narrowed: string[] = [];
      if (command.kind === "access.level.set") writeAccessLevel(tx, command, channel, this.config, now);
      else if (command.kind === "access.role.restrict") writeRoleRestriction(tx, command, channel, now);
      else if (command.kind === "execution.resume") writeResume(tx, command, channel, now);
      else { writeHalt(tx, command, channel, now); halt = this.#haltExecution(tx, command, now); }
      // exec.run_tools/v1: a narrower level fences running attempts granted more than their role now has.
      if (command.kind === "access.level.set" || command.kind === "access.role.restrict") narrowed = fenceNarrowedExecution(tx, command.projectId, now);
      const result: AccessReceipt = { access: readProjectAccess(tx, command.projectId, this.config), roles: readRoleAccess(tx, command.projectId), ...(halt ? { halt } : {}),
        ...(narrowed.length ? { narrowed: { fencedJobIds: narrowed } } : {}) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
    // Abort transports of attempts the halt or a narrowing fenced only after the fence committed.
    if (command.kind === "execution.halt" || result.narrowed) this.#jobs?.cancelFenced();
    // app.approval_cards/v1: host work of an approved effect stops once its role no longer has `full`.
    this.#effects?.accessChanged(command.projectId);
    // exec.browser/v1: the kill switch or a level below workspace closes the project's CDP stream.
    this.#browser?.accessChanged(command.projectId);
    // exec.box_runtime/v1: the kill switch stops the box; a narrower level stops a box running wider. Both after commit.
    if (this.#boxes) {
      const boxes = this.#boxes;
      void (command.kind === "execution.halt" ? boxes.accessChanged(command.projectId).then(() => boxes.stop(command.projectId)) : boxes.accessChanged(command.projectId))
        .catch(() => { /* The box stays fenced: every open re-checks the access level in its own transaction. */ });
    }
    return result;
  }

  /** app.connections/v1: every connection's metadata, never a value. Web only. */
  connections(actor: OwnerActor): ConnectionView[] {
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); requireConnectionChannel(this.#commandChannel(actor)); return readConnections(tx); });
  }

  /**
   * app.connections/v1 owner commands: Web only (`connection_requires_web` for Telegram and the local API), committed
   * with a receipt and audit row in the state transaction. A receipt never contains a value, and the receipt identity of
   * a secret-bearing command never includes one.
   */
  #connectionCommand(actor: OwnerActor, command: ConnectionCommand): ConnectionReceipt {
    const payloadHash = digest(connectionCommandIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as ConnectionReceipt; }
      const channel = this.#commandChannel(actor);
      requireConnectionChannel(channel);
      if (!this.#connections) throw new AppError("connection_vault_not_configured", 503);
      const now = this.#now();
      const result = applyConnectionCommand(tx, this.#connections, command, channel, now);
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  /**
   * exec.run_tools/v1 read API (for EXE04, EXE09 and EXE15): the project's recent audited execution tool calls, newest
   * first and bounded (at most 100 per page; `before` pages by sequence, `runId` narrows to one run). Subjects are the
   * redacted first 2 KiB of a command or path; output is never stored. Any authenticated owner channel may read it.
   */
  toolCalls(actor: OwnerActor, projectId: string, options: { before?: number; limit?: number; runId?: string } = {}): ToolCallView[] {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readToolCalls(tx, projectId, options); });
  }

  /**
   * app.approval_cards/v1, app.auto_approve/v1 and effect targets. `approval.decide` is accepted from Web for every
   * card and from Telegram for single-action cards only (`approval_requires_web` otherwise, including the local API);
   * it is bound to the card's revision and digest and is single use. Rules and targets are Web only
   * (`approval_rule_requires_web`). Each command commits a receipt and audit row in its transaction; an approval moves
   * the card to `executing` there, and the executor runs it once after commit (a replayed request never runs it again).
   */
  #approvalCommand(actor: OwnerActor, command: ApprovalCommand): ApprovalReceipt {
    const payloadHash = digest(approvalCommandIdentity(command));
    let replay = false;
    // A decision on an expired card is refused and rolled back, so the expiry is recorded in its own transaction first.
    if (command.kind === "approval.decide") this.store.transaction(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId); expireCards(tx, command.projectId, this.#now()); });
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); replay = true; return JSON.parse(prior.result_json) as ApprovalReceipt; }
      const now = this.#now(), channel = this.#commandChannel(actor);
      let receipt: ApprovalReceipt;
      if (command.kind === "approval.decide") receipt = { card: decideCard(tx, command, channel, now, { executor: !!this.#effects }) };
      else if (command.kind === "approval.rule.set") receipt = { rule: writeAutoApproveRule(tx, command, channel, now) };
      else { requireApprovalConfigChannel(channel); receipt = { target: writeEffectTarget(tx, command, now) }; }
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
    if (!replay && result.card?.state === "executing") void this.#effects?.run(command.projectId, result.card.id).catch(() => undefined);
    // exec.browser/v1, exec.computer/v1: a denied confirm card releases the page it was holding (and any password).
    if (!replay && result.card?.state === "denied" && (result.card.kind === "browser_confirm" || result.card.kind === "computer_confirm")) this.#browser?.settleCard(command.projectId, result.card.id);
    return result;
  }

  /**
   * app.mcp_servers/v1 owner commands. `mcp.install.accept` and `mcp.install.revise` are Web only
   * (`mcp_install_requires_web` for Telegram and the local API); reject and remove only take power away and are also
   * accepted from Telegram. Each commits a receipt and audit row; an accepted server is handed to the installer after
   * commit (a replay never installs again).
   */
  #mcpCommand(actor: OwnerActor, command: McpCommand): McpReceipt {
    const payloadHash = digest(mcpCommandIdentity(command));
    let replay = false;
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); replay = true; return JSON.parse(prior.result_json) as McpReceipt; }
      const now = this.#now();
      const receipt = applyMcpCommand(tx, command, this.#commandChannel(actor), now);
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
    if (!replay && command.kind === "mcp.install.accept" && result.server) void this.#mcp?.install(command.projectId, result.server.id).catch(() => undefined);
    // A removed server stops at once: its live connections close, so no running run can call it again.
    if (!replay && command.kind === "mcp.server.remove") this.#mcp?.serverRemoved(command.payload.serverId);
    return result;
  }

  /**
   * app.takeover/v1 `takeover.start` / `takeover.end`: Web only (`takeover_requires_web` for Telegram and the local
   * API), revisioned, with a receipt and audit row. While a takeover is active every agent browser and computer call
   * fails `takeover_active`.
   */
  #takeoverCommand(actor: OwnerActor, command: TakeoverCommand): TakeoverReceipt {
    const payloadHash = digest(takeoverCommandIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as TakeoverReceipt; }
      const now = this.#now();
      const receipt: TakeoverReceipt = { takeover: applyTakeoverCommand(tx, command, this.#commandChannel(actor), now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
  }

  /**
   * app.takeover/v1 owner input (`takeover.click`, `takeover.type`, `takeover.key`): Web only, for the active takeover
   * it names. The receipt commits first, so a replayed request id never sends the input twice; the input then goes to
   * the box's virtual display with `xdotool`.
   */
  async #takeoverInputCommand(actor: OwnerActor, command: TakeoverInputCommand): Promise<TakeoverInputReceipt> {
    const payloadHash = digest(takeoverCommandIdentity(command));
    let replay = false, input: ReturnType<typeof takeoverInput> | null = null;
    const receipt = this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); replay = true; return JSON.parse(prior.result_json) as TakeoverInputReceipt; }
      input = takeoverInput(tx, command, this.#commandChannel(actor));
      if (!this.#browser) throw new AppError("browser_unavailable", 503);
      const now = this.#now();
      const result: TakeoverInputReceipt = { takeover: readTakeover(tx, command.projectId), input: input.kind };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return result;
    });
    if (!replay && input) await this.#browser!.desktopInput(command.projectId, null, input, "owner");
    return receipt;
  }

  /**
   * exec.computer/v1 `computer.settings.set`: turns `computer.confirmEveryAction` on or off. Web only in both directions
   * (`computer_setting_requires_web` for Telegram and the local API), revisioned, with a receipt and audit row.
   */
  #computerCommand(actor: OwnerActor, command: SetComputerSettingsCommand): ComputerSettingsReceipt {
    const payloadHash = digest(computerCommandIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as ComputerSettingsReceipt; }
      const now = this.#now();
      const receipt: ComputerSettingsReceipt = { computer: writeComputerSettings(tx, command, this.#commandChannel(actor), now) };
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
  }

  /** exec.computer/v1 read model: the project's `computer.confirmEveryAction` (on until the owner turns it off in Web). */
  computerSettings(actor: OwnerActor, projectId: string): ComputerSettings {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readComputerSettings(tx, projectId); });
  }

  /** app.takeover/v1 read model: whether the owner holds a takeover of the project's box. */
  takeover(actor: OwnerActor, projectId: string): TakeoverView {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readTakeover(tx, projectId); });
  }

  /** exec.browser/v1 read API (for EXE15): the project's stored screenshots, newest first. Web only; metadata never holds a URL. */
  boxScreenshots(actor: OwnerActor, projectId: string): ScreenshotMeta[] {
    requireId(projectId);
    this.store.read(tx => { this.#requireOwner(tx, actor, ["web"]); this.#project(tx, projectId); });
    return this.#browser?.screenshots.list(projectId) ?? [];
  }

  /** One stored screenshot (`screenshot_not_found`, 404). Web only. */
  boxScreenshot(actor: OwnerActor, projectId: string, screenshotId: string): { meta: ScreenshotMeta; data: Uint8Array } {
    requireId(projectId); requireId(screenshotId);
    this.store.read(tx => { this.#requireOwner(tx, actor, ["web"]); this.#project(tx, projectId); });
    const found = this.#browser?.screenshots.get(projectId, screenshotId);
    if (!found) throw new AppError("screenshot_not_found", 404);
    return found;
  }

  /** Captures the box's whole virtual display for the owner's live view. Web only (the local API is refused). */
  async captureBoxScreen(actor: OwnerActor, projectId: string): Promise<ScreenshotMeta> {
    requireId(projectId);
    this.store.read(tx => { this.#requireOwner(tx, actor, ["web"]); this.#project(tx, projectId); requireTakeoverChannel(this.#commandChannel(actor)); });
    if (!this.#browser) throw new AppError("browser_unavailable", 503);
    return this.#browser.captureDesktop(projectId, null, "owner");
  }

  /** app.mcp_servers/v1 read model: the project's MCP install proposals, newest first (at most 50). */
  mcpProposals(actor: OwnerActor, projectId: string): McpProposalView[] {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readMcpProposals(tx, projectId); });
  }

  /** app.mcp_servers/v1 read model: the project's MCP servers (not removed), with their latest tool listing. Never a value. */
  mcpServers(actor: OwnerActor, projectId: string): McpServerView[] {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readMcpServers(tx, projectId); });
  }

  /** app.approval_cards/v1 read model: the project's cards, newest first (at most 100), with lazy expiry. */
  approvalCards(actor: OwnerActor, projectId: string, options: { state?: CardState; limit?: number; topicId?: string } = {}): ApprovalCard[] {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readCards(tx, projectId, { ...options, now: this.#now() }); });
  }

  /**
   * web.approval_cards/v1 topic read: every card of one topic, oldest first. Pending cards of the
   * topic are always included no matter how many newer cards other topics hold; pages of 100 keep
   * the query bounded (a topic realistically never holds that many cards).
   */
  topicApprovalCards(actor: OwnerActor, projectId: string, topicId: string): ApprovalCard[] {
    requireId(projectId); requireId(topicId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId);
      const now = this.#now(), seen = new Set<string>(), cards: ApprovalCard[] = [];
      for (const page of readCards(tx, projectId, { topicId, limit: 100, now })) {
        if (seen.has(page.id)) continue;
        seen.add(page.id); cards.push(page);
      }
      for (const page of readCards(tx, projectId, { topicId, state: "pending", limit: 100, now })) {
        if (seen.has(page.id)) continue;
        seen.add(page.id); cards.push(page);
      }
      return cards.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    });
  }

  /** One approval card of the project (`approval_card_not_found`), with lazy expiry. */
  approvalCard(actor: OwnerActor, projectId: string, cardId: string): ApprovalCard {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return readCard(tx, projectId, cardId, this.#now()); });
  }

  /** app.auto_approve/v1 rules and the owner-named effect targets of a project. Metadata only, never a credential. */
  effectSettings(actor: OwnerActor, projectId: string): { rules: AutoApproveRule[]; remotes: GitRemote[]; deploys: DeployTarget[] } {
    requireId(projectId);
    return this.store.read(tx => { this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId); return { rules: readAutoApproveRules(tx, projectId), ...readEffectTargets(tx, projectId) }; });
  }

  /** exec.box_runtime/v1: the project's box reset revision and whether a box is held or busy in this process. */
  boxStatus(actor: OwnerActor, projectId: string): BoxView {
    requireId(projectId);
    return this.store.read(tx => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, projectId);
      return { projectId, ...readBoxResets(tx, projectId), holding: this.#boxes?.holding().includes(projectId) ?? false,
        busy: executionAttemptAdmitted(tx, projectId) || (this.#boxes?.busy(projectId) ?? false) };
    });
  }

  /**
   * exec.box_runtime/v1 `execution.box.reset`: Web only — the Telegram channel and the local API (`local-api`) are
   * `box_reset_requires_web` (403). Validates the revision and refuses `box_busy` while an execution attempt of the
   * project is admitted or the box is in use, removes the box (and with `wipeWorkspace` its workspace) through the
   * manager, then commits the reset revision, receipt and audit row while the manager still holds the reset, so no
   * execution job of the project is admitted in between. A failed reset commits nothing, so the same request id can be
   * retried; a replay of a committed request returns its first receipt.
   */
  async #boxResetCommand(actor: OwnerActor, command: ResetBoxCommand): Promise<BoxResetReceipt> {
    const payloadHash = digest(boxCommandIdentity(command));
    const check = (tx: AppTransaction): BoxResetReceipt | null => {
      this.#requireOwner(tx, actor, ["web", "telegram"]); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as BoxResetReceipt; }
      if (this.#commandChannel(actor) !== "web") throw new AppError("box_reset_requires_web", 403);
      if (readBoxResets(tx, command.projectId).revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (executionAttemptAdmitted(tx, command.projectId)) throw new AppError("box_busy", 409);
      return null;
    };
    const replay = this.store.read(check);
    if (replay) return replay;
    if (!this.#boxes) throw new AppError("box_not_configured", 503);
    // The manager holds the reset — no admission, no open — until the receipt below has committed.
    const receipt = await this.#boxes.reset(command.projectId, command.payload.wipeWorkspace, {
      before: () => this.store.read(tx => { if (executionAttemptAdmitted(tx, command.projectId)) throw new AppError("box_busy", 409); }),
      commit: () => this.store.transaction(tx => {
        const raced = check(tx);
        if (raced) return raced;
        const now = this.#now();
        writeBoxReset(tx, command, "web", now);
        const result: BoxResetReceipt = { box: { projectId: command.projectId, ...readBoxResets(tx, command.projectId), holding: false, busy: false } };
        tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), now);
        tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
        this.#beforeCommit?.("receipt");
        return result;
      }),
    });
    // exec.browser/v1: screenshots of the box before the reset are forgotten with it.
    this.#browser?.screenshots.clear(command.projectId);
    return receipt;
  }

  /**
   * The channel an access command is attributed to. The app.local_api/v1 listener's actor carries `channel: "web"`
   * for ordinary commands, but it is a script on the host, not the owner in Web: for app.access_level/v1 it is the
   * `local-api` channel, so it may narrow and halt but never widen or resume.
   */
  #commandChannel(actor: OwnerActor): string {
    return this.#actors.get(actor)?.startsWith(localApiKeyPrefix) ? "local-api" : actor.channel;
  }

  /**
   * The kill switch's effects inside the halt transaction: fences every execution-capable job of the project (no
   * scheduler needed), then — when this process owns a live scheduler — stops every team discussion, Jit reply and
   * coordinator synthesis of the project that is still queued, running or waiting, through `team.stop_all`,
   * `jit.reply.stop` and the synthesis job's own `job.stop` (its projection reads `cancelled` from the job).
   */
  #haltExecution(tx: AppTransaction, command: HaltExecutionCommand, now: number): HaltOutcome {
    const projectId = command.projectId;
    const outcome: HaltOutcome = { fencedJobIds: stopExecutionJobs(tx, projectId, now), stoppedReplyIds: [], stoppedDiscussionIds: [], stoppedSynthesisIds: [] };
    const queue = this.#jobs;
    if (!queue?.available(tx)) return outcome;
    const generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
    const discussions = new Set<string>();
    for (const row of tx.all<{ record_json: string }>(`SELECT t.record_json FROM team_runs t JOIN jobs j ON j.id = t.job_id
      WHERE t.project_id = ? AND j.state IN ('queued', 'admitted', 'waiting') ORDER BY t.sequence`, projectId)) {
      const record = JSON.parse(row.record_json) as { kind?: string; id: string; discussionId?: string };
      if (record.kind === "discussion") discussions.add(record.id);
      else if (record.kind === "specialist" && record.discussionId) discussions.add(record.discussionId);
    }
    for (const discussionId of discussions) {
      const discussion = readDiscussion(tx, projectId, discussionId);
      prepareStopAll(tx, { kind: "team.stop_all", requestId: command.requestId, projectId, expectedRevision: discussion.revision, payload: { discussionId } }, queue, generation, now);
      outcome.stoppedDiscussionIds.push(discussionId);
    }
    // After the discussions: stop-all already stopped their team replies.
    for (const row of tx.all<{ id: string }>(`SELECT r.id FROM jit_replies r JOIN team_runs t ON t.id = r.run_id JOIN jobs j ON j.id = t.job_id
      WHERE r.project_id = ? AND j.state IN ('queued', 'admitted', 'waiting') ORDER BY r.cursor`, projectId)) {
      const reply = readReply(tx, projectId, row.id);
      if (reply.state !== "thinking" && reply.state !== "queued" && reply.state !== "blocked") continue;
      stopReply(tx, { kind: "jit.reply.stop", requestId: command.requestId, projectId, expectedRevision: reply.revision, payload: { replyId: reply.id } }, queue, generation, now);
      outcome.stoppedReplyIds.push(reply.id);
    }
    // Coordinator synthesis has no team_runs row; its job is fenced like an owner stop from the job page.
    for (const row of tx.all<{ id: string; jobId: string }>(`SELECT s.id, s.job_id AS jobId FROM coordinator_syntheses s JOIN jobs j ON j.id = s.job_id
      WHERE s.project_id = ? AND j.state IN ('queued', 'admitted', 'waiting') ORDER BY s.created_at, s.id`, projectId)) {
      const job = readJob(tx, projectId, row.jobId);
      queue.execute(tx, { kind: "job.stop", requestId: command.requestId, projectId, expectedRevision: job.revision, payload: { jobId: job.id } }, generation, now);
      outcome.stoppedSynthesisIds.push(row.id);
    }
    return outcome;
  }

  /** app.dispatch_allowance/v1: owner accept, dismiss or answer-now on a dispatch proposal card. */
  #dispatchCommand(actor: OwnerActor, command: DispatchCommand): DispatchReceipt {
    const payloadHash = digest(dispatchIdentity(command, this.config));
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as DispatchReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      if (command.kind !== "dispatch.proposal.dismiss") {
        const topic = tx.get<{ topicId: string }>("SELECT topic_id AS topicId FROM dispatch_proposals WHERE project_id = ? AND id = ?", command.projectId, command.payload?.proposalId);
        if (topic) requireTopicOpen(tx, command.projectId, topic.topicId);
      }
      const receipt = executeDispatchCommand(tx, command, this.config, this.#jobs, generation, now);
      this.#beforeCommit?.("team");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /**
   * app.setup/v1: one setup step as one owner command. The step's configuration writes (preferences, route,
   * coordinator, persona, General space, greeting, check job admission), the setup row, receipt and audit commit
   * together, so an interrupted step leaves nothing behind and can simply be submitted again.
   */
  #setupCommand(actor: OwnerActor, command: SetupCommand): SetupReceipt {
    const payloadHash = setupIdentity(command);
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as SetupReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const receipt = applySetup(tx, command, { config: this.config, queue: this.#jobs, generation, now });
      this.#beforeCommit?.("setup");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)", command.kind, command.requestId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /** app.jit_reply/v1: stops one running reply through its job fence; the late result can no longer commit. */
  /** `team.stop_all`, then delivery.attention_levels/v1: stopping the team answers every waiting notice of its group. */
  #stopAll(tx: AppTransaction, command: Extract<TeamCommand, { kind: "team.stop_all" }>, generation: number, now: number): TeamReceipt {
    const receipt = prepareStopAll(tx, command, this.#jobs, generation, now);
    evaluateWorkGroup(tx, receipt.discussion?.workGroupId, this.config.team, now, "owner_answered");
    return receipt;
  }

  #stopReply(actor: OwnerActor, command: StopReplyCommand): ReplyReceipt {
    const payloadHash = digest(stopReplyIdentity(command));
    const result = this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as ReplyReceipt; }
      const now = this.#now(), generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      const receipt = stopReply(tx, command, this.#jobs, generation, now);
      // delivery.attention_levels/v1: stopping a waiting team reply answers its notice in this transaction.
      evaluateWorkGroup(tx, workGroupOfJob(tx, command.projectId, receipt.reply.jobId!), this.config.team, now, "owner_answered");
      this.#beforeCommit?.("job");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
    this.#jobs?.cancelFenced();
    return result;
  }

  /**
   * app.role_proposals/v1: the owner's accept, edit or dismiss of one Jit role proposal. Accept writes the role
   * through `role.save` in this transaction, under this command's single receipt and audit entry.
   */
  /**
   * app.topic_promotion/v1: accept, edit or dismiss one promotion proposal revision. Accept commits the new project, its
   * topic, the identity-only link and the read-only mark on the origin with the receipt and audit, or none of them.
   */
  #promotionCommand(actor: OwnerActor, command: PromotionCommand): PromotionReceipt {
    const payloadHash = digest(promotionIdentity(command));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as PromotionReceipt; }
      const now = this.#now();
      const receipt = executePromotion(tx, command, now);
      // delivery.attention_levels/v1: the promoted origin is read-only, so its waiting card notices resolve here.
      if (receipt.promotion) evaluateTopicWorkGroups(tx, receipt.proposal.projectId, receipt.proposal.topicId, this.config.team, now, "owner_answered");
      this.#beforeCommit?.("project");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
  }

  #roleProposalCommand(actor: OwnerActor, command: RoleProposalCommand): RoleProposalReceipt {
    const payloadHash = digest(roleProposalIdentity(command, this.config.team));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor); this.#project(tx, command.projectId);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) { if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as RoleProposalReceipt; }
      const now = this.#now();
      const receipt = executeRoleProposal(tx, command, this.config.team, now);
      this.#beforeCommit?.("team");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(receipt), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, command.projectId, now);
      this.#beforeCommit?.("receipt");
      return receipt;
    });
  }

  #renameProject(actor: OwnerActor, command: RenameProjectCommand): ProjectReceipt {
    if (typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
        !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
        !command.payload || Object.keys(command.payload).join(",") !== "name" ||
        typeof command.payload.name !== "string" || command.payload.name.trim().length < 1 ||
        command.payload.name.trim().length > 200) throw new AppError("invalid_project_command");
    requireId(command.projectId);
    const name = command.payload.name.trim();
    const payloadHash = digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, name]));
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as ProjectReceipt;
      }
      const project = this.#project(tx, command.projectId);
      if (readGeneralSpace(tx)?.projectId === project.id) throw new AppError("general_space_rename_refused", 409);
      if (project.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (name !== project.name) {
        tx.run("UPDATE projects SET name = ?, revision = revision + 1 WHERE id = ?", name, project.id);
        tx.run("UPDATE app_state SET revision = revision + 1 WHERE id = 1");
      }
      const result: ProjectReceipt = { project: this.#project(tx, project.id), workspaceRevision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision };
      this.#beforeCommit?.("project");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), this.#now());
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, ?, ?)", command.kind, command.requestId, project.id, this.#now());
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
    if (key.startsWith(localApiKeyPrefix)) {
      // app.local_api/v1: the listener's actor lives exactly as long as the setting revision and owner generation it was issued for.
      const [generation, revision] = key.slice(localApiKeyPrefix.length).split(":").map(Number);
      const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
      const settings = readLocalApi(tx);
      if (!owner || owner.generation !== generation || !settings.enabled || settings.revision !== revision) throw new AppError("authentication_required", 401);
      return;
    }
    const row = tx.get<{ token_hash: string }>(`SELECT s.token_hash FROM sessions s JOIN owner o ON o.id = s.owner_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.generation = o.generation`, key, this.#now());
    if (!row) throw new AppError("authentication_required", 401);
  }

  #project(tx: AppTransaction, projectId: string, includeDeleted = false): Project {
    if (!includeDeleted) requireLiveProject(tx, projectId);
    const project = tx.get<Project>(`SELECT p.id, p.name, p.revision, g.id AS groupId, p.created_at AS createdAt
      FROM projects p JOIN project_groups g ON g.project_id = p.id WHERE p.id = ?`, projectId);
    if (!project) throw new AppError("project_not_found", 404);
    return project;
  }

  #requireOwner(tx: AppTransaction, actor: OwnerActor, channels: readonly TaskChannel[] = ["web"], restoreGate = true): string {
    const key = actor && this.#actors.get(actor);
    if (!key) throw new AppError("authentication_required", 401);
    this.#session(tx, key);
    if (!channels.includes(actor.channel)) throw new AppError("channel_not_authorized", 403);
    // ops.quarantined_restore/v1: from activation intent until the restore is complete, every read model and
    // command except restore status/remediation is refused (one durable predicate, `<db>.restore-pending`).
    if (restoreGate && readRestoreGate(this.store.path)) throw new AppError("restore_incomplete", 423);
    return key;
  }
}

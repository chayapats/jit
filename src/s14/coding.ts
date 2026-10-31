import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { registerSecretFingerprint, redactRegisteredSecrets } from "../security/secret-fingerprints";
import { containsCredential, redactCredentials } from "../security/credentials";
import { record, type S14Application } from "./application";
import type { Attempt, ScopePolicy, ScopeRef, WorkOutput } from "./authority-types";
import { artifactHash } from "./artifacts";
import { canonical, digest, exact, identity, text } from "./validation";
import { codingCheck, codingCommit, codingGit, codingGitOutput, codingOrigin, codingPath, codingQuote, codingRegistry } from "./coding-protocol";
import { codingEvidenceCheckout, codingSnapshot } from "./coding-evidence";
import { repositoryBundle } from "./coding-preload";
import { privateRepositoryCommit, repositoryCommit } from "./coding-resolve";
import { resourceConfigured, resourceSlotConflict } from "./share-slots";
import { gitConnection } from "./coding-connections";
import { codingModel } from "./coding-model";
import type { ComputerSession } from "./computer-types";
import type { Bot, OwnerActor } from "./types";
import type { CodingCheck, CodingCheckResult, CodingCommand, CodingJob, CodingOptions, CodingReceipt, CodingRepository, CodingRepositoryGrant, CodingRun, CodingView } from "./coding-types";

const parse = <T>(row: { record_json: string } | null): T | null => row ? JSON.parse(row.record_json) as T : null;
const clip = (value: string) => redactRegisteredSecrets(redactCredentials(value)).slice(0, 2000);

/** Repository grants and real execution evidence stay inside the existing owner/Bot/work/computer barriers. */
export class S14Coding {
  #resolved = new WeakMap<object, string>();
  constructor(readonly app: S14Application, readonly options: CodingOptions = {}) {}

  /** Supplies only exact current typed repository policies to the ordinary resource intersection. */
  scope(tx: AppTransaction, ref: ScopeRef): ScopePolicy | null {
    const repository = parse<CodingRepository>(tx.get("SELECT record_json FROM coding_repositories WHERE id=?", ref.id));
    if (!repository) return null;
    return { ref: { kind: "resource", id: repository.id, revision: repository.revision },
      active: ref.kind === "resource" && repository.active && resourceConfigured(this.app.policy, repository.id) && !tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='coding_repository' AND id=?", repository.id),
      ownerBotId: repository.botId, receiverBotId: null, workId: null, tools: ["computer", "coding", "effect_push"],
      snapshot: { id: repository.id, revision: repository.revision, hash: digest(canonical(repository)) } };
  }

  private grantBot(tx: AppTransaction, command: CodingRepositoryGrant): Bot {
    const p = command.payload;
    exact(p, ["id", "botId", "url", "baseBranch" in p ? "baseBranch" : "baseCommit", ...(Object.hasOwn(p, "registry") ? ["registry"] : []), ...(Object.hasOwn(p, "connection") ? ["connection"] : [])]);
    if (p.connection) {
      this.branchConnection(tx, p.id, p.connection);
    }
    const held = tx.get(`SELECT 1 FROM git_connections WHERE json_extract(record_json,'$.repositoryId')=?
      AND json_extract(record_json,'$.removed')=0 AND id<>? LIMIT 1`, p.id, p.connection?.id ?? "");
    if (held) throw new AppError("coding_slot_reserved", 409);
    codingRegistry(p.registry ?? null); identity(p.id); identity(p.botId); codingOrigin(p.url);
    const bot = record<Bot>(tx, "bots", p.botId);
    if (command.expectedRevision !== 0 || tx.get("SELECT 1 FROM coding_repositories WHERE id=?", p.id)) throw new AppError("stale_revision", 409);
    if (!bot.enabled || !resourceConfigured(this.app.policy, p.id) || !bot.capabilities.resources.includes(p.id) ||
        resourceSlotConflict(tx, p.id, "coding_repository", p.connection?.id) ||
        tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE id=? AND kind IN ('snapshot_share','share','coding_repository')", p.id)) throw new AppError("coding_resource_denied", 403);
    return bot;
  }

  /** Async owner ingress resolves a branch under its accepted slot, rechecks live authority and durably pins the commit; retries reuse the original receipt. */
  async execute(actor: OwnerActor, command: CodingCommand): Promise<CodingReceipt> {
    if (command.kind === "coding.repository.resolve") {
      command = structuredClone(command);
      const selected = command;
      exact(selected, ["kind", "requestId", "expectedRevision", "payload"]); identity(selected.requestId);
      const previous = this.app.store.read(tx => {
        this.app.requireOwner(tx, actor);
        return !!tx.get("SELECT 1 FROM command_receipts WHERE owner_id='owner' AND request_id=?", selected.requestId);
      });
      if (previous) return this.app.execute(actor, selected);
      const snapshot = this.app.store.read(tx => {
        this.app.requireOwner(tx, actor);
        return this.resolveSnapshot(tx, selected);
      });
      const allowed = () => this.app.store.read(tx => {
        this.app.requireOwner(tx, actor);
        if (canonical(this.resolveSnapshot(tx, selected)) !== canonical(snapshot)) throw new AppError("stale_revision", 409);
      });
      const vault = this.app.git.options.vault;
      if (!vault) throw new AppError("connection_vault_not_configured", 503);
      this.app.store.transaction(tx => tx.run("INSERT OR IGNORE INTO audit(kind,request_id,committed_at) VALUES ('coding.repository.resolve.credential',?,?)", `resolve_credential_${selected.requestId}`, this.app.now()));
      const secret = vault.read(snapshot.vaultId);
      registerSecretFingerprint(secret);
      const commit = await privateRepositoryCommit(snapshot.repository.url, selected.payload.baseBranch, secret, allowed, this.options.gitLimits);
      allowed(); this.#resolved.set(selected, commit);
      try { return this.app.execute(actor, selected); }
      finally { this.#resolved.delete(selected); }
    }
    if (command.kind !== "coding.repository.grant" || !("baseBranch" in command.payload)) return this.app.execute(actor, command);
    const branch = command.payload.baseBranch;
    command = structuredClone(command);
    exact(command, ["kind", "requestId", "expectedRevision", "payload"]); identity(command.requestId);
    const previous = this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return !!tx.get("SELECT 1 FROM command_receipts WHERE owner_id='owner' AND request_id=?", command.requestId);
    });
    if (previous) return this.app.execute(actor, command);
    // Capture the exact owner/Bot generation and revision before any remote wait. No slot is created by discovery.
    const snapshot = this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return canonical({ bot: this.grantBot(tx, command), connection: command.payload.connection ? this.branchConnection(tx, command.payload.id, command.payload.connection) : null,
        owner: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation });
    });
    const allowed = () => this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      if (canonical({ bot: this.grantBot(tx, command), connection: command.payload.connection ? this.branchConnection(tx, command.payload.id, command.payload.connection) : null,
        owner: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation }) !== snapshot) throw new AppError("stale_revision", 409);
    });
    let commit: string;
    if (command.payload.connection) {
      const { vaultId } = this.app.store.read(tx => this.branchConnection(tx, command.payload.id, command.payload.connection!));
      const vault = this.app.git.options.vault;
      if (!vault) throw new AppError("connection_vault_not_configured", 503);
      const secret = vault.read(vaultId); registerSecretFingerprint(secret);
      commit = await privateRepositoryCommit(command.payload.url, branch, secret, allowed, this.options.gitLimits);
    } else commit = await repositoryCommit(command.payload.url, branch, allowed, this.options.repositoryFetch);
    allowed();
    this.#resolved.set(command, commit);
    try { return this.app.execute(actor, command); }
    finally { this.#resolved.delete(command); }
  }

  private branchConnection(tx: AppTransaction, repositoryId: string, ref: { id: string; revision: number }) {
    exact(ref, ["id", "revision"]);
    const connection = gitConnection(tx, ref.id);
    const latest = tx.get<{ revision: number }>("SELECT max(revision) revision FROM lifecycle.git_connection_revisions WHERE connection_id=?", connection.id)?.revision;
    const vaultId = tx.get<{ vault_id: string }>("SELECT vault_id FROM git_connections WHERE id=?", connection.id)?.vault_id;
    if (connection.repositoryId !== repositoryId || connection.removed || connection.secret !== "set" ||
        connection.revision !== ref.revision || connection.revision !== latest || !vaultId) throw new AppError("connection_out_of_scope", 403);
    return { connection, vaultId };
  }

  private resolveSnapshot(tx: AppTransaction, command: Extract<CodingCommand, { kind: "coding.repository.resolve" }>) {
    exact(command.payload, ["repositoryId", "baseBranch", "connection"]);
    exact(command.payload.connection, ["id", "revision"]);
    const repository = this.repository(tx, command.payload.repositoryId);
    const bot = record<Bot>(tx, "bots", repository.botId);
    if (!repository.active || repository.revision !== command.expectedRevision || !bot.enabled ||
        !bot.capabilities.resources.includes(repository.id) || !this.scope(tx, { kind: "resource", id: repository.id, revision: repository.revision })?.active) throw new AppError("coding_resource_denied", 403);
    const { connection, vaultId } = this.branchConnection(tx, repository.id, command.payload.connection);
    return { repository, bot, route: this.app.route(bot.routeId), connection, vaultId, owner: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation };
  }

  /** Applies explicit repository grants/revocation or atomic coding start without deriving authority from source text. */
  apply(tx: AppTransaction, command: CodingCommand): CodingReceipt {
    if (command.kind === "coding.repository.resolve") {
      const { repository } = this.resolveSnapshot(tx, command);
      const commit = this.#resolved.get(command);
      if (!commit) throw new AppError("coding_branch_resolution_required", 409);
      repository.baseCommit = commit;
      repository.revision++;
      tx.run("UPDATE coding_repositories SET record_json=? WHERE id=?", canonical(repository), repository.id);
      return { kind: command.kind, requestId: command.requestId, repository };
    }
    if (command.kind === "coding.repository.grant") {
      const p = command.payload;
      this.grantBot(tx, command);
      const baseCommit = "baseCommit" in p ? p.baseCommit : this.#resolved.get(command);
      if (baseCommit === undefined) throw new AppError("coding_branch_resolution_required", 409);
      codingCommit(baseCommit);
      const repository: CodingRepository = { id: p.id, botId: p.botId, url: p.url, baseCommit, registry: structuredClone(p.registry ?? null), revision: 1, active: true };
      tx.run("INSERT INTO coding_repositories VALUES (?,?)", repository.id, canonical(repository));
      return { kind: command.kind, requestId: command.requestId, repository };
    }
    if (command.kind === "coding.repository.revoke") {
      exact(command.payload, ["repositoryId"]); identity(command.payload.repositoryId);
      const repository = this.repository(tx, command.payload.repositoryId);
      if (command.expectedRevision !== repository.revision || !repository.active) throw new AppError("stale_revision", 409);
      repository.active = false;
      repository.revision++;
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('coding_repository',?,'revoked')", repository.id);
      tx.run("UPDATE coding_repositories SET record_json=? WHERE id=?", canonical(repository), repository.id);
      return { kind: command.kind, requestId: command.requestId, repository };
    }
    if (command.kind !== "coding.start") throw new AppError("unknown_command");
    const p = command.payload;
    exact(p, ["repository", "work", "install", "tests", ...(Object.hasOwn(p, "connection") ? ["connection"] : [])]);
    exact(p.repository, ["id", "revision"]);
    const repository = this.repository(tx, p.repository.id);
    if (!repository.active || repository.revision !== p.repository.revision || !this.scope(tx, { kind: "resource", ...p.repository })?.active) throw new AppError("coding_resource_denied", 403);
    if (p.work.bots.length !== 1 || p.work.bots[0]?.id !== repository.botId ||
        !p.work.tools.includes("computer") || !p.work.tools.includes("coding") ||
        p.work.tools.some(tool => !["computer", "coding", "effect_push"].includes(tool)) ||
        canonical(p.work.scopes) !== canonical([{ kind: "resource", ...p.repository }])) throw new AppError("coding_grant_invalid", 403);
    if (p.install !== null) codingCheck(p.install);
    if (!Array.isArray(p.tests) || p.tests.length > 8) throw new AppError("coding_tests_invalid");
    p.tests.forEach(codingCheck);
    if (p.connection != null) {
      exact(p.connection, ["id", "revision"]);
      const connection = gitConnection(tx, p.connection.id);
      if (connection.repositoryId !== repository.id || connection.revision !== p.connection.revision || connection.removed || connection.secret !== "set") throw new AppError("connection_out_of_scope", 403);
    }
    const receipt = this.app.authority.apply(tx, { kind: "work.start", requestId: command.requestId, expectedRevision: command.expectedRevision, payload: p.work });
    const job: CodingJob = { workId: receipt.work!.id, repository, branch: `jit/${receipt.work!.id}`,
      path: `/workspace/coding/${receipt.work!.id}`, install: structuredClone(p.install), tests: structuredClone(p.tests), connection: structuredClone(p.connection ?? null) };
    tx.run("INSERT INTO coding_jobs VALUES (?,?)", job.workId, canonical(job));
    return { kind: command.kind, requestId: command.requestId, work: receipt.work!, grant: receipt.grant! };
  }

  private repository(tx: AppTransaction, id: string): CodingRepository {
    identity(id);
    const repository = parse<CodingRepository>(tx.get("SELECT record_json FROM coding_repositories WHERE id=?", id));
    if (!repository) throw new AppError("coding_repository_not_found", 404);
    return repository;
  }

  /** Lists credential-free repository grants without provisioning computers or accessing repository files. */
  repositories(actor: OwnerActor): CodingRepository[] {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return tx.all<{ record_json: string }>("SELECT record_json FROM coding_repositories ORDER BY id").map(row => JSON.parse(row.record_json));
    });
  }

  /** Reads a captured job only from the trusted store, never from model-supplied paths. */
  job(tx: AppTransaction, workId: string): CodingJob | null {
    return parse<CodingJob>(tx.get("SELECT record_json FROM coding_jobs WHERE work_id=?", workId));
  }

  /** Returns honest partial/reviewable execution state and immutable report references under retained authority. */
  view(actor: OwnerActor, workId: string): CodingView {
    identity(workId);
    return this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor);
      this.app.reports.reconcile(tx);
      const runs = tx.all<{ record_json: string }>("SELECT record_json FROM coding_runs WHERE work_id=? ORDER BY rowid", workId).map(row => JSON.parse(row.record_json) as CodingRun);
      const available = runs.every(run => {
        try {
          return (this.app.memory.attemptCurrent(tx, run.attemptId) || this.app.botLifecycle.retained(tx, run.attemptId)) &&
            this.app.authority.retainedEvidence(tx, run.attemptId);
        } catch { return false; }
      });
      const checks = available ? tx.all<{ attemptId: string; ordinal: number; record_json: string }>(`SELECT c.attempt_id AS attemptId,c.ordinal,c.record_json FROM coding_checks c JOIN coding_runs r ON r.attempt_id=c.attempt_id
        WHERE r.work_id=? AND (c.ordinal>=0 OR NOT EXISTS (SELECT 1 FROM coding_checks verified WHERE verified.attempt_id=c.attempt_id AND verified.ordinal=0)) ORDER BY c.rowid`, workId)
        .map(({ record_json, ...row }) => ({ ...row, result: JSON.parse(record_json) as CodingCheckResult })) : [];
      return { job: available ? this.job(tx, workId) : null, runs: runs.map(run => run.state === "reviewable" && !run.reportId ? { ...run, state: "partial", reason: "coding_evidence_not_committed" }
        : run.state === "reviewable" && run.evidenceCheckout !== "recorded-raw/v1" ? { ...run, state: "partial", reason: "coding_recorded_checkout_required" } : run), available, checks };
    });
  }

  private saveRun(run: CodingRun): void {
    this.app.store.transaction(tx => tx.run("UPDATE coding_runs SET record_json=? WHERE attempt_id=?", canonical(run), run.attemptId));
  }

  /** Links committed immutable report artifacts in the same transaction as the ordinary result commit. */
  committed(tx: AppTransaction, attemptId: string): void {
    const run = parse<CodingRun>(tx.get("SELECT record_json FROM coding_runs WHERE attempt_id=?", attemptId));
    if (!run) return;
    run.reportId = tx.get<{ id: string }>("SELECT id FROM reports WHERE attempt_id=?", attemptId)?.id ?? null;
    tx.run("UPDATE coding_runs SET record_json=? WHERE attempt_id=?", canonical(run), attemptId);
  }

  /** Fences interrupted shell work on boot without replay and erases duplicate plans after lifecycle deletion. */
  recover(tx: AppTransaction): void {
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM coding_runs WHERE json_extract(record_json,'$.state')='running'")) {
      const run = JSON.parse(row.record_json) as CodingRun;
      run.state = "interrupted";
      run.reason = "coding_interrupted_no_replay";
      tx.run("UPDATE coding_runs SET record_json=? WHERE attempt_id=?", canonical(run), run.attemptId);
    }
    this.reconcile(tx);
  }

  /** Removes duplicate plans/checks under the same deletion and evidence-withdrawal rules as their committed report. */
  reconcile(tx: AppTransaction): void {
    tx.run("DELETE FROM coding_checks WHERE attempt_id IN (SELECT attempt_id FROM attempt_payload_deletions)");
    tx.run(`DELETE FROM coding_checks WHERE attempt_id IN (
      SELECT c.attempt_id FROM coding_runs c JOIN reports r ON r.attempt_id=c.attempt_id WHERE r.content_json IS NULL
    )`);
    tx.run(`DELETE FROM coding_jobs WHERE work_id IN (
      SELECT work_id FROM work_payload_deletions
      UNION SELECT work_id FROM coding_runs WHERE attempt_id IN (SELECT attempt_id FROM attempt_payload_deletions)
    )`);
  }

  private async performCheck(attemptId: string, session: ComputerSession, command: CodingCheck, job: CodingJob, signal: AbortSignal, commit: string | null = null): Promise<CodingCheckResult> {
    if (command.network === "registry" && !job.repository.registry) return { command, commit: null, state: "skipped", exitCode: null, timedOut: false, reason: "coding_registry_scope_required", stdout: "", stderr: "" };
    try {
      const request = { cwd: job.path, command: (command.network === "registry" ? command.argv :
        ["env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", ...command.argv]).map(codingQuote).join(" "), timeoutMs: command.timeoutMs, signal };
      const allowed = () => { this.app.store.read(tx => this.app.authority.assertTool(tx, attemptId, "coding")); };
      const result = command.network === "registry" ? await session.registrySpawn(request, job.repository.registry!.hosts, allowed) : await session.backend.spawn(request);
      return { command, commit, state: result.exitCode === 0 && !result.timedOut ? "passed" : "failed", exitCode: result.exitCode,
        timedOut: result.timedOut, reason: result.timedOut ? "coding_check_timeout" : result.exitCode === 0 ? null : "coding_check_failed", stdout: clip(result.stdout), stderr: clip(result.stderr) };
    } catch (error) {
      return { command, commit: null, state: "unknown", exitCode: null, timedOut: false, reason: error instanceof AppError ? error.code : "coding_check_interrupted", stdout: "", stderr: "" };
    }
  }

  private async check(attemptId: string, ordinal: number, session: ComputerSession, command: CodingCheck, job: CodingJob, signal: AbortSignal, commit: string | null = null): Promise<CodingCheckResult> {
    const pending: CodingCheckResult = { command, commit: null, state: "unknown", exitCode: null, timedOut: false, reason: "coding_check_dispatch_unconfirmed", stdout: "", stderr: "" };
    this.app.store.transaction(tx => {
      this.app.authority.assertTool(tx, attemptId, "coding");
      tx.run("INSERT INTO coding_checks VALUES (?,?,?)", attemptId, ordinal, canonical(pending));
    });
    const clean = () => codingSnapshot(session.backend, job.path, commit!, async (_git, unchanged) => unchanged, signal);
    const result: CodingCheckResult = commit && !await clean()
      ? { command, commit: null, state: "skipped", exitCode: null, timedOut: false, reason: "coding_changed_during_tests", stdout: "", stderr: "" }
      : await this.performCheck(attemptId, session, command, job, signal, commit);
    if (commit && result.commit && !await clean()) {
      result.commit = null;
      result.state = "unknown";
      result.reason = "coding_changed_during_tests";
    }
    this.app.store.transaction(tx => tx.run("UPDATE coding_checks SET record_json=? WHERE attempt_id=? AND ordinal=?", canonical(result), attemptId, ordinal));
    return result;
  }

  private async preload(session: ComputerSession, attemptId: string, job: CodingJob, signal: AbortSignal): Promise<void> {
    const backend = session.backend;
    const allowed = () => { this.app.store.read(tx => this.app.git.assertPreload(tx, attemptId, job)); };
    const secret = this.app.git.preloadSecret(attemptId, job);
    const bundle = await repositoryBundle(job.repository, secret, signal, allowed, this.options.repositoryFetch, undefined, this.options.gitLimits);
    allowed();
    const file = `/workspace/.jit-preload-${job.workId}.bundle`;
    await backend.writeFileAtomically(file, bundle);
    try {
      codingGitOutput(await backend.spawn({ cwd: "/workspace", command: "mkdir -p -- /workspace/coding", signal, timeoutMs: 10000 }));
      if (await backend.realpath("/workspace/coding") !== "/workspace/coding") throw new AppError("coding_path_refused", 403);
      allowed();
      codingGitOutput(await codingGit(backend, "/workspace", ["-c", "protocol.file.allow=always", "clone", "--template=", "--no-local", "--no-hardlinks", "--no-checkout", "--", file, job.path], signal));
      await codingPath(backend, job.path);
      codingGitOutput(await codingGit(backend, job.path, ["remote", "remove", "origin"], signal));
      if (codingGitOutput(await codingGit(backend, job.path, ["rev-parse", "--verify", `${job.repository.baseCommit}^{commit}`], signal)).trim() !== job.repository.baseCommit) throw new AppError("coding_base_changed", 409);
      allowed();
      codingGitOutput(await codingGit(backend, job.path, ["checkout", "--no-track", "-b", job.branch, job.repository.baseCommit, "--"], signal));
    } finally {
      codingGitOutput(await backend.spawn({ cwd: "/workspace", command: `rm -f -- ${codingQuote(file)}`, timeoutMs: 10000 }));
    }
  }

  /** Executes edits, installs and tests only inside the Bot computer and stages actual immutable diff/check artifacts. */
  async run(directory: string, attempt: Attempt, signal: AbortSignal): Promise<WorkOutput> {
    const job = this.app.store.transaction(tx => {
      this.app.authority.assertTool(tx, attempt.id, "coding");
      const job = this.job(tx, attempt.workId);
      if (!job || attempt.snapshot.scopes.length !== 1 || attempt.snapshot.scopes[0]!.ref.id !== job.repository.id) throw new AppError("coding_grant_invalid", 403);
      if (tx.get("SELECT 1 FROM coding_runs WHERE work_id=?", job.workId)) throw new AppError("coding_never_replay", 409);
      const run: CodingRun = { attemptId: attempt.id, workId: attempt.workId, state: "running", reason: null,
        baseCommit: job.repository.baseCommit, headCommit: null, diffHash: null, reportId: null };
      tx.run("INSERT INTO coding_runs VALUES (?,?,?)", attempt.id, attempt.workId, canonical(run));
      return job;
    });
    const run = this.app.store.read(tx => parse<CodingRun>(tx.get("SELECT record_json FROM coding_runs WHERE attempt_id=?", attempt.id))!);
    let session: ReturnType<S14Application["computers"]["open"]> | undefined;
    try {
      await this.app.computers.prepare(attempt.id);
      session = this.app.computers.open(attempt.id);
      const backend = session.backend;
      await this.preload(session, attempt.id, job, signal);
      const checks: CodingCheckResult[] = [];
      const draftInstall = job.install ? await this.check(attempt.id, -1, session, job.install, job, signal) : null;
      let installOk = !draftInstall || draftInstall.state === "passed";
      if (installOk) await codingModel(this.app, directory, attempt, backend, job.path, signal, this.options.model);
      if (signal.aborted) throw new AppError("coding_cancelled");
      await codingPath(backend, job.path);
      codingGitOutput(await codingGit(backend, job.path, ["add", "--all", "--", "."], signal));
      codingGitOutput(await codingGit(backend, job.path, ["-c", "user.name=Jit Bot", "-c", "user.email=bot@invalid", "commit", "--allow-empty", "--no-verify", "-m", `Coding work ${job.workId}`], signal));
      run.headCommit = codingGitOutput(await codingGit(backend, job.path, ["rev-parse", "HEAD"], signal)).trim();
      codingCommit(run.headCommit);
      await codingEvidenceCheckout(backend, job.path, run.headCommit, job.branch, signal);
      run.evidenceCheckout = "recorded-raw/v1";
      if (job.install) {
        if (installOk) checks.push(await this.check(attempt.id, 0, session, job.install, job, signal, run.headCommit));
        else {
          checks.push(draftInstall!);
          this.app.store.transaction(tx => {
            this.app.authority.assertTool(tx, attempt.id, "coding");
            tx.run("INSERT INTO coding_checks VALUES (?,?,?)", attempt.id, 0, canonical(draftInstall));
          });
        }
        installOk = checks[0]!.state === "passed";
      }
      for (const command of job.tests) {
        if (installOk) checks.push(await this.check(attempt.id, checks.length, session, command, job, signal, run.headCommit));
        else {
          const result: CodingCheckResult = { command, commit: null, state: "skipped", exitCode: null, timedOut: false, reason: "coding_install_incomplete", stdout: "", stderr: "" };
          this.app.store.transaction(tx => {
            this.app.authority.assertTool(tx, attempt.id, "coding");
            tx.run("INSERT INTO coding_checks VALUES (?,?,?)", attempt.id, checks.length, canonical(result));
          });
          checks.push(result);
        }
      }
      if (signal.aborted) throw new AppError("coding_cancelled");
      const snapshot = await codingSnapshot(backend, job.path, run.headCommit, async (git, unchanged) => ({ unchanged,
        diff: await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", job.repository.baseCommit, run.headCommit!, "--"]) }), signal);
      const { diff } = snapshot;
      const unchanged = snapshot.unchanged;
      if (containsCredential(diff) || diff.includes("[credential-redacted]")) throw new AppError("coding_diff_credential_refused", 403);
      run.diffHash = artifactHash(new TextEncoder().encode(diff || "(empty diff)\n"));
      run.state = unchanged && job.tests.length > 0 && checks.every(check => check.state === "passed") ? "reviewable" : "partial";
      run.reason = !unchanged ? "coding_changed_during_tests" : !job.tests.length ? "coding_tests_not_run" : checks.find(check => check.state !== "passed")?.reason ?? null;
      const files: { name: string; mediaType: "text/plain" | "application/json"; content: string }[] = [{ name: "coding-diff.txt", mediaType: "text/plain", content: diff || "(empty diff)\n" },
        { name: "coding-checks.json", mediaType: "application/json", content: canonical({ baseCommit: run.baseCommit, headCommit: run.headCommit, evidenceCheckout: run.evidenceCheckout,
          testedHead: checks.some(check => check.commit === run.headCommit && check.state !== "skipped") ? run.headCommit : null, draftInstall,
          unchangedAfterTests: unchanged, checks, coverage: "Command output and owner-declared coverage only; no inferred measured coverage.", state: run.state, reason: run.reason }) }];
      const artifactIds = this.app.store.transaction(tx => {
        this.app.authority.guard(tx, attempt.id);
        return files.map(file => {
          const bytes = new TextEncoder().encode(file.content);
          return this.app.artifacts.stage(tx, attempt, { name: file.name, mediaType: file.mediaType, size: bytes.length, sha256: artifactHash(bytes) }, bytes).id;
        });
      });
      this.saveRun(run);
      return { state: "waiting", text: `Coding evidence: ${run.state}; base ${run.baseCommit}; head ${run.headCommit}; reason ${run.reason ?? "owner_review_required"}.`,
        report: { title: "Coding execution evidence", claims: [{ id: "execution", kind: "inference", text: "Inspect the attached service-captured diff and actual command observations; no exhaustive coverage or owner completion is asserted.", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Owner review required. No automatic push, PR or merge.", job.repository.registry ? "Only explicitly scoped registry checks may use the registry proxy; ordinary workspace/model commands have no network egress." : "Network egress is disabled; registry requirements are unrun.", "Test output is an execution observation, not proof of exhaustive coverage.", ...(run.reason ? [run.reason] : [])], artifactIds } };
    } catch (error) {
      run.state = "interrupted";
      run.reason = error instanceof AppError ? error.code : "coding_execution_unconfirmed";
      this.saveRun(run);
      throw error;
    } finally { session?.release(); }
  }
}

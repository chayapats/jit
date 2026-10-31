import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { registerSecretFingerprint } from "../security/secret-fingerprints";
import type { AppTransaction } from "../store";
import { record, save, type S14Application } from "./application";
import type { Attempt, Effect, EffectAction } from "./authority-types";
import type { CodingJob, CodingRun } from "./coding-types";
import type { Bot, OwnerActor } from "./types";
import { canonical, digest, exact, identity, integer, text } from "./validation";
import { codingCommit, codingGit, codingGitOutput, codingPath } from "./coding-protocol";
import { applyGitConnection, gitConnection } from "./coding-connections";
import { CodingGitMirror } from "./coding-git-mirror";
import { GitHubCodingRemote, gitPullUrl } from "./coding-git-remote";
import type { GitAction, GitCommand, GitConnection, GitOptions, GitProgress, GitReceipt, GitRemoteProof } from "./coding-git-types";

/** Rejects options, wildcards, ref expressions and Git path aliases in exact branch identity. */
export function gitBranch(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 120 || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value) ||
      value.includes("..") || value.includes("//") || value.endsWith("/") || value.split("/").some(part => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw new AppError("git_branch_invalid");
}

/** Exact Git effect mediation verifies approved data before releasing a scoped credential to a trusted remote broker. */
export class S14GitEffects {
  readonly remote;
  #draining: Promise<void> | null = null;
  constructor(readonly app: S14Application, readonly options: GitOptions = {}) {
    this.remote = options.remote ?? new GitHubCodingRemote();
  }

  private progress(tx: AppTransaction, effectId: string): GitProgress {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM git_effects WHERE effect_id=?", effectId);
    if (!row) throw new AppError("git_effect_not_found", 404);
    return JSON.parse(row.record_json);
  }

  private currentConnection(tx: AppTransaction, action: GitAction): GitConnection {
    const attempt = record<Attempt>(tx, "work_attempts", action.codingAttemptId);
    const bot = record<Bot>(tx, "bots", action.repository.botId);
    if (tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation !== action.ownerGeneration ||
        !bot.enabled || canonical(bot) !== canonical(attempt.snapshot.bot) ||
        canonical(this.app.route(bot.routeId)) !== canonical(attempt.snapshot.route)) throw new AppError("git_authority_changed", 403);
    const connection = gitConnection(tx, action.connection.id);
    const latest = tx.get<{ revision: number }>("SELECT max(revision) AS revision FROM lifecycle.git_connection_revisions WHERE connection_id=?", connection.id)?.revision ?? connection.revision;
    if (connection.revision !== action.connection.revision || connection.revision !== latest || connection.removed || connection.secret !== "set" ||
        connection.repositoryId !== action.repository.id || connection.kind !== "github_token") throw new AppError("connection_out_of_scope", 403);
    const scope = this.app.coding.scope(tx, { kind: "resource", id: action.repository.id, revision: action.repository.revision });
    if (!scope?.active || scope.snapshot.hash !== digest(canonical(action.repository))) throw new AppError("coding_resource_denied", 403);
    return connection;
  }

  /** Rechecks a captured preload connection at every read/import barrier; public reads never inherit a credential. */
  assertPreload(tx: AppTransaction, attemptId: string, job: CodingJob): GitConnection | null {
    this.app.authority.assertTool(tx, attemptId, "coding");
    if (!job.connection) return null;
    const connection = gitConnection(tx, job.connection.id);
    const latest = tx.get<{ revision: number }>("SELECT max(revision) AS revision FROM lifecycle.git_connection_revisions WHERE connection_id=?", connection.id)?.revision;
    if (connection.revision !== job.connection.revision || connection.revision !== latest || connection.removed || connection.secret !== "set" ||
        connection.repositoryId !== job.repository.id || connection.kind !== "github_token") throw new AppError("connection_out_of_scope", 403);
    return connection;
  }

  /** Releases a write-only credential only to the trusted preload broker, with an identity-only audit receipt. */
  preloadSecret(attemptId: string, job: CodingJob): string | undefined {
    return this.app.store.transaction(tx => {
      const connection = this.assertPreload(tx, attemptId, job);
      if (!connection) return undefined;
      if (!this.options.vault) throw new AppError("connection_vault_not_configured", 503);
      const key = tx.get<{ vault_id: string }>("SELECT vault_id FROM git_connections WHERE id=?", connection.id)?.vault_id;
      if (!key) throw new AppError("connection_unavailable", 409);
      const secret = this.options.vault.read(key);
      registerSecretFingerprint(secret);
      tx.run("INSERT INTO git_preload_releases(connection_id,attempt_id,revision,recorded_at) VALUES (?,?,?,?)", connection.id, attemptId, connection.revision, this.app.now());
      return secret;
    });
  }

  /** Applies write-only connection setup, exact proposal or read-back request under the ordinary owner transaction. */
  apply(tx: AppTransaction, command: GitCommand): GitReceipt {
    if (command.kind.startsWith("git.connection.")) {
      const result = applyGitConnection(this.app, tx, command as import("./coding-git-types").GitConnectionCommand, this.options);
      tx.run("INSERT OR IGNORE INTO lifecycle.git_connection_revisions VALUES (?,?)", result.connection!.id, result.connection!.revision);
      return result;
    }
    if (command.kind === "git.reconcile") {
      exact(command.payload, ["effectId", "actionHash"]);
      const effect = record<Effect>(tx, "effects", command.payload.effectId);
      if (effect.revision !== command.expectedRevision || effect.actionHash !== command.payload.actionHash || effect.state !== "unknown" || effect.payloadState === "deleted") throw new AppError("stale_effect_resolution", 409);
      this.progress(tx, effect.id);
      const action = this.action(effect.action);
      this.currentConnection(tx, action);
      tx.run("INSERT INTO git_reconciliations VALUES (?,?) ON CONFLICT(effect_id) DO UPDATE SET record_json=excluded.record_json", effect.id,
        canonical({ effectId: effect.id, actionHash: effect.actionHash, revision: effect.revision, requested: true }));
      return { kind: command.kind, requestId: command.requestId, effect };
    }
    if (command.kind !== "git.propose") throw new AppError("unknown_command");
    const p = command.payload;
    exact(p, ["attemptId", "connection", "update", "pr", "expiresAt"]);
    identity(p.attemptId);
    exact(p.connection, ["id", "revision"]);
    identity(p.connection.id);
    integer(p.connection.revision, 1);
    exact(p.update, ["ref", "oldCommit", "newCommit"]);
    if (typeof p.update.ref !== "string" || !p.update.ref.startsWith("refs/heads/")) throw new AppError("git_branch_invalid");
    gitBranch(p.update.ref.slice(11));
    if (p.update.oldCommit !== null) codingCommit(p.update.oldCommit);
    codingCommit(p.update.newCommit);
    if (p.pr !== null) {
      exact(p.pr, ["base", "baseCommit", "title", "body", "draft"]);
      gitBranch(p.pr.base);
      codingCommit(p.pr.baseCommit);
      if (p.pr.base === p.update.ref.slice(11) || typeof p.pr.draft !== "boolean" || text(p.pr.title, 200) !== p.pr.title ||
          typeof p.pr.body !== "string" || p.pr.body.length > 12000 || !p.pr.body.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(p.pr.body) ||
          containsCredential(p.pr.title) || containsCredential(p.pr.body)) throw new AppError("git_pr_invalid");
    }
    if (command.expectedRevision !== 0) throw new AppError("stale_revision", 409);
    const attempt = this.app.authority.assertTool(tx, p.attemptId, "effect_push");
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM coding_runs WHERE attempt_id=?", p.attemptId);
    if (!row) throw new AppError("coding_evidence_required", 409);
    const run = JSON.parse(row.record_json) as CodingRun;
    const job = this.app.coding.job(tx, run.workId);
    if (!job || !run.headCommit || !run.diffHash || !run.reportId || !["reviewable", "partial"].includes(run.state) ||
        run.reason === "coding_changed_during_tests" || run.headCommit !== p.update.newCommit || this.app.reports.read(tx, run.reportId).state !== "available") throw new AppError("coding_evidence_required", 409);
    const action: GitAction = { version: "app.git-effects/v2", intentId: crypto.randomUUID().replaceAll("-", ""), codingAttemptId: p.attemptId,
      ownerGeneration: attempt.snapshot.grant.ownerGeneration, repository: job.repository, connection: structuredClone(p.connection), headCommit: run.headCommit, diffHash: run.diffHash,
      reportId: run.reportId, update: structuredClone(p.update), pr: structuredClone(p.pr) };
    this.currentConnection(tx, action);
    const effect = this.app.authority.proposeEffect(p.attemptId, command.requestId, { kind: "push", destination: job.repository.url, content: canonical(action) }, p.expiresAt);
    const progress: GitProgress = { effectId: effect.id, intentId: action.intentId, actionHash: effect.actionHash,
      stage: "prepared", reason: null, pullNumber: null, pullUrl: null, verification: "none" };
    tx.run("INSERT INTO git_effects VALUES (?,?,?)", effect.id, action.intentId, canonical(progress));
    return { kind: command.kind, requestId: command.requestId, effect };
  }

  private action(value: EffectAction): GitAction {
    if (value.kind !== "push") throw new AppError("unsupported_effect", 403);
    let action: GitAction;
    try { action = JSON.parse(value.content); } catch { throw new AppError("git_action_invalid"); }
    if (action.version !== "app.git-effects/v2" || value.destination !== action.repository.url) throw new AppError("git_action_invalid");
    return action;
  }

  /** Lists resource-scoped metadata only; secrets and vault file identifiers have no query surface. */
  connections(actor: OwnerActor): GitConnection[] {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return tx.all<{ record_json: string }>("SELECT record_json FROM git_connections ORDER BY rowid").map(row => JSON.parse(row.record_json));
    });
  }

  /** Queries exact progress alongside the ordinary effect ledger, without dispatching or resolving anything. */
  view(actor: OwnerActor, effectId: string): { effect: Effect; progress: GitProgress; reconcileRequested: boolean } {
    const { effect } = this.app.authority.effect(actor, effectId);
    return this.app.store.read(tx => ({ effect, progress: this.progress(tx, effectId),
      reconcileRequested: !!tx.get("SELECT 1 FROM git_reconciliations WHERE effect_id=? AND json_extract(record_json,'$.requested')=1", effectId) }));
  }

  private async stage(progress: GitProgress, stage: GitProgress["stage"], reason: string | null = null): Promise<void> {
    progress.stage = stage;
    progress.reason = reason;
    this.app.store.transaction(tx => tx.run("UPDATE git_effects SET record_json=? WHERE effect_id=?", canonical(progress), progress.effectId));
    await this.options.afterStage?.(stage);
  }

  private secret(action: GitAction, effectId: string): string {
    return this.app.store.transaction(tx => {
      const connection = this.currentConnection(tx, action);
      if (!this.options.vault) throw new AppError("connection_vault_not_configured", 503);
      const key = tx.get<{ vault_id: string }>("SELECT vault_id FROM git_connections WHERE id=?", connection.id)?.vault_id;
      if (!key) throw new AppError("connection_unavailable", 409);
      const secret = this.options.vault.read(key);
      tx.run("INSERT INTO git_connection_releases(connection_id,effect_id,revision,recorded_at) VALUES (?,?,?,?)", connection.id, effectId, connection.revision, this.app.now());
      registerSecretFingerprint(secret);
      return secret;
    });
  }

  private async bundle(action: GitAction, allowed: () => void): Promise<Uint8Array> {
    const session = this.app.computers.open(action.codingAttemptId);
    try {
      const backend = session.backend;
      const job = this.app.store.read(tx => this.app.coding.job(tx, this.app.authority.guard(tx, action.codingAttemptId).workId));
      if (!job || canonical(job.repository) !== canonical(action.repository)) throw new AppError("git_approved_diff_changed", 409);
      await codingPath(backend, job.path);
      const git = async (args: string[]) => { allowed(); return codingGitOutput(await codingGit(backend, job.path, args)); };
      if ((await git(["rev-parse", "HEAD"])).trim() !== action.headCommit || await git(["status", "--porcelain=v1", "--untracked-files=all"])) throw new AppError("git_approved_diff_changed", 409);
      const path = `${job.path}/.jit-${action.intentId}.bundle`;
      if ((await backend.list(job.path)).some(entry => entry.name === `.jit-${action.intentId}.bundle`)) throw new AppError("git_bundle_path_refused", 403);
      await git(["bundle", "create", path, "HEAD"]);
      if (await backend.realpath(path) !== path || (await backend.stat(path)).type !== "file") throw new AppError("git_bundle_path_refused", 403);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of backend.readFile(path)) {
        allowed();
        size += chunk.length;
        if (size > 16777216) throw new AppError("git_bundle_bound", 409);
        chunks.push(chunk);
      }
      const removed = await backend.spawn({ cwd: job.path, command: `rm -- '${path}'`, timeoutMs: 10000 });
      codingGitOutput(removed);
      if ((await git(["rev-parse", "HEAD"])).trim() !== action.headCommit || await git(["status", "--porcelain=v1", "--untracked-files=all"])) throw new AppError("git_approved_diff_changed", 409);
      return new Uint8Array(Buffer.concat(chunks));
    } finally { session.release(); }
  }

  private async unchanged(action: GitAction, allowed: () => void): Promise<void> {
    const session = this.app.computers.open(action.codingAttemptId);
    try {
      const job = this.app.store.read(tx => this.app.coding.job(tx, this.app.authority.guard(tx, action.codingAttemptId).workId));
      if (!job) throw new AppError("git_approved_diff_changed", 409);
      await codingPath(session.backend, job.path);
      allowed();
      const head = codingGitOutput(await codingGit(session.backend, job.path, ["rev-parse", "HEAD"])).trim();
      const dirty = codingGitOutput(await codingGit(session.backend, job.path, ["status", "--porcelain=v1", "--untracked-files=all"]));
      if (head !== action.headCommit || dirty) throw new AppError("git_approved_diff_changed", 409);
      allowed();
    } finally { session.release(); }
  }

  private proved(action: GitAction, proof: GitRemoteProof): number | null | false {
    if (!proof.complete || proof.headCommit !== action.headCommit) return false;
    if (!action.pr) return null;
    const matches = proof.prs.filter(pr => pr.headCommit === action.headCommit && pr.baseCommit === action.pr!.baseCommit &&
      pr.head === action.update.ref.slice(11) && pr.base === action.pr!.base && pr.title === action.pr!.title && pr.body === action.pr!.body && pr.draft === action.pr!.draft);
    return matches.length === 1 ? matches[0]!.number : false;
  }

  /** Performs one durable approved plan; all uncertain windows are reconcile-only, never another dispatch. */
  async perform(value: EffectAction, permitted: () => void): Promise<"succeeded" | "failed" | "unknown"> {
    const action = this.action(value);
    const progress = this.app.store.read(tx => {
      const row = tx.get<{ effect_id: string }>("SELECT effect_id FROM git_effects WHERE intent_id=?", action.intentId);
      if (!row) throw new AppError("git_action_invalid");
      const effect = record<Effect>(tx, "effects", row.effect_id);
      if (effect.actionHash !== digest(canonical(value)) || canonical(effect.action) !== canonical(value)) throw new AppError("stale_approval", 409);
      const progress = this.progress(tx, row.effect_id);
      if (progress.actionHash !== effect.actionHash || progress.stage !== "prepared") throw new AppError("stale_approval", 409);
      return progress;
    });
    const allowed = () => {
      permitted();
      if (canonical(action) !== value.content) throw new AppError("stale_approval", 409);
      this.app.store.read(tx => this.currentConnection(tx, action));
    };
    const mirror = new CodingGitMirror();
    let dispatched = false;
    try {
      await this.stage(progress, "verifying");
      const bundle = await this.bundle(action, allowed);
      await mirror.import(bundle, action);
      allowed();
      const secret = this.secret(action, progress.effectId);
      const before = await this.remote.readBack(action, secret, allowed);
      if (!before.complete || before.headCommit !== action.update.oldCommit || action.pr && before.baseCommit !== action.pr.baseCommit) {
        await this.stage(progress, "failed", "git_remote_ref_changed");
        return "failed";
      }
      await this.stage(progress, "push_dispatching");
      await this.unchanged(action, allowed);
      allowed();
      dispatched = true;
      const pushed = await this.remote.push(mirror.verifiedPath(), action, secret, allowed);
      if (pushed !== "succeeded") {
        await this.stage(progress, pushed === "failed" ? "failed" : "unknown", pushed === "failed" ? "git_push_rejected" : "git_push_unconfirmed");
        return pushed;
      }
      await this.stage(progress, "pushed");
      if (action.pr) {
        const current = await this.remote.readBack(action, secret, allowed);
        if (!current.complete || current.headCommit !== action.headCommit || current.baseCommit !== action.pr.baseCommit) {
          await this.stage(progress, "unknown", "git_pr_precondition_unconfirmed_after_push");
          return "unknown";
        }
        await this.stage(progress, "pr_dispatching");
        allowed();
        const result = await this.remote.createPr(action, secret, allowed);
        progress.pullNumber = result.number;
        progress.pullUrl = gitPullUrl(result.url, action.repository.url, result.number);
        if (result.outcome !== "succeeded") {
          await this.stage(progress, result.outcome === "failed" ? "failed" : "unknown", result.outcome === "failed" ? "git_pr_rejected_after_push" : "git_pr_unconfirmed_after_push");
          return result.outcome;
        }
      }
      const proof = await this.remote.readBack(action, secret, allowed);
      allowed();
      const number = this.proved(action, proof);
      if (number === false) { await this.stage(progress, "unknown", "git_remote_readback_unconfirmed"); return "unknown"; }
      progress.pullNumber = number;
      progress.pullUrl = gitPullUrl(proof.prs.find(pr => pr.number === number)?.url, action.repository.url, number) ?? gitPullUrl(progress.pullUrl, action.repository.url, number);
      progress.verification = "remote_readback";
      await this.stage(progress, "complete");
      this.remember(progress);
      return "succeeded";
    } catch (error) {
      await this.stage(progress, dispatched ? "unknown" : "failed", dispatched ? "git_dispatch_unconfirmed" : error instanceof AppError ? error.code : "git_verification_unavailable");
      return dispatched ? "unknown" : "failed";
    } finally { mirror.close(); }
  }

  private remember(progress: GitProgress): void {
    this.app.store.transaction(tx => tx.run("INSERT OR IGNORE INTO lifecycle.git_outcomes VALUES (?,?,?)", progress.effectId, progress.actionHash, canonical(progress)));
  }

  /** Reapplies independent verified outcomes after stale-image restore; claims alone still remain unknown. */
  recover(tx: AppTransaction): void {
    for (const row of tx.all<{ effect_id: string; action_hash: string; record_json: string }>("SELECT * FROM lifecycle.git_outcomes")) {
      const effect = tx.get<{ record_json: string }>("SELECT record_json FROM effects WHERE id=?", row.effect_id);
      if (!effect) continue;
      const value = JSON.parse(effect.record_json) as Effect;
      if (value.actionHash !== row.action_hash || value.payloadState === "deleted") continue;
      value.state = "succeeded";
      value.reason = "verified_remote_readback";
      save(tx, "effects", value);
      tx.run("INSERT OR REPLACE INTO effect_versions VALUES (?,?,?)", value.id, value.revision, canonical(value));
      tx.run("UPDATE git_effects SET record_json=? WHERE effect_id=?", row.record_json, value.id);
    }
    for (const row of tx.all<{ vault_id: string }>("SELECT vault_id FROM git_connections WHERE vault_id IS NOT NULL")) {
      try { if (this.options.vault) registerSecretFingerprint(this.options.vault.read(row.vault_id)); } catch { /* Metadata test exposes missing/unsafe files without leaking errors. */ }
    }
  }

  private async reconcile(effectId: string): Promise<void> {
    const { effect, action, progress } = this.app.store.read(tx => {
      const effect = record<Effect>(tx, "effects", effectId);
      const queued = tx.get<{ record_json: string }>("SELECT record_json FROM git_reconciliations WHERE effect_id=?", effectId)!;
      const intent = JSON.parse(queued.record_json) as { actionHash: string; revision: number };
      if (effect.state !== "unknown" || effect.actionHash !== intent.actionHash || effect.revision !== intent.revision || effect.payloadState === "deleted") throw new AppError("stale_effect_resolution", 409);
      return { effect, action: this.action(effect.action), progress: this.progress(tx, effect.id) };
    });
    const allowed = () => this.app.store.read(tx => {
      const current = record<Effect>(tx, "effects", effect.id);
      if (current.state !== "unknown" || current.actionHash !== effect.actionHash || current.revision !== effect.revision || current.payloadState === "deleted") throw new AppError("stale_effect_resolution", 409);
      if (canonical(action) !== effect.action.content) throw new AppError("stale_approval", 409);
      this.currentConnection(tx, action);
    });
    try {
      allowed();
      const secret = this.secret(action, effect.id);
      const proof = await this.remote.readBack(action, secret, allowed);
      allowed();
      const number = this.proved(action, proof);
      if (number === false) { await this.stage(progress, "unknown", "git_remote_readback_unconfirmed"); return; }
      progress.pullNumber = number;
      progress.pullUrl = gitPullUrl(proof.prs.find(pr => pr.number === number)?.url, action.repository.url, number) ?? gitPullUrl(progress.pullUrl, action.repository.url, number);
      progress.verification = "remote_readback";
      await this.stage(progress, "complete");
      this.remember(progress);
      this.app.store.transaction(tx => this.recover(tx));
    } finally {
      this.app.store.transaction(tx => tx.run("UPDATE git_reconciliations SET record_json=json_set(record_json,'$.requested',0) WHERE effect_id=?", effect.id));
    }
  }

  /** Drains only approved Git effects and explicit owner read-back requests; it never retries unknown mutations. */
  async drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    this.#draining = (async () => {
      const ids = this.app.store.read(tx => tx.all<{ effect_id: string }>("SELECT g.effect_id FROM git_effects g JOIN effects e ON e.id=g.effect_id WHERE json_extract(e.record_json,'$.state')='approved'"));
      for (const row of ids) {
        const effect = this.app.store.read(tx => record<Effect>(tx, "effects", row.effect_id));
        await this.app.authority.runEffect(effect.id, effect.revision, effect.actionHash).catch(() => {});
      }
      const requested = this.app.store.read(tx => tx.all<{ effect_id: string }>("SELECT effect_id FROM git_reconciliations WHERE json_extract(record_json,'$.requested')=1"));
      for (const row of requested) {
        await this.reconcile(row.effect_id).catch(() => {
          this.app.store.transaction(tx => tx.run("UPDATE git_reconciliations SET record_json=json_set(record_json,'$.requested',0) WHERE effect_id=?", row.effect_id));
        });
      }
    })();
    try { await this.#draining; }
    finally { this.#draining = null; }
  }
}

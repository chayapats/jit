import type { ExecutionBackend } from "schway/host";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { containsCredential, redactCredentials } from "../security/credentials";
import { record, type S14Application } from "./application";
import type { Attempt, ScopePolicy, ScopeRef, WorkOutput } from "./authority-types";
import { artifactHash } from "./artifacts";
import { canonical, digest, exact, identity, text } from "./validation";
import { codingCheck, codingCommit, codingGit, codingGitOutput, codingOrigin, codingPath, codingQuote } from "./coding-protocol";
import { codingModel } from "./coding-model";
import type { Bot, OwnerActor } from "./types";
import type { CodingCheck, CodingCheckResult, CodingCommand, CodingJob, CodingOptions, CodingReceipt, CodingRepository, CodingRun, CodingView } from "./coding-types";

const parse = <T>(row: { record_json: string } | null): T | null => row ? JSON.parse(row.record_json) as T : null;
const clip = (value: string) => redactCredentials(value).slice(0, 2000);

/** Repository grants and real execution evidence stay inside the existing owner/Bot/work/computer barriers. */
export class S14Coding {
  constructor(readonly app: S14Application, readonly options: CodingOptions = {}) {}

  /** Supplies only exact current typed repository policies to the ordinary resource intersection. */
  scope(tx: AppTransaction, ref: ScopeRef): ScopePolicy | null {
    const repository = parse<CodingRepository>(tx.get("SELECT record_json FROM coding_repositories WHERE id=?", ref.id));
    if (!repository) return null;
    return { ref: { kind: "resource", id: repository.id, revision: repository.revision },
      active: ref.kind === "resource" && repository.active && !tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='coding_repository' AND id=?", repository.id),
      ownerBotId: repository.botId, receiverBotId: null, workId: null, tools: ["computer", "coding", "effect_push"],
      snapshot: { id: repository.id, revision: repository.revision, hash: digest(canonical(repository)) } };
  }

  /** Applies explicit repository grants/revocation or atomic coding start without deriving authority from source text. */
  apply(tx: AppTransaction, command: CodingCommand): CodingReceipt {
    if (command.kind === "coding.repository.grant") {
      const p = command.payload;
      exact(p, ["id", "botId", "url", "baseCommit"]);
      identity(p.id); identity(p.botId); codingOrigin(p.url); codingCommit(p.baseCommit);
      const bot = record<Bot>(tx, "bots", p.botId);
      if (command.expectedRevision !== 0 || tx.get("SELECT 1 FROM coding_repositories WHERE id=?", p.id)) throw new AppError("stale_revision", 409);
      if (!bot.enabled || !this.app.policy.resources.includes(p.id) || !bot.capabilities.resources.includes(p.id) ||
          tx.get("SELECT 1 FROM snapshot_shares WHERE id=?", p.id) || tx.get("SELECT 1 FROM memory_shares WHERE id=?", p.id)) throw new AppError("coding_resource_denied", 403);
      const repository: CodingRepository = { ...structuredClone(p), revision: 1, active: true };
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
    exact(p, ["repository", "work", "install", "tests"]);
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
    const receipt = this.app.authority.apply(tx, { kind: "work.start", requestId: command.requestId, expectedRevision: command.expectedRevision, payload: p.work });
    const job: CodingJob = { workId: receipt.work!.id, repository, branch: `jit/${receipt.work!.id}`,
      path: `/workspace/coding/${receipt.work!.id}`, install: structuredClone(p.install), tests: structuredClone(p.tests) };
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
        try { return this.app.authority.retainedEvidence(tx, run.attemptId); } catch { return false; }
      });
      const checks = available ? tx.all<{ attemptId: string; ordinal: number; record_json: string }>("SELECT c.attempt_id AS attemptId,c.ordinal,c.record_json FROM coding_checks c JOIN coding_runs r ON r.attempt_id=c.attempt_id WHERE r.work_id=? ORDER BY c.rowid", workId)
        .map(({ record_json, ...row }) => ({ ...row, result: JSON.parse(record_json) as CodingCheckResult })) : [];
      return { job: available ? this.job(tx, workId) : null, runs: runs.map(run => run.state === "reviewable" && !run.reportId ? { ...run, state: "partial", reason: "coding_evidence_not_committed" } : run), available, checks };
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

  /** Removes lifecycle-deleted duplicate plans/checks while preserving immutable effect and artifact identities. */
  reconcile(tx: AppTransaction): void {
    tx.run("DELETE FROM coding_checks WHERE attempt_id IN (SELECT attempt_id FROM attempt_payload_deletions)");
    tx.run("DELETE FROM coding_jobs WHERE work_id IN (SELECT work_id FROM work_payload_deletions)");
  }

  private async performCheck(backend: ExecutionBackend, command: CodingCheck, path: string, signal: AbortSignal): Promise<CodingCheckResult> {
    if (command.network !== "none") return { command, state: "skipped", exitCode: null, timedOut: false, reason: "coding_egress_scope_unavailable", stdout: "", stderr: "" };
    try {
      const result = await backend.spawn({ cwd: path,
        command: ["env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", ...command.argv].map(codingQuote).join(" "), timeoutMs: command.timeoutMs, signal });
      return { command, state: result.exitCode === 0 && !result.timedOut ? "passed" : "failed", exitCode: result.exitCode,
        timedOut: result.timedOut, reason: result.timedOut ? "coding_check_timeout" : result.exitCode === 0 ? null : "coding_check_failed", stdout: clip(result.stdout), stderr: clip(result.stderr) };
    } catch {
      return { command, state: "unknown", exitCode: null, timedOut: false, reason: "coding_check_interrupted", stdout: "", stderr: "" };
    }
  }

  private async check(attemptId: string, ordinal: number, backend: ExecutionBackend, command: CodingCheck, path: string, signal: AbortSignal): Promise<CodingCheckResult> {
    const pending: CodingCheckResult = { command, state: "unknown", exitCode: null, timedOut: false, reason: "coding_check_dispatch_unconfirmed", stdout: "", stderr: "" };
    this.app.store.transaction(tx => {
      this.app.authority.assertTool(tx, attemptId, "coding");
      tx.run("INSERT INTO coding_checks VALUES (?,?,?)", attemptId, ordinal, canonical(pending));
    });
    const result = await this.performCheck(backend, command, path, signal);
    this.app.store.transaction(tx => tx.run("UPDATE coding_checks SET record_json=? WHERE attempt_id=? AND ordinal=?", canonical(result), attemptId, ordinal));
    return result;
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
      const source = `/workspace/repositories/${job.repository.id}`;
      await codingPath(backend, source);
      if (codingGitOutput(await codingGit(backend, source, ["rev-parse", "--verify", `${job.repository.baseCommit}^{commit}`], signal)).trim() !== job.repository.baseCommit) throw new AppError("coding_base_changed", 409);
      // --no-local avoids source object hardlinks/alternates; all source configuration stays inside the box.
      const mkdir = await backend.spawn({ cwd: "/workspace", command: "mkdir -p -- /workspace/coding", signal, timeoutMs: 10000 });
      codingGitOutput(mkdir);
      if (await backend.realpath("/workspace/coding") !== "/workspace/coding") throw new AppError("coding_path_refused", 403);
      codingGitOutput(await codingGit(backend, "/workspace", ["-c", "protocol.file.allow=always", "clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", source, job.path], signal));
      await codingPath(backend, job.path);
      codingGitOutput(await codingGit(backend, job.path, ["checkout", "--no-track", "-b", job.branch, job.repository.baseCommit, "--"], signal));
      const checks: CodingCheckResult[] = [];
      if (job.install) checks.push(await this.check(attempt.id, checks.length, backend, job.install, job.path, signal));
      const installOk = !job.install || checks[0]!.state === "passed";
      if (installOk) await codingModel(this.app, directory, attempt, backend, job.path, signal, this.options.model);
      if (signal.aborted) throw new AppError("coding_cancelled");
      await codingPath(backend, job.path);
      codingGitOutput(await codingGit(backend, job.path, ["add", "--all", "--", "."], signal));
      codingGitOutput(await codingGit(backend, job.path, ["-c", "user.name=Jit Bot", "-c", "user.email=bot@invalid", "commit", "--allow-empty", "--no-verify", "-m", `Coding work ${job.workId}`], signal));
      run.headCommit = codingGitOutput(await codingGit(backend, job.path, ["rev-parse", "HEAD"], signal)).trim();
      codingCommit(run.headCommit);
      for (const command of job.tests) checks.push(installOk ? await this.check(attempt.id, checks.length, backend, command, job.path, signal)
        : { command, state: "skipped", exitCode: null, timedOut: false, reason: "coding_install_incomplete", stdout: "", stderr: "" });
      if (signal.aborted) throw new AppError("coding_cancelled");
      const currentHead = codingGitOutput(await codingGit(backend, job.path, ["rev-parse", "HEAD"], signal)).trim();
      const dirty = codingGitOutput(await codingGit(backend, job.path, ["status", "--porcelain=v1", "--untracked-files=all"], signal));
      const diff = codingGitOutput(await codingGit(backend, job.path, ["diff", "--no-ext-diff", "--no-textconv", "--binary", job.repository.baseCommit, run.headCommit, "--"], signal));
      if (containsCredential(diff)) throw new AppError("coding_diff_credential_refused", 403);
      run.diffHash = artifactHash(new TextEncoder().encode(diff || "(empty diff)\n"));
      run.state = !dirty && currentHead === run.headCommit && job.tests.length > 0 && checks.every(check => check.state === "passed") ? "reviewable" : "partial";
      run.reason = dirty || currentHead !== run.headCommit ? "coding_changed_during_tests" : !job.tests.length ? "coding_tests_not_run" : checks.find(check => check.state !== "passed")?.reason ?? null;
      const files: { name: string; mediaType: "text/plain" | "application/json"; content: string }[] = [{ name: "coding-diff.txt", mediaType: "text/plain", content: diff || "(empty diff)\n" },
        { name: "coding-checks.json", mediaType: "application/json", content: canonical({ baseCommit: run.baseCommit, headCommit: run.headCommit, testedHead: run.headCommit,
          unchangedAfterTests: !dirty && currentHead === run.headCommit, checks, coverage: "Command output and owner-declared coverage only; no inferred measured coverage.", state: run.state, reason: run.reason }) }];
      const artifactIds = this.app.store.transaction(tx => {
        this.app.authority.guard(tx, attempt.id);
        return files.map(file => {
          const bytes = new TextEncoder().encode(file.content);
          return this.app.artifacts.stage(tx, attempt, { name: file.name, mediaType: file.mediaType, size: bytes.length, sha256: artifactHash(bytes) }, bytes).id;
        });
      });
      this.saveRun(run);
      return { state: "waiting", text: `Coding evidence: ${run.state}; base ${run.baseCommit}; head ${run.headCommit}; reason ${run.reason ?? "owner_review_required"}.`,
        report: { title: "Coding execution evidence", claims: [{ id: "execution", kind: "inference", text: "Inspect the attached service-captured diff and actual command observations; no exhaustive coverage or owner completion is asserted.", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Owner review required. No automatic push, PR or merge.", "Network egress is disabled; registry requirements are unrun.", "Test output is an execution observation, not proof of exhaustive coverage.", ...(run.reason ? [run.reason] : [])], artifactIds } };
    } catch (error) {
      run.state = "interrupted";
      run.reason = error instanceof AppError ? error.code : "coding_execution_unconfirmed";
      this.saveRun(run);
      throw error;
    } finally { session?.release(); }
  }
}

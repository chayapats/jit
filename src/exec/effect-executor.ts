import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors";
import { dictionaries } from "../i18n";
import { readPersona } from "../persona";
import { redactCredentials } from "../security/credentials";
import { redactRegisteredSecrets, registerSecretFingerprint } from "../security/secret-fingerprints";
import { commitServiceOutput, requireId } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import { assertExecutionAllowed } from "./access";
import {
  cardLevel, claimCard, failBeforeStart as failBefore, finishCard, inBoxKinds, readCard, readDeployTarget, readRemote, reconcileCards,
  type ApprovalCard, type CardReceipt, type EffectAction, type EffectKind, type GitHubTarget,
} from "./approval-cards";
import { releaseConnection, type ConnectionVault } from "./connections";
import type { RunBoxes } from "./run-tools";

/** Options of {@link EffectExecutor}. Test seams are marked; production sets only the first three. */
export interface EffectExecutorOptions {
  /** The connection values (app.connections/v1); without it every card fails `connection_vault_not_configured`. */
  vault: ConnectionVault | null;
  /** The project boxes the approved commits are bundled in. */
  boxes: RunBoxes | null;
  /** Host directory of the Jit-owned git mirrors (`<execution.directory>`); each project's is `<root>/<projectId>/mirror.git`. */
  mirrorRoot: string | null;
  now?: () => number;
  /** HTTP transport for GitHub REST and deploy hooks (protocol fixtures in tests). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Directory for private per-effect temporary files (default the OS temporary directory). */
  tempRoot?: string;
  /** Test-only: maps a pinned https remote URL to a local bare repository path. Never set in production. */
  localRemote?: (url: string) => string;
  /** Test-only fault seam, called after the claim commits and before the effect is attempted. */
  afterClaim?: (card: ApprovalCard) => void | Promise<void>;
  /** Test-only fault seam, called after the bundle reached the mirror and before the push re-check. */
  beforePush?: (card: ApprovalCard) => void | Promise<void>;
  /** Most bytes of a git bundle copied out of the box (default 256 MiB). */
  bundleBytes?: number;
  /**
   * Performers of the in-box card kinds ({@link inBoxKinds}): an approved `mcp_tool` call runs through the MCP
   * gateway in the box or its sidecar. A performer is called once, after the claim committed, and must re-check its
   * own preconditions (level, takeover) right before it acts. Without one, such a card fails `performer_not_configured`.
   */
  performers?: Partial<Record<EffectKind, EffectPerformer>>;
}

/** What an effect attempt produced: the outcome and its technical evidence. */
export type EffectOutcome = { outcome: "succeeded" | "failed" | "unknown"; reason: string | null; detail: Record<string, unknown> };
type Outcome = EffectOutcome;
/** Runs one claimed in-box card. `allowed()` re-reads the level and halt; it must be true right before acting. */
export type EffectPerformer = (card: ApprovalCard, signal: AbortSignal, allowed: () => boolean) => Promise<EffectOutcome>;

const SHA = /^[0-9a-f]{40}$/;
const clip = (value: string, max = 2000) => redactRegisteredSecrets(redactCredentials(value)).slice(0, max);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The effect executor (EXE07, ADR 0037): runs one approved card exactly once, outside every box, with the bound
 * connection released for that card only.
 *
 * 1. **Claim.** In one transaction: the card must be `executing` and not started; the proposing role must still have
 *    `full` in an unhalted project, and the pinned remote or deploy target must still be at its pinned revision
 *    (else the card fails before anything happens); the connection is released for `effect:<cardId>` (audited) and
 *    the card is marked started. A crash after this point reconciles to `unknown`, never a retry.
 * 2. **Effect.** `effect.git_push` bundles the approved SHAs in the box (hooks disabled), copies the bundle out,
 *    verifies it and checks that it contains every approved `<newSha>` (else `stale`, nothing pushed), fetches it into
 *    a Jit-owned bare mirror with fixed configuration and pushes from there with hooks off, `GIT_ASKPASS`, explicit
 *    `<newSha>:refs/heads/<branch>` refspecs and `--force-with-lease=refs/heads/<branch>:<oldSha>` (empty for a new
 *    branch). GitHub effects call only the endpoint the card names; a deploy posts to the owner's deploy hook.
 * 3. **Outcome.** The card becomes `succeeded`, `failed` or `unknown` with a credential-free receipt, and a
 *    service-attributed source is posted to the card's topic.
 */
export class EffectExecutor {
  readonly #store: TransactionStore;
  readonly #options: EffectExecutorOptions;
  readonly #now: () => number;
  readonly #running = new Set<Promise<unknown>>();
  /** In-flight effects by card, so a halt can abort the host work of its project. */
  readonly #inFlight = new Map<string, { projectId: string; abort: AbortController }>();
  #closing = false;

  constructor(store: TransactionStore, options: EffectExecutorOptions) {
    this.#store = store;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Boot reconciliation: started cards become `unknown`, unstarted ones fail `interrupted_before_start`; each outcome
   * is posted to its topic for the owner's attention. Nothing is retried.
   */
  reconcile(): string[] {
    return this.#store.transaction(tx => {
      const now = this.#now(), touched = reconcileCards(tx, now);
      for (const id of touched) {
        const row = tx.get<{ projectId: string }>("SELECT project_id AS projectId FROM approval_cards WHERE id = ?", id)!;
        postResult(tx, readCard(tx, row.projectId, id), now);
      }
      return touched;
    });
  }

  /** Waits for every effect this executor started. */
  async idle(): Promise<void> { while (this.#running.size) await Promise.allSettled([...this.#running]); }

  /**
   * Service drain: claims nothing more (an approved card left unclaimed fails `interrupted_before_start` at the next
   * boot) and aborts effects still in flight, which end `unknown`. Callers then wait for {@link idle} within their
   * drain deadline.
   */
  close(): void {
    this.#closing = true;
    for (const item of this.#inFlight.values()) item.abort.abort();
  }

  /**
   * After an access command commits (kill switch, narrowing): aborts the host work of every in-flight effect of the
   * project whose role no longer has the card's level in an unhalted project. An aborted push or call ends `unknown`.
   */
  accessChanged(projectId: string): void {
    for (const [cardId, item] of this.#inFlight) {
      if (item.projectId !== projectId) continue;
      const row = this.#store.read(tx => tx.get<{ roleId: string; kind: EffectKind }>("SELECT role_id AS roleId, kind FROM approval_cards WHERE id = ?", cardId));
      try { this.#store.read(tx => assertExecutionAllowed(tx, projectId, row?.roleId ?? null, row ? cardLevel(row.kind) : "full")); } catch { item.abort.abort(); }
    }
  }

  /** True while the card may still cause its effect: not aborted, and the role keeps the card's level in an unhalted project. */
  #allowed(card: ApprovalCard, signal: AbortSignal): boolean {
    if (signal.aborted || this.#closing) return false;
    try { this.#store.read(tx => assertExecutionAllowed(tx, card.projectId, card.roleId, cardLevel(card.kind))); return true; } catch { return false; }
  }

  /** Runs the card once if it is claimable; resolves with the card's final state. Never throws for an effect failure. */
  run(projectId: string, cardId: string): Promise<ApprovalCard> {
    const promise = this.#run(projectId, cardId);
    this.#running.add(promise);
    void promise.finally(() => this.#running.delete(promise)).catch(() => undefined);
    return promise;
  }

  async #run(projectId: string, cardId: string): Promise<ApprovalCard> {
    requireId(projectId); requireId(cardId);
    if (this.#closing) return this.#store.read(tx => readCard(tx, projectId, cardId));
    let claimed: { card: ApprovalCard; secret: string } | { failed: ApprovalCard } | null;
    try {
      claimed = this.#store.transaction(tx => this.#claim(tx, projectId, cardId));
    } catch (error) {
      // A release that failed (vault unsafe, connection removed) leaves nothing started: the card fails cleanly.
      const reason = error instanceof AppError ? error.code : "claim_failed";
      return this.#store.transaction(tx => {
        const failed = failBefore(tx, readCard(tx, projectId, cardId), reason, this.#now());
        if (failed.state === "failed" && failed.reason === reason) postResult(tx, failed, this.#now());
        return failed;
      });
    }
    if (!claimed) return this.#store.read(tx => readCard(tx, projectId, cardId));
    if ("failed" in claimed) return claimed.failed;
    const { card, secret } = claimed;
    if (secret) registerSecretFingerprint(secret);
    const abort = new AbortController();
    this.#inFlight.set(card.id, { projectId, abort });
    let outcome: Outcome;
    try {
      await this.#options.afterClaim?.(card);
      outcome = await this.#perform(card, secret, abort.signal);
    } catch {
      outcome = { outcome: "unknown", reason: "executor_error", detail: {} };
    } finally {
      this.#inFlight.delete(card.id);
    }
    return this.#store.transaction(tx => {
      const now = this.#now();
      const receipt: CardReceipt = { ...outcome, finishedAt: now };
      // Only this run's own transition is reported; a card reconciled meanwhile keeps its recorded outcome.
      if (readCard(tx, card.projectId, card.id).state !== "executing") return readCard(tx, card.projectId, card.id);
      const finished = finishCard(tx, card, receipt, now);
      postResult(tx, finished, now);
      return finished;
    });
  }

  #claim(tx: AppTransaction, projectId: string, cardId: string): { card: ApprovalCard; secret: string } | { failed: ApprovalCard } | null {
    const now = this.#now();
    const failBeforeStart = (card: ApprovalCard, reason: string, at: number) => { const failed = failBefore(tx, card, reason, at); postResult(tx, failed, at); return failed; };
    const card = readCard(tx, projectId, cardId);
    if (card.state !== "executing" || card.startedAt !== null) return null;
    try { assertExecutionAllowed(tx, projectId, card.roleId, cardLevel(card.kind)); }
    catch { return { failed: failBeforeStart(card, "access_changed", now) }; }
    const action = card.action;
    // In-box kinds release no connection here: an MCP sidecar receives its bound values from the gateway at spawn.
    if (action.kind === "mcp_tool" || action.kind === "browser_confirm") {
      if (!this.#options.performers?.[action.kind]) return { failed: failBeforeStart(card, "performer_not_configured", now) };
      const started = claimCard(tx, projectId, cardId, now);
      if (!started) throw new AppError("approval_card_not_pending", 409);
      return { card: started, secret: "" };
    }
    let connectionId: string;
    if (action.kind === "effect.deploy") {
      const target = readDeployTarget(tx, projectId, action.target.name);
      if (!target || target.revision !== action.target.revision || target.url !== action.target.url) return { failed: failBeforeStart(card, "target_changed", now) };
      connectionId = target.connectionId;
    } else {
      const remote = readRemote(tx, projectId, action.remote.name);
      if (!remote || remote.revision !== action.remote.revision || remote.url !== action.remote.url) return { failed: failBeforeStart(card, "target_changed", now) };
      connectionId = remote.connectionId;
    }
    if (action.kind === "effect.git_push" && (!this.#options.boxes || !this.#options.mirrorRoot)) return { failed: failBeforeStart(card, "box_not_configured", now) };
    if (!this.#options.vault) return { failed: failBeforeStart(card, "connection_vault_not_configured", now) };
    const released = releaseConnection(tx, connectionId, `effect:${card.id}`, this.#options.vault, { projectId, now });
    const started = claimCard(tx, projectId, cardId, now);
    if (!started) throw new AppError("approval_card_not_pending", 409);
    return { card: started, secret: released.secret };
  }

  async #perform(card: ApprovalCard, secret: string, signal: AbortSignal): Promise<Outcome> {
    const action = card.action;
    // Every external step re-checks the level and the halt right before it starts (ADR 0037).
    const allowed = () => this.#allowed(card, signal);
    if (inBoxKinds.includes(action.kind)) {
      if (!allowed()) return { outcome: "failed", reason: "access_changed", detail: {} };
      return this.#options.performers![action.kind]!(card, signal, allowed);
    }
    if (action.kind === "effect.git_push") return this.#push(card, action, secret, signal, allowed);
    if (!allowed()) return { outcome: "failed", reason: "access_changed", detail: {} };
    switch (action.kind) {
      case "effect.github_pr_create":
        return this.#github(signal, action.github, secret, "POST", `pulls`, { title: action.title, head: action.head, base: action.base, body: action.body, draft: action.draft },
          201, body => ({ number: body.number, url: body.html_url }));
      case "effect.github_comment":
        return this.#github(signal, action.github, secret, "POST", `issues/${action.issueNumber}/comments`, { body: action.body }, 201, body => ({ id: body.id, url: body.html_url }));
      case "effect.github_pr_merge":
        return this.#github(signal, action.github, secret, "PUT", `pulls/${action.pullNumber}/merge`, { sha: action.headSha, merge_method: action.method }, 200,
          body => ({ sha: body.sha, merged: body.merged }), { 409: "stale", 405: "not_mergeable" });
      case "effect.deploy":
        return this.#http(signal, action.target.url, secret, "POST", { projectId: card.projectId, target: action.target.name, ref: action.ref, cardId: card.id }, null, () => ({}));
      default:
        return { outcome: "failed", reason: "performer_not_configured", detail: {} };
    }
  }

  async #github(signal: AbortSignal, github: GitHubTarget, secret: string, method: string, path: string, body: unknown, expected: number,
    pick: (body: Record<string, unknown>) => Record<string, unknown>, failures: Record<number, string> = {}): Promise<Outcome> {
    const url = `${github.apiBase.replace(/\/$/, "")}/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repo)}/${path}`;
    return this.#http(signal, url, secret, method, body, expected, pick, failures);
  }

  /**
   * One HTTP call to exactly `url`. A transport failure is `unknown` (the request may have been received); a
   * non-success status is `failed` with `http_<status>` (or the named reason). Redirects are refused and only the
   * picked fields of the response are kept.
   */
  async #http(signal: AbortSignal, url: string, secret: string, method: string, body: unknown, expected: number | null,
    pick: (body: Record<string, unknown>) => Record<string, unknown>, failures: Record<number, string> = {}): Promise<Outcome> {
    const fetcher = this.#options.fetch ?? ((input, init) => fetch(input, init));
    let response: Response;
    try {
      response = await fetcher(url, {
        method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { authorization: `Bearer ${secret}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "jit" },
        body: JSON.stringify(body),
      });
    } catch { return { outcome: "unknown", reason: "transport_error", detail: { endpoint: endpointOf(url) } }; }
    const ok = expected === null ? response.status >= 200 && response.status < 300 : response.status === expected;
    if (!ok) return { outcome: "failed", reason: failures[response.status] ?? `http_${response.status}`, detail: { endpoint: endpointOf(url), status: response.status } };
    let parsed: Record<string, unknown> = {};
    try { const text = await response.text(); parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* Success stands without a readable body. */ }
    const picked = Object.fromEntries(Object.entries(pick(parsed && typeof parsed === "object" ? parsed : {}))
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [key, typeof value === "string" ? clip(value, 500) : value]));
    return { outcome: "succeeded", reason: null, detail: { endpoint: endpointOf(url), status: response.status, ...picked } };
  }

  /** The git bundle → mirror → push path (ADR 0037 § Git push safety). */
  async #push(card: ApprovalCard, action: Extract<EffectAction, { kind: "effect.git_push" }>, secret: string, signal: AbortSignal, allowed: () => boolean): Promise<Outcome> {
    const work = mkdtempSync(join(this.#options.tempRoot ?? tmpdir(), "jit-effect-"));
    chmodSync(work, 0o700);
    try {
      if (!allowed()) return { outcome: "failed", reason: "access_changed", detail: {} };
      const bundle = await this.#bundleFromBox(card, action, work);
      if ("outcome" in bundle) return bundle;
      const mirror = this.#mirror(card.projectId, work);
      const git = (args: string[], options: { secret?: string; timeoutMs?: number } = {}) => runGit(mirror.env(options.secret), args, options.timeoutMs ?? 120_000, signal);
      // Fixed flags on every call; transports are allowed per step: only the local bundle file for the fetch, only
      // https for the push (a local bare repository too, under the test-only seam).
      const base = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "transfer.fsckObjects=true",
        "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-C", mirror.path];
      const fetchFlags = ["-c", "protocol.file.allow=always"];
      const pushFlags = ["-c", "protocol.https.allow=always", ...(this.#options.localRemote ? ["-c", "protocol.file.allow=always"] : [])];
      if ((await git([...base, "bundle", "verify", "--quiet", bundle.path])).code !== 0) return { outcome: "failed", reason: "bundle_invalid", detail: {} };
      const heads = await git([...base, "bundle", "list-heads", bundle.path]);
      const listed = new Set(heads.stdout.split("\n").map(line => line.split(" ")[0]).filter((sha): sha is string => !!sha && SHA.test(sha)));
      // Anything moved in the box after the card was made cannot be pushed: the bundle must hold every approved SHA.
      if (heads.code !== 0 || action.updates.some(update => !listed.has(update.newSha))) return { outcome: "failed", reason: "stale", detail: { missing: action.updates.filter(update => !listed.has(update.newSha)).map(update => update.newSha) } };
      const fetched = await git([...base, ...fetchFlags, "fetch", "--no-tags", "--no-write-fetch-head", "--quiet", bundle.path, `+refs/jit-effect/${card.id}/*:refs/jit-effect/${card.id}/*`]);
      if (fetched.code !== 0) return { outcome: "failed", reason: "bundle_fetch_failed", detail: {} };
      for (const update of action.updates) {
        if ((await git([...base, "cat-file", "-e", `${update.newSha}^{commit}`])).code !== 0) return { outcome: "failed", reason: "stale", detail: { missing: [update.newSha] } };
      }
      await this.#options.beforePush?.(card);
      // A halt, a narrower level or a drain since the claim stops the push before it starts; nothing was sent.
      if (!allowed()) return { outcome: "failed", reason: "access_changed", detail: {} };
      const url = this.#options.localRemote ? this.#options.localRemote(action.remote.url) : action.remote.url;
      const pushed = await runGit(mirror.env(secret), [...base, ...pushFlags, "push", "--porcelain", "--atomic", "--no-verify", url,
        ...action.updates.map(update => `--force-with-lease=${update.ref}:${update.oldSha ?? ""}`),
        ...action.updates.map(update => `${update.newSha}:${update.ref}`)], 120_000, signal);
      for (let index = 0; index < action.updates.length; index++) await git([...base, "update-ref", "-d", `refs/jit-effect/${card.id}/${index}`]).catch(() => undefined);
      return pushOutcome(pushed, action);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Creates the bundle inside the box through the runner — git hooks and fsmonitor disabled, temporary refs naming the
   * approved SHAs — and copies it out. A SHA the box no longer has is `stale`; nothing on the host ran box code.
   */
  async #bundleFromBox(card: ApprovalCard, action: Extract<EffectAction, { kind: "effect.git_push" }>, work: string): Promise<{ path: string } | Outcome> {
    const session = await this.#options.boxes!.open(card.projectId, null).catch((error: unknown) => error instanceof AppError ? error : new AppError("box_runtime_unavailable", 503));
    if (session instanceof AppError) return { outcome: "failed", reason: session.code, detail: {} };
    try {
      const backend = session.backend, root = backend.workspaceRoot.replace(/\/$/, "");
      const repository = action.repository === "." ? root : `${root}/${action.repository}`;
      const relative = `.jit-effects/${card.id}.bundle`, inBox = `${root}/${relative}`;
      const refs = action.updates.map((update, index) => ({ ref: `refs/jit-effect/${card.id}/${index}`, sha: update.newSha }));
      const g = `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C ${quote(repository)}`;
      const command = [
        `mkdir -p ${quote(`${root}/.jit-effects`)}`,
        ...refs.map(item => `${g} update-ref ${quote(item.ref)} ${item.sha}`),
        `${g} bundle create --quiet ${quote(inBox)} ${refs.map(item => quote(item.ref)).join(" ")}`,
      ].join(" && ");
      const cleanup = refs.map(item => `${g} update-ref -d ${quote(item.ref)} >/dev/null 2>&1`).join("; ");
      const created = await backend.spawn({ command: `${command}; status=$?; ${cleanup}; exit $status`, cwd: root, timeoutMs: 300_000 });
      if (created.exitCode !== 0) return { outcome: "failed", reason: "stale", detail: { step: "bundle_create" } };
      const limit = this.#options.bundleBytes ?? 256 * 1024 * 1024;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for await (const chunk of backend.readFile(inBox)) {
          size += chunk.length;
          if (size > limit) return { outcome: "failed", reason: "bundle_too_large", detail: { limit } };
          chunks.push(chunk);
        }
      } catch { return { outcome: "failed", reason: "bundle_unreadable", detail: {} }; }
      finally { await backend.spawn({ command: `rm -f ${quote(inBox)}`, cwd: root, timeoutMs: 30_000 }).catch(() => undefined); }
      const path = join(work, "effect.bundle");
      writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
      return { path };
    } finally {
      session.release();
    }
  }

  /**
   * The project's Jit-owned bare mirror with fixed configuration, rewritten on every use, and the fixed git
   * environment: no system or global config, an empty private home, no prompts, and `GIT_ASKPASS` answering only
   * with the released credential passed through the environment of the push itself.
   */
  #mirror(projectId: string, work: string): { path: string; env: (secret?: string) => Record<string, string> } {
    const path = join(this.#options.mirrorRoot!, projectId, "mirror.git");
    const home = join(work, "home"), askpass = join(work, "askpass.sh");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(askpass, "#!/bin/sh\ncase \"$1\" in\n  Username*) printf '%s\\n' \"$JIT_EFFECT_USER\" ;;\n  *) printf '%s\\n' \"$JIT_EFFECT_SECRET\" ;;\nesac\n", { mode: 0o700 });
    const env = (secret?: string): Record<string, string> => ({
      PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin", HOME: home, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, GIT_SSH_COMMAND: "false",
      ...(secret !== undefined ? { JIT_EFFECT_USER: "x-access-token", JIT_EFFECT_SECRET: secret } : {}),
    });
    if (!existsSync(join(path, "HEAD"))) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const init = Bun.spawnSync(["git", "init", "--quiet", "--bare", path], { env: env(), stdout: "ignore", stderr: "ignore" });
      if (init.exitCode !== 0) throw new AppError("effect_mirror_unavailable", 503);
    }
    // Fixed configuration and no hooks, whatever was there before.
    writeFileSync(join(path, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n", { mode: 0o600 });
    rmSync(join(path, "hooks"), { recursive: true, force: true });
    return { path, env };
  }
}

/** Runs host git with a fixed environment; output is bounded and redacted before it is kept anywhere. */
async function runGit(env: Record<string, string>, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (signal?.aborted) return { code: null, stdout: "", stderr: "aborted" };
  const proc = Bun.spawn(["git", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => { try { proc.kill("SIGKILL"); } catch { /* Exited. */ } };
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: proc.signalCode ? null : code, stdout: stdout.slice(0, 65_536), stderr: stderr.slice(0, 65_536) };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", kill); }
}

/**
 * Classifies a `git push --porcelain --atomic` result: exit 0 is success; a rejection line (`!`) is `failed`, as
 * `lease_rejected` when the remote moved away from the approved old SHA; anything else (killed, no porcelain
 * verdict) is `unknown` — the remote may or may not have been updated.
 */
function pushOutcome(result: { code: number | null; stdout: string; stderr: string }, action: Extract<EffectAction, { kind: "effect.git_push" }>): Outcome {
  const lines = result.stdout.split("\n").filter(line => /^[ +\-*=!]\t/.test(line));
  const refs = lines.map(line => { const [flag, refs, summary] = line.split("\t"); return { flag: flag!, ref: (refs ?? "").split(":")[1] ?? "", summary: clip(summary ?? "", 200) }; });
  const detail = { refs, updates: action.updates.map(update => ({ ref: update.ref, oldSha: update.oldSha, newSha: update.newSha })) };
  if (result.code === 0) return { outcome: "succeeded", reason: null, detail };
  const rejected = refs.filter(ref => ref.flag === "!");
  if (rejected.length) return { outcome: "failed", reason: rejected.some(ref => /stale info|fetch first|lease/.test(ref.summary)) ? "lease_rejected" : "push_rejected", detail };
  return { outcome: "unknown", reason: "push_unconfirmed", detail: { ...detail, stderr: clip(result.stderr, 500) } };
}

/** The host of a page URL (no path, query or credential), or `page`. */
function hostOf(url: string): string {
  try { return new URL(url).host || "page"; } catch { return "page"; }
}

/** The scheme, host and path of an endpoint — never a query or credential. */
function endpointOf(url: string): string {
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; } catch { return "invalid"; }
}

const fill = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{([a-z]+)\}/g, (token, name: string) => Object.hasOwn(values, name) ? values[name]! : token);

/** A short, credential-free summary of what the card did, in technical terms (refs, endpoints, numbers). */
function subjectOf(card: ApprovalCard): string {
  const action = card.action;
  switch (action.kind) {
    case "effect.git_push": return `${action.remote.name} ${action.updates.map(update => `${update.ref.slice(11)} ${update.oldSha?.slice(0, 12) ?? "∅"}→${update.newSha.slice(0, 12)}`).join(", ")}`;
    case "effect.github_pr_create": return `${action.github.owner}/${action.github.repo} ${action.head}→${action.base}`;
    case "effect.github_comment": return `${action.github.owner}/${action.github.repo} #${action.issueNumber}`;
    case "effect.github_pr_merge": return `${action.github.owner}/${action.github.repo} #${action.pullNumber} @${action.headSha.slice(0, 12)}`;
    case "effect.deploy": return `${action.target.name}${action.ref ? ` @${action.ref}` : ""}`;
    case "mcp_tool": return `${action.server.name} ${action.tool}`;
    case "browser_confirm": return `${action.operation} "${action.element.name.slice(0, 80) || action.element.tag}" @ ${hostOf(action.url)}`;
  }
}

/**
 * Posts the outcome to the card's topic as a service-attributed source and message, in the owner's language. Fixed
 * product text with technical identifiers only; it never contains a credential or model output.
 */
function postResult(tx: AppTransaction, card: ApprovalCard, now: number): void {
  if (card.state !== "succeeded" && card.state !== "failed" && card.state !== "unknown") return;
  if (!tx.get("SELECT 1 FROM topics WHERE project_id = ? AND id = ?", card.projectId, card.topicId)) return;
  const words = dictionaries[readPersona(tx).language];
  const text = fill(words[`effects.result.${card.state}`], { kind: card.kind, subject: subjectOf(card), reason: card.reason ?? "-", card: card.id.slice(0, 8) });
  const source = commitServiceOutput(tx, { projectId: card.projectId, service: "jit-effects", text: clip(text, 4000), committedAt: now });
  const topic = tx.get<{ sequence: number }>("SELECT message_sequence AS sequence FROM topics WHERE project_id = ? AND id = ?", card.projectId, card.topicId)!;
  tx.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), card.projectId, card.topicId, topic.sequence + 1, now,
    JSON.stringify({ kind: "service", service: "jit-effects" }), source.sourceId, source.revision, source.generation);
  tx.run("UPDATE topics SET message_sequence = message_sequence + 1 WHERE project_id = ? AND id = ?", card.projectId, card.topicId);
}

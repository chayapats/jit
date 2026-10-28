import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../../src/application";
import { readConfig } from "../../src/config";
import { accessConfirmToken, type AccessLevel } from "../../src/exec/access";
import type { ApprovalCard, AutoApproveScope, EffectKind } from "../../src/exec/approval-cards";
import { BoxManager } from "../../src/exec/box-manager";
import { ConnectionVault } from "../../src/exec/connections";
import { EffectExecutor, type EffectExecutorOptions } from "../../src/exec/effect-executor";
import { FakeBoxRuntime, type FakeBoxExec, type FakeBoxStream } from "../../src/exec/fake-box-runtime";
import { McpGateway } from "../../src/exec/mcp-gateway";
import { BrowserService } from "../../src/exec/browser";
import { ComputerService } from "../../src/exec/computer";
import { JobQueue } from "../../src/jobs/queue";
import { TransactionStore } from "../../src/store";
import { discussionPlanWork, specialistAnalysisWork } from "../../src/team/dispatch";
import { jitReplyWork } from "../../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome, type RunScript } from "../../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../../src/team/types";
import { localBox, localExec } from "./box-local-runner";

export const epoch = 1_800_000_000_000;
export const rid = () => crypto.randomUUID();
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };

/** A scripted complete answer with coherent fixture usage. */
export const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});

/** One recorded protocol-fixture HTTP request. */
export interface FetchCall { url: string; method: string; headers: Record<string, string>; body: unknown }
export type FetchReply = (call: FetchCall, signal: AbortSignal | null) => Response | Promise<Response>;

export interface EffectFixtureOptions {
  script?: RunScript; fetch?: FetchReply; executor?: Partial<EffectExecutorOptions>; effects?: boolean;
  /** Wraps the box's runner handler (for gating one request). */
  exec?: (local: FakeBoxExec) => FakeBoxExec;
  /** Long-lived pipes of the fake box and its sidecars (MCP servers, the CDP relay). */
  stream?: FakeBoxStream;
  /** app.mcp_servers/v1: wires an MCP gateway into the runs, the executor and the application. */
  mcp?: boolean;
  /** exec.browser/v1: boxes open with the profile (the browser image) and a browser service is wired in. */
  browser?: boolean;
}

/** The pinned image MCP sidecars use in fixtures. */
export const fixtureBoxImage = `localhost/jit-box@sha256:${"b".repeat(64)}`;

/**
 * An installation for EXE07: a `full`-capable project whose box is a local directory running the real runner, an
 * owner connection vault, the effect executor (with protocol-fixture HTTP and an optional local bare remote) and a
 * scripted team port whose runs admit the effect tools at `full`.
 */
export async function effectFixture(options: EffectFixtureOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-exe07-")));
  const box = localBox("jit-exe07-box-");
  const state = join(root, "state"), backups = join(root, "backups"), execution = join(root, "execution"), secrets = join(root, "secrets");
  mkdirSync(state); mkdirSync(execution);
  const config = readConfig({ JIT_DATABASE: join(state, "jit.sqlite"), JIT_EXECUTION_DIR: execution, JIT_EXECUTION_SECRETS_DIR: secrets,
    JIT_EXECUTION_FULL_ALLOWED: "1", JIT_JOB_CONCURRENCY: "4", JIT_JOB_ROUTE_CONCURRENCY: "4" });
  const store = new TransactionStore(config.databasePath);
  const clock = { now: epoch };
  const now = () => clock.now;
  const runtime = new FakeBoxRuntime({ exec: options.exec ? options.exec(localExec(box)) : localExec(box), workspaceRoot: box.root, temporaryDirectory: box.tmp,
    executionDirectory: execution, ...(options.stream ? { stream: options.stream } : {}) });
  const boxes = new BoxManager(store, config, runtime, { now, ...(options.browser ? { profile: true } : {}) });
  const vault = new ConnectionVault(secrets, { forbidden: [state, backups, execution] });
  const browser = options.browser ? new BrowserService(store, { boxes, runtime, now, commandMs: 1_000 }) : null;
  if (browser) boxes.onStopped(projectId => browser.close(projectId));
  const computer = browser ? new ComputerService(store, browser, { now }) : null;
  const mcp = options.mcp ? new McpGateway(store, { boxes, runtime, vault, sidecarImage: fixtureBoxImage, executionDirectory: execution, now, requestMs: 1_000, callMs: 5_000, installMs: 5_000 }) : null;
  const fetches: FetchCall[] = [];
  const reply: FetchReply = options.fetch ?? (() => new Response(JSON.stringify({}), { status: 200 }));
  const executor = new EffectExecutor(store, {
    vault, boxes, mirrorRoot: execution, now, tempRoot: root, performers: { ...(mcp ? { mcp_tool: mcp.perform } : {}), ...(browser ? { browser_confirm: browser.perform } : {}), ...(computer ? { computer_confirm: computer.perform } : {}) },
    fetch: async (url, init) => {
      const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      const call = { url, method: String(init.method), headers, body: init.body ? JSON.parse(String(init.body)) : null };
      fetches.push(call);
      return reply(call, init.signal ?? null);
    },
    ...options.executor,
  });
  const script: RunScript = options.script ?? ((request, _s, _o, tools) => answer(request, JSON.stringify({ reply: tools.names.join(",") })));
  const seen: ApplicationRunRequest[] = [];
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, (request, signal, observe, tools) => { seen.push(request); return script(request, signal, observe, tools); },
    undefined, undefined, { execution: { boxes, now, ...(options.effects === false ? {} : { effects: executor }), ...(mcp ? { mcp } : {}), ...(browser ? { browser } : {}), ...(computer ? { computer } : {}) } });
  let queueRef: JobQueue | undefined;
  const current = () => queueRef;
  const queue = new JobQueue(store, config.jobs, [discussionPlanWork(), specialistAnalysisWork(store, config, port, now, current), jitReplyWork(store, config, port, now, current)],
    { now, timers: { set: () => 0, clear: () => {} }, boxes });
  queueRef = queue;
  const app = new Application(store, config, { now, jobs: queue, boxes, connections: vault, backupDir: backups, ...(options.effects === false ? {} : { effects: executor }),
    ...(mcp ? { mcp } : {}), ...(browser ? { browser } : {}) });
  const password = "fixture-exe07-owner-password";
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const telegram = app.issueAdapterActor(token, "telegram");
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "โครงการ effect" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "ส่งงาน" } }).topic;
  const jitId = app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(auth.actor).ownerRevision,
    payload: { roleId: null, name: "จิต", kind: "coordinator", responsibility: "ตอบเจ้าของและส่งงาน", enabled: true, route: grok } }).role!.id;
  const close = async () => { queue.close(); await queue.idle(); await executor.idle(); await mcp?.idle(); store.close(); };
  return { root, box, state, execution, secrets, config, store, clock, runtime, boxes, vault, executor, mcp, browser, computer, fetches, port, queue, app, auth, telegram, project, topic, jitId, seen, close, token };
}
export type EffectFixture = Awaited<ReturnType<typeof effectFixture>>;

export function setLevel(f: EffectFixture, level: AccessLevel) {
  const state = f.app.projectAccess(f.auth.actor, f.project.id);
  const widening = ["read", "workspace", "full"].indexOf(level) > ["read", "workspace", "full"].indexOf(state.level);
  return f.app.execute(f.auth.actor, { kind: "access.level.set", requestId: rid(), projectId: f.project.id, expectedRevision: state.revision,
    payload: widening ? { level, confirmToken: accessConfirmToken(f.project.id, state.level, level, state.revision) } : { level } });
}

/** A Web-created connection of `kind` holding `secret`; returns its id. */
export function connection(f: EffectFixture, kind: "github_token" | "deploy_secret" | "mcp_env", secret: string): string {
  const created = f.app.execute(f.auth.actor, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind, label: `fixture ${kind}`, projectScope: null } }).connection;
  f.app.execute(f.auth.actor, { kind: "connection.set_secret", requestId: rid(), projectId: null, expectedRevision: created.revision, payload: { connectionId: created.id, secret } });
  return created.id;
}

export function setRemote(f: EffectFixture, connectionId: string, options: { name?: string; url?: string; github?: { owner: string; repo: string; apiBase: string } | null } = {}) {
  const name = options.name ?? "origin";
  const current = f.app.effectSettings(f.auth.actor, f.project.id).remotes.find(remote => remote.name === name)?.revision ?? 0;
  return f.app.execute(f.auth.actor, { kind: "effect.target.set", requestId: rid(), projectId: f.project.id, expectedRevision: current,
    payload: { target: "git_remote", name, url: options.url ?? "https://github.com/owner/repo.git",
      github: options.github === undefined ? { owner: "owner", repo: "repo", apiBase: "https://api.github.com" } : options.github, connectionId } });
}

export function setDeploy(f: EffectFixture, connectionId: string, name = "production", url = "https://deploy.example.test/hooks/jit") {
  const current = f.app.effectSettings(f.auth.actor, f.project.id).deploys.find(target => target.name === name)?.revision ?? 0;
  return f.app.execute(f.auth.actor, { kind: "effect.target.set", requestId: rid(), projectId: f.project.id, expectedRevision: current,
    payload: { target: "deploy", name, url, connectionId } });
}

export function setRule(f: EffectFixture, effectKind: EffectKind, scope: AutoApproveScope, enabled = true, actor: OwnerActor = f.auth.actor) {
  const current = f.app.effectSettings(f.auth.actor, f.project.id).rules.find(rule => rule.effectKind === effectKind)?.revision ?? 0;
  return f.app.execute(actor, { kind: "approval.rule.set", requestId: rid(), projectId: f.project.id, expectedRevision: current, payload: { effectKind, scope, enabled } });
}

export function decide(f: EffectFixture, card: Pick<ApprovalCard, "id" | "digest" | "revision">, decision: "approve" | "deny", actor: OwnerActor = f.auth.actor, requestId = rid()) {
  return f.app.execute(actor, { kind: "approval.decide", requestId, projectId: f.project.id, expectedRevision: card.revision, payload: { cardId: card.id, digest: card.digest, decision } });
}

export function send(f: EffectFixture, text: string) {
  const topic = f.app.conversation(f.auth.actor, f.project.id, f.topic.id).topic;
  return f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: f.topic.id, text } });
}
export async function settle(f: EffectFixture) { f.queue.pump(); await f.queue.idle(); await f.executor.idle(); await f.mcp?.idle(); }
export const texts = (f: EffectFixture) => f.app.conversation(f.auth.actor, f.project.id, f.topic.id).items.map(item => (item as { text?: string }).text ?? "");
export const cards = (f: EffectFixture) => f.app.approvalCards(f.auth.actor, f.project.id);

/** Runs git in a local directory with a clean environment (fixture repositories, never the executor's path). */
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.email=fixture@example.test", "-c", "user.name=Fixture", "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

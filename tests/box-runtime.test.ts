import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../src/application";
import { readConfig, type AppConfig } from "../src/config";
import { AppError } from "../src/errors";
import { accessConfirmToken, type AccessLevel } from "../src/exec/access";
import type { ResetBoxCommand } from "../src/exec/box-commands";
import { BoxManager } from "../src/exec/box-manager";
import { boxEnvironmentNames, boxProxyNames } from "../src/exec/box-runtime";
import { FakeBoxRuntime } from "../src/exec/fake-box-runtime";
import { PodmanBoxRuntime, type CommandRunner } from "../src/exec/podman-runtime";
import { startRegistryProxy } from "../src/exec/registry-proxy";
import { dictionaries } from "../src/i18n";
import { JobQueue } from "../src/jobs/queue";
import type { EnqueueJobCommand, JobLimits, WorkDefinition } from "../src/jobs/types";
import { backupImageTables } from "../src/ops/backup";
import { TransactionStore, schemaVersion } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), password = "fixture-exe03-owner-password", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
const image = `localhost/jit-box-base@sha256:${"a".repeat(64)}`, browserImage = `localhost/jit-box-browser@sha256:${"b".repeat(64)}`;
async function ticks(n = 30) { for (let i = 0; i < n; i++) await Bun.sleep(0); }
function rejects(action: () => unknown, code: string, status?: number): AppError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe(code);
    if (status !== undefined) expect((error as AppError).status).toBe(status);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}
async function rejectsAsync(action: () => Promise<unknown>, code: string, status?: number) {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe(code);
    if (status !== undefined) expect((error as AppError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

// ---------------------------------------------------------------------------
// PodmanBoxRuntime over a scripted `podman`
// ---------------------------------------------------------------------------

interface FakeContainer { args: string[]; running: boolean; mounts?: { Type: string; Source: string; Destination: string }[]; privileged?: boolean }
/** A scripted rootless Podman: records argv, keeps containers created from their `create` arguments. */
function scriptedPodman() {
  const calls: string[][] = [], containers = new Map<string, FakeContainer>();
  let network = false;
  const json = (value: unknown) => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array() });
  const done = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }, missing = { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() };
  const run: CommandRunner = async argv => {
    calls.push([...argv]);
    const [a, b, c] = argv;
    if (a === "container" && b === "exists") return containers.has(c!) ? done : missing;
    if (a === "container" && b === "inspect") {
      const box = containers.get(c!)!, args = box.args, value = (flag: string) => args.filter((_, i) => args[i - 1] === flag);
      const labels = Object.fromEntries(value("--label").map(label => label.split("=") as [string, string]));
      const mounts = box.mounts ?? value("--mount").map(spec => {
        const fields = Object.fromEntries(spec.split(",").map(part => part.split("=") as [string, string]));
        return { Type: fields.type!, Source: fields.source!, Destination: fields.destination! };
      });
      const network = args.find(arg => arg.startsWith("--network="))?.slice(10) ?? "pasta";
      return json([{ State: { Running: box.running }, ImageName: args[args.length - 3], Config: { Labels: labels }, Mounts: mounts,
        HostConfig: { Privileged: box.privileged ?? false, ReadonlyRootfs: args.includes("--read-only"), NetworkMode: network, CapAdd: [] } }]);
    }
    if (a === "create") { containers.set(argv[2]!, { args: [...argv], running: false }); return done; }
    if (a === "start") { containers.get(b!)!.running = true; return done; }
    if (a === "stop") { containers.get(argv[argv.length - 1]!)!.running = false; return done; }
    if (a === "rm") { containers.delete(argv[argv.length - 1]!); return done; }
    if (a === "network" && b === "exists") return network ? done : missing;
    if (a === "network" && b === "create") { network = true; return done; }
    if (a === "network" && b === "inspect") return json([{ name: "jit-box-internal", internal: true, subnets: [{ gateway: "10.89.0.1" }] }]);
    if (a === "ps") return json([...containers.entries()].map(([, box]) => ({ State: box.running ? "running" : "exited",
      Labels: Object.fromEntries(box.args.filter((_, i) => box.args[i - 1] === "--label").map(label => label.split("=") as [string, string])) })));
    if (a === "exec") return json({ v: 1, ok: true, result: { type: "directory" } });
    throw new Error(`unexpected podman ${argv.join(" ")}`);
  };
  return { run, calls, containers };
}

function podmanFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-exe03-podman-"))); roots.push(root);
  const state = join(root, "state"), secrets = join(root, "secrets"), execution = join(root, "execution");
  mkdirSync(state); mkdirSync(secrets);
  const config = readConfig({ JIT_DATABASE: join(state, "jit.sqlite"), JIT_EXECUTION_DIR: execution, JIT_EXECUTION_SECRETS_DIR: secrets,
    JIT_BOX_IMAGE_BASE: image, JIT_BOX_IMAGE_BROWSER: browserImage, JIT_BOX_MEMORY_MB: "1024", JIT_BOX_CPUS: "1.5", JIT_BOX_PIDS: "256" });
  const podman = scriptedPodman(), proxies: string[] = [];
  const runtime = new PodmanBoxRuntime({ config: config.execution, run: podman.run, registryProxy: async gateway => { proxies.push(gateway); return `http://${gateway}:3128`; } });
  return { root, state, secrets, execution, config, podman, proxies, runtime };
}
const projectA = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40", projectB = "1b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a41";

test("create applies every hardening flag; workspace uses the internal network and the proxy, full the default network", async () => {
  const f = podmanFixture();
  const handle = await f.runtime.ensure(projectA, "workspace");
  expect(handle).toEqual({ projectId: projectA, name: `jit-box-${projectA}`, mode: "workspace", profile: false, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" });
  const create = f.podman.calls.find(call => call[0] === "create")!;
  for (const flag of ["--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--userns=keep-id", "--pull=never", "--pids-limit=256", "--memory=1024m", "--cpus=1.5",
    "--network=jit-box-internal", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=128m,mode=1777"]) expect(create).toContain(flag);
  expect(create.some(arg => /privileged|--env-host|--volume|podman\.sock|--init/.test(arg))).toBe(false);
  expect(create.slice(-3)).toEqual([image, "sleep", "infinity"]);
  expect(create.filter((arg, i) => create[i - 1] === "--mount")).toEqual([`type=bind,source=${join(f.execution, projectA, "workspace")},destination=/workspace,rw=true`]);
  const env = Object.fromEntries(create.filter((_, i) => create[i - 1] === "--env").map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  expect(Object.keys(env).sort()).toEqual([...boxEnvironmentNames, ...boxProxyNames].sort());
  expect(env.HTTPS_PROXY).toBe("http://10.89.0.1:3128");
  expect(f.proxies).toEqual(["10.89.0.1"]);
  expect(f.podman.calls.some(call => call.join(" ") === "network create --internal --label jit.box=1 jit-box-internal")).toBe(true);
  // Nothing of the service reaches the box: no JIT_* name, no state, secret or database path anywhere in the arguments.
  const text = create.join("\n");
  for (const forbidden of ["JIT_", f.state, f.secrets, "jit.sqlite"]) expect(text).not.toContain(forbidden);
  expect(readdirSync(join(f.execution, projectA))).toEqual(["workspace"]);

  await f.runtime.ensure(projectB, "full");
  const full = f.podman.calls.filter(call => call[0] === "create")[1]!;
  expect(full.some(arg => arg.startsWith("--network"))).toBe(false);
  expect(full.some(arg => /PROXY/i.test(arg))).toBe(false);
  expect(full).toContain("--cap-drop=ALL");
  // The runner is the only command Jit ever execs.
  await f.runtime.exec(handle, { input: new TextEncoder().encode("{}"), timeoutMs: 1000 });
  expect(f.podman.calls.find(call => call[0] === "exec")).toEqual(["exec", "-i", "--workdir", "/", `jit-box-${projectA}`, "/opt/jit/runner"]);
});

test("a level change restarts a running box; the profile is mounted only when requested", async () => {
  const f = podmanFixture();
  await f.runtime.ensure(projectA, "workspace");
  await f.runtime.ensure(projectA, "workspace");
  expect(f.podman.calls.filter(call => call[0] === "create")).toHaveLength(1);
  await f.runtime.ensure(projectA, "full");
  expect(f.podman.calls.filter(call => call[0] === "rm")).toHaveLength(1);
  expect(f.podman.calls.filter(call => call[0] === "create")).toHaveLength(2);
  expect(f.podman.containers.get(`jit-box-${projectA}`)!.args).toContain("jit.box.mode=full");
  expect((await f.runtime.status(projectA))).toMatchObject({ state: "running", mode: "full", profile: false });
  await f.runtime.ensure(projectA, "full", { profile: true });
  const create = f.podman.calls.filter(call => call[0] === "create")[2]!;
  expect(create.filter((arg, i) => create[i - 1] === "--mount").map(spec => spec.split(",")[2])).toEqual(["destination=/workspace", "destination=/profile"]);
  expect(create.slice(-3)[0]).toBe(browserImage);
  await f.runtime.stop({ projectId: projectA });
  expect((await f.runtime.list()).map(box => [box.projectId, box.state, box.mode, box.profile])).toEqual([[projectA, "stopped", "full", true]]);
});

test("a box left by an earlier process with another proxy URL is recreated, not reused", async () => {
  const f = podmanFixture();
  await f.runtime.ensure(projectA, "workspace");
  const podman = f.podman;
  // A new process: same containers, a new proxy on another port.
  const restarted = new PodmanBoxRuntime({ config: f.config.execution, run: podman.run, registryProxy: async gateway => `http://${gateway}:4129` });
  await restarted.ensure(projectA, "workspace");
  expect(podman.calls.filter(call => call[0] === "rm")).toHaveLength(1);
  const create = podman.calls.filter(call => call[0] === "create")[1]!;
  expect(create).toContain("HTTPS_PROXY=http://10.89.0.1:4129");
  await restarted.ensure(projectA, "workspace");
  expect(podman.calls.filter(call => call[0] === "create")).toHaveLength(2);
});

test("inspected mounts must equal the expected set exactly; a tampered box is removed and refused", async () => {
  const f = podmanFixture();
  await f.runtime.ensure(projectA, "workspace");
  const name = `jit-box-${projectA}`, box = f.podman.containers.get(name)!;
  // Someone added the state directory to the running box.
  box.mounts = [{ Type: "bind", Source: join(f.execution, projectA, "workspace"), Destination: "/workspace" }, { Type: "bind", Source: f.state, Destination: "/state" }];
  await rejectsAsync(() => f.runtime.ensure(projectA, "workspace"), "box_mount_mismatch", 503);
  expect(f.podman.containers.has(name)).toBe(false);
  // A missing or retargeted workspace mount is refused the same way, and so is a privileged box.
  await f.runtime.ensure(projectA, "workspace");
  f.podman.containers.get(name)!.mounts = [{ Type: "bind", Source: f.root, Destination: "/workspace" }];
  await rejectsAsync(() => f.runtime.ensure(projectA, "workspace"), "box_mount_mismatch", 503);
  await f.runtime.ensure(projectA, "workspace");
  f.podman.containers.get(name)!.privileged = true;
  await rejectsAsync(() => f.runtime.ensure(projectA, "workspace"), "box_hardening_mismatch", 503);
  expect(f.podman.containers.has(name)).toBe(false);
  // A symlinked workspace directory is never mounted.
  rmSync(join(f.execution, projectB), { recursive: true, force: true });
  mkdirSync(join(f.execution, projectB), { recursive: true });
  symlinkSync(f.state, join(f.execution, projectB, "workspace"));
  await rejectsAsync(() => f.runtime.ensure(projectB, "workspace"), "box_directory_unsafe", 503);
  expect(f.podman.containers.has(`jit-box-${projectB}`)).toBe(false);
});

test("reset removes the container and wipes the workspace only when asked", async () => {
  const f = podmanFixture();
  await f.runtime.ensure(projectA, "workspace");
  Bun.write(join(f.execution, projectA, "workspace", "kept.txt"), "kept");
  await Bun.sleep(5);
  await f.runtime.reset({ projectId: projectA }, { wipeWorkspace: false });
  expect(f.podman.containers.has(`jit-box-${projectA}`)).toBe(false);
  expect(readFileSync(join(f.execution, projectA, "workspace", "kept.txt"), "utf8")).toBe("kept");
  await f.runtime.ensure(projectA, "workspace");
  await f.runtime.reset({ projectId: projectA }, { wipeWorkspace: true });
  expect(existsSync(join(f.execution, projectA, "workspace"))).toBe(false);
  rejects(() => new PodmanBoxRuntime({ config: { ...f.config.execution, directory: null }, run: f.podman.run }), "box_not_configured", 503);
});

// ---------------------------------------------------------------------------
// BoxManager, the queue and the owner commands
// ---------------------------------------------------------------------------

/** A fake clock whose timers fire only when the test advances it. */
class Clock {
  now = epoch; #id = 0; #timers = new Map<number, { at: number; callback: () => void }>();
  timers = { set: (callback: () => void, ms: number) => { const id = ++this.#id; this.#timers.set(id, { at: this.now + ms, callback }); return id; }, clear: (id: unknown) => { this.#timers.delete(id as number); } };
  advance(ms: number) { this.now += ms; for (const [id, timer] of [...this.#timers]) if (timer.at <= this.now) { this.#timers.delete(id); timer.callback(); } }
}
const boxWorkId = "fixture.box-work";
const limits: JobLimits = { roles: 2, calls: 2, rounds: 2, hops: 2, contextTokens: 10, outputTokens: 10, retries: 1, wallMs: 3_600_000 };
interface Gate { promise: Promise<void>; release: () => void }
const gate = (): Gate => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

async function fixture(env: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-exe03-"))); roots.push(root);
  const state = join(root, "state"), secrets = join(root, "secrets"); mkdirSync(state); mkdirSync(secrets);
  const config: AppConfig = readConfig({ JIT_DATABASE: join(state, "jit.sqlite"), JIT_EXECUTION_DIR: join(root, "execution"), JIT_EXECUTION_SECRETS_DIR: secrets,
    JIT_BOX_IMAGE_BASE: image, JIT_BOX_MAX: "2", JIT_EXECUTION_FULL_ALLOWED: "1", JIT_JOB_CONCURRENCY: "6", JIT_JOB_ROUTE_CONCURRENCY: "6", JIT_JOB_WALL_MS: "3600000", ...env });
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const clock = new Clock(), runtime = new FakeBoxRuntime({ executionDirectory: join(root, "execution") });
  let queueRef: JobQueue | undefined;
  const boxes = new BoxManager(store, config, runtime, { now: () => clock.now, onCapacity: () => queueRef?.pump() });
  const gates = new Map<string, Gate>(), opened: string[] = [];
  const work: WorkDefinition = {
    id: boxWorkId, title: "งานใน box จำลอง", revision: 1, execution: true,
    route: { provider: "fixture-box", model: null, authRoute: "internal" }, cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: input => !!input && typeof input === "object" && !Array.isArray(input) && !Object.keys(input).length,
    run: async context => {
      const session = await boxes.open(context.job.projectId, null);
      opened.push(context.job.projectId);
      await (gates.get(context.job.projectId) ?? { promise: Promise.resolve() }).promise;
      session.release();
      context.commit({ state: "succeeded", evidence: "ทำงานใน box แล้ว" });
      return { state: "succeeded", evidence: "ทำงานใน box แล้ว" };
    },
  };
  const queue = new JobQueue(store, config.jobs, [work], { now: () => clock.now, timers: clock.timers, boxes });
  queueRef = queue; queues.push(queue);
  const app = new Application(store, config, { now: () => clock.now, jobs: queue, boxes });
  const web = createWebHandler(app);
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const telegramActor = app.issueAdapterActor(token, "telegram");
  const project = (name: string) => app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(),
    expectedRevision: store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision), payload: { name } }).project;
  return { root, state, secrets, config, store, clock, runtime, boxes, gates, opened, queue, app, web, token, auth, telegramActor, project };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function setLevel(f: Fixture, projectId: string, level: AccessLevel, actor: OwnerActor = f.auth.actor) {
  const access = f.app.projectAccess(f.auth.actor, projectId);
  return f.app.execute(actor, { kind: "access.level.set", requestId: rid(), projectId, expectedRevision: access.revision,
    payload: { level, ...(level !== "read" ? { confirmToken: accessConfirmToken(projectId, access.level, level, access.revision) } : {}) } });
}
function enqueue(f: Fixture, projectId: string): string {
  const revision = f.app.project(f.auth.actor, projectId).revision;
  const command: EnqueueJobCommand = { kind: "job.enqueue", requestId: rid(), projectId, expectedRevision: revision,
    payload: { type: boxWorkId, configurationRevision: 1, policyRevision: f.config.jobs.revision, purpose: "รันใน box", inputRevision: revision, input: {}, priority: "interactive", limits: structuredClone(limits) } };
  return f.app.execute(f.auth.actor, command).job.id;
}
function reset(f: Fixture, projectId: string, wipeWorkspace: boolean, actor: OwnerActor = f.auth.actor, expectedRevision?: number) {
  const command: ResetBoxCommand = { kind: "execution.box.reset", requestId: rid(), projectId, expectedRevision: expectedRevision ?? f.app.boxStatus(f.auth.actor, projectId).revision, payload: { wipeWorkspace } };
  return f.app.execute(actor, command);
}

test("read never ensures a box; workspace and full open boxes in their own mode; a halted project never reaches the runtime", async () => {
  const f = await fixture();
  const p = f.project("อ่านอย่างเดียว");
  await rejectsAsync(() => f.boxes.open(p.id, null), "access_level_insufficient", 409);
  expect(f.runtime.calls).toEqual([]);
  setLevel(f, p.id, "workspace");
  const session = await f.boxes.open(p.id, null);
  expect(session.handle.mode).toBe("workspace");
  expect(f.runtime.boxes.get(p.id)!.env.HTTPS_PROXY).toMatch(/^http:\/\//);
  session.release();
  setLevel(f, p.id, "full");
  const wider = await f.boxes.open(p.id, null);
  expect(wider.handle.mode).toBe("full");
  expect(f.runtime.calls.filter(call => call.op === "ensure").map(call => call.op === "ensure" && call.outcome)).toEqual(["created", "restarted"]);
  expect(Object.keys(f.runtime.boxes.get(p.id)!.env).sort()).toEqual([...boxEnvironmentNames].sort());
  wider.release();
  f.app.execute(f.auth.actor, { kind: "execution.halt", requestId: rid(), projectId: p.id, expectedRevision: 0, payload: {} });
  await ticks();
  expect(f.runtime.calls.at(-1)).toEqual({ op: "stop", projectId: p.id });
  const before = f.runtime.calls.length;
  await rejectsAsync(() => f.boxes.open(p.id, null), "execution_halted", 409);
  expect(f.runtime.calls.length).toBe(before);
});

test("no Jit environment variable, secret path or state path appears in any box", async () => {
  const f = await fixture();
  for (const [index, level] of (["workspace", "full"] as const).entries()) {
    const p = f.project(`box ${index}`); setLevel(f, p.id, level);
    (await f.boxes.open(p.id, null)).release();
  }
  for (const box of f.runtime.boxes.values()) {
    const text = JSON.stringify(box);
    expect(Object.keys(box.env).filter(name => name.startsWith("JIT_"))).toEqual([]);
    for (const forbidden of [f.state, f.secrets, f.config.databasePath, "JIT_", "telegram"]) expect(text).not.toContain(forbidden);
    expect(box.mounts.map(mount => mount.destination)).toEqual(["/workspace"]);
    for (const value of Object.values(box.env)) expect(Object.values(process.env).filter(v => v && v.length > 8).includes(value)).toBe(false);
  }
});

test("narrowing below the running mode stops the box; widening applies on the next open", async () => {
  const f = await fixture();
  const p = f.project("แคบลง");
  setLevel(f, p.id, "full");
  (await f.boxes.open(p.id, null)).release();
  setLevel(f, p.id, "workspace");
  await ticks();
  expect(f.runtime.running()).toEqual([]);
  (await f.boxes.open(p.id, null)).release();
  expect(f.runtime.boxes.get(p.id)!.mode).toBe("workspace");
  setLevel(f, p.id, "full");
  await ticks();
  expect(f.runtime.running()).toEqual([p.id]);
  expect(f.runtime.boxes.get(p.id)!.mode).toBe("workspace");
  setLevel(f, p.id, "read");
  await ticks();
  expect(f.runtime.running()).toEqual([]);
});

test("the third box over maxBoxes=2 waits as box_capacity without spinning and starts after one stops by idle sweep", async () => {
  const f = await fixture();
  const projects = [f.project("หนึ่ง"), f.project("สอง"), f.project("สาม")];
  for (const p of projects) { setLevel(f, p.id, "workspace"); f.gates.set(p.id, gate()); }
  const jobs = projects.map(p => enqueue(f, p.id));
  f.queue.pump(); await ticks();
  expect(f.opened.sort()).toEqual([projects[0]!.id, projects[1]!.id].sort());
  const waiting = f.app.job(f.auth.actor, projects[2]!.id, jobs[2]!);
  expect([waiting.state, waiting.reason, waiting.nextAction]).toEqual(["queued", "box_capacity", "wait_for_box_capacity"]);
  // Pumping again does not rewrite the waiting job.
  const revision = waiting.revision;
  for (let i = 0; i < 5; i++) f.queue.pump();
  await ticks();
  expect(f.app.job(f.auth.actor, projects[2]!.id, jobs[2]!).revision).toBe(revision);
  // The first job finishes but its box stays up: capacity is still full until the box stops.
  f.gates.get(projects[0]!.id)!.release(); await ticks();
  expect(f.app.job(f.auth.actor, projects[0]!.id, jobs[0]!).state).toBe("succeeded");
  f.queue.pump(); await ticks();
  expect(f.opened).toHaveLength(2);
  // Not idle long enough yet.
  f.clock.advance(29 * 60_000);
  expect(await f.boxes.sweep(f.clock.now)).toEqual([]);
  f.clock.advance(60_000);
  expect(await f.boxes.sweep(f.clock.now)).toEqual([projects[0]!.id]);
  await ticks();
  expect(f.opened).toContain(projects[2]!.id);
  expect(f.app.job(f.auth.actor, projects[2]!.id, jobs[2]!).state).toBe("admitted");
  // A box in use is never stopped by the sweep, however long ago it opened.
  f.clock.advance(120 * 60_000);
  expect(await f.boxes.sweep(f.clock.now)).toEqual([]);
  expect(f.runtime.running()).toEqual([projects[1]!.id, projects[2]!.id].sort());
  for (const p of projects) f.gates.get(p.id)!.release();
  await ticks();
});

test("a narrowing that commits while a box opens or runs refuses every later command; kill still reaches the box", async () => {
  const f = await fixture();
  const p = f.project("ถอนสิทธิ์");
  setLevel(f, p.id, "workspace");
  // Narrow to read while ensure is in flight.
  let release!: () => void;
  const gateEnsure = new Promise<void>(resolve => { release = resolve; });
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (...args) => { await gateEnsure; return ensure(...args); };
  const opening = f.boxes.open(p.id, null);
  await ticks();
  setLevel(f, p.id, "read");
  release();
  await rejectsAsync(() => opening, "access_level_insufficient", 409);
  expect(f.runtime.running()).toEqual([]);
  f.runtime.ensure = ensure;
  // Narrow while a session is open: the backend refuses new requests, but cancellation still goes through.
  setLevel(f, p.id, "workspace");
  const session = await f.boxes.open(p.id, null);
  const before = f.runtime.calls.filter(call => call.op === "exec").length;
  f.app.execute(f.auth.actor, { kind: "execution.halt", requestId: rid(), projectId: p.id, expectedRevision: f.app.projectAccess(f.auth.actor, p.id).haltRevision, payload: {} });
  await expect(session.backend.stat("/workspace")).rejects.toMatchObject({ code: "EIO" });
  expect(f.runtime.calls.filter(call => call.op === "exec").length).toBe(before);
  session.release();
});

test("a stop that fails keeps the slot and its capacity until a later sweep confirms it", async () => {
  const f = await fixture({ JIT_BOX_MAX: "1" });
  const [a, b] = [f.project("หยุดไม่ได้"), f.project("รอ")];
  setLevel(f, a.id, "workspace"); setLevel(f, b.id, "workspace");
  (await f.boxes.open(a.id, null)).release();
  const stop = f.runtime.stop.bind(f.runtime);
  f.runtime.stop = async () => { throw new AppError("box_runtime_unavailable", 503); };
  f.clock.advance(31 * 60_000);
  expect(await f.boxes.sweep(f.clock.now)).toEqual([]);
  expect(f.boxes.holding()).toEqual([a.id]);
  expect(f.store.read(tx => f.boxes.hasCapacity(tx, b.id))).toBe(false);
  await rejectsAsync(() => f.boxes.open(b.id, null), "box_capacity", 409);
  f.runtime.stop = stop;
  expect(await f.boxes.sweep(f.clock.now)).toEqual([a.id]);
  expect(f.boxes.holding()).toEqual([]);
  expect(f.store.read(tx => f.boxes.hasCapacity(tx, b.id))).toBe(true);
});

test("during a reset the project admits no execution work until the receipt commits", async () => {
  const f = await fixture();
  const p = f.project("กันระหว่าง reset");
  setLevel(f, p.id, "workspace");
  let release!: () => void;
  const gateReset = new Promise<void>(resolve => { release = resolve; });
  const resetRuntime = f.runtime.reset.bind(f.runtime);
  f.runtime.reset = async (...args) => { await gateReset; return resetRuntime(...args); };
  const resetting = reset(f, p.id, true);
  await ticks();
  expect(f.store.read(tx => f.boxes.hasCapacity(tx, p.id))).toBe(false);
  const job = enqueue(f, p.id); f.queue.pump(); await ticks();
  expect(f.app.job(f.auth.actor, p.id, job)).toMatchObject({ state: "queued", reason: "box_capacity" });
  await rejectsAsync(() => f.boxes.open(p.id, null), "box_busy", 409);
  release();
  expect((await resetting).box.revision).toBe(1);
  await ticks();
  expect(f.opened).toEqual([p.id]);
});

test("a failed ensure releases its slot, and a direct open beyond capacity is refused", async () => {
  const f = await fixture({ JIT_BOX_MAX: "1" });
  const [a, b] = [f.project("ก"), f.project("ข")];
  setLevel(f, a.id, "workspace"); setLevel(f, b.id, "workspace");
  f.runtime.failNextEnsure = new AppError("box_runtime_unavailable", 503);
  await rejectsAsync(() => f.boxes.open(a.id, null), "box_runtime_unavailable", 503);
  expect(f.boxes.holding()).toEqual([]);
  const session = await f.boxes.open(a.id, null);
  await rejectsAsync(() => f.boxes.open(b.id, null), "box_capacity", 409);
  session.release();
});

test("reset is Web only, revisioned, refuses while busy and wipes the workspace only when asked", async () => {
  const f = await fixture();
  const p = f.project("รีเซ็ต");
  setLevel(f, p.id, "workspace");
  (await f.boxes.open(p.id, null)).release();
  // Telegram and the local API may not reset.
  await rejectsAsync(() => reset(f, p.id, false, f.telegramActor), "box_reset_requires_web", 403);
  f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: f.app.localApi(f.auth.actor).revision, payload: { enabled: true } });
  await rejectsAsync(() => reset(f, p.id, false, f.app.issueLocalApiActor()!.actor), "box_reset_requires_web", 403);
  expect(f.runtime.calls.some(call => call.op === "reset")).toBe(false);
  // A running execution attempt makes the box busy.
  f.gates.set(p.id, gate());
  const job = enqueue(f, p.id); f.queue.pump(); await ticks();
  expect(f.app.job(f.auth.actor, p.id, job).state).toBe("admitted");
  await rejectsAsync(() => reset(f, p.id, true), "box_busy", 409);
  expect(f.app.boxStatus(f.auth.actor, p.id)).toMatchObject({ revision: 0, busy: true, holding: true });
  f.gates.get(p.id)!.release(); await ticks();
  // A plain reset keeps the workspace; the receipt replays.
  const command = { kind: "execution.box.reset" as const, requestId: rid(), projectId: p.id, expectedRevision: 0, payload: { wipeWorkspace: false } };
  const first = await f.app.execute(f.auth.actor, command);
  expect(first.box).toMatchObject({ projectId: p.id, revision: 1, lastReset: { revision: 1, wipeWorkspace: false, channel: "web" }, holding: false, busy: false });
  expect(await f.app.execute(f.auth.actor, command)).toEqual(first);
  expect(f.runtime.wipes(p.id)).toBe(0);
  expect(f.runtime.calls.filter(call => call.op === "reset")).toEqual([{ op: "reset", projectId: p.id, wipeWorkspace: false }]);
  await rejectsAsync(() => reset(f, p.id, true, f.auth.actor, 0), "stale_revision", 409);
  await rejectsAsync(() => f.app.execute(f.auth.actor, { ...command, payload: { wipeWorkspace: true } }), "request_id_conflict", 409);
  await reset(f, p.id, true);
  expect(f.runtime.wipes(p.id)).toBe(1);
  expect(f.app.boxStatus(f.auth.actor, p.id).revision).toBe(2);
  await rejectsAsync(() => f.app.execute(f.auth.actor, { ...command, requestId: rid(), payload: {} } as unknown as ResetBoxCommand), "invalid_box_command");
  const audit = f.store.read(tx => tx.all<{ kind: string }>("SELECT command_kind AS kind FROM audit WHERE project_id = ? AND command_kind = 'execution.box.reset'", p.id));
  expect(audit).toHaveLength(2);
});

test("the JSON API serves box state and the Web reset with CSRF; without boxes reset is box_not_configured", async () => {
  const f = await fixture();
  const p = f.project("api");
  const get = await f.web(new Request(`${origin}/api/projects/${p.id}/execution/box`, { headers: { cookie: `jit_session=${f.token}` } }));
  expect(await get.json()).toEqual({ box: { projectId: p.id, revision: 0, lastReset: null, holding: false, busy: false } });
  const post = (body: unknown, csrf: string | null = f.auth.csrf) => f.web(new Request(`${origin}/api/projects/${p.id}/execution/box/reset`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, cookie: `jit_session=${f.token}`, ...(csrf ? { "x-csrf-token": csrf } : {}) } }));
  expect((await post({ requestId: rid(), expectedRevision: 0, wipeWorkspace: false }, null)).status).toBe(403);
  const ok = await post({ requestId: rid(), expectedRevision: 0, wipeWorkspace: true });
  expect(ok.status).toBe(200);
  expect((await ok.json()).box).toMatchObject({ revision: 1, lastReset: { wipeWorkspace: true } });
  expect((await post({ requestId: rid(), expectedRevision: 1, wipeWorkspace: false, extra: 1 })).status).toBe(400);
  const bare = new Application(f.store, f.config, { now: () => f.clock.now, jobs: f.queue });
  const actor = bare.authenticate(await bare.login(password)).actor;
  await rejectsAsync(() => bare.execute(actor, { kind: "execution.box.reset", requestId: rid(), projectId: p.id, expectedRevision: 1, payload: { wipeWorkspace: false } }), "box_not_configured", 503);
});

// ---------------------------------------------------------------------------
// Registry allowlist proxy
// ---------------------------------------------------------------------------

test("the registry proxy tunnels only allowlisted hosts on 443 and logs refused hosts by name only", async () => {
  const upstream = createServer(socket => socket.on("data", (data: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), data]))));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port, logs: string[] = [], dialed: string[] = [];
  const proxy = await startRegistryProxy({ hostname: "127.0.0.1", port: 0, hosts: ["registry.npmjs.org", "pypi.org"], log: line => logs.push(line),
    connectUpstream: (host, port) => { dialed.push(`${host}:${port}`); return connect({ host: "127.0.0.1", port: upstreamPort }); } });
  const talk = (head: string, after?: string) => new Promise<string>(resolve => {
    const socket: Socket = connect({ host: "127.0.0.1", port: proxy.port });
    let text = "", sent = false;
    socket.on("data", data => { text += data.toString(); if (after && !sent && text.includes("\r\n\r\n")) { sent = true; socket.write(after); } if (after && text.includes("echo:")) socket.end(); });
    socket.on("close", () => resolve(text)); socket.on("error", () => resolve(text));
    socket.write(head);
  });
  try {
    const tunnel = await talk("CONNECT Registry.NPMJS.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n", "hello");
    expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(tunnel).toContain("echo:hello");
    expect(dialed).toEqual(["registry.npmjs.org:443"]);
    expect(await talk("CONNECT example.com:443 HTTP/1.1\r\nAuthorization: Basic c2VjcmV0\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await talk("CONNECT pypi.org:80 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await talk("CONNECT 151.101.0.1:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await talk("GET http://registry.npmjs.org/left-pad?token=abc HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 405");
    expect(dialed).toHaveLength(1);
    expect(logs).toEqual(["registry proxy refused example.com", "registry proxy refused pypi.org", "registry proxy refused 151.101.0.1", "registry proxy refused method GET"]);
    expect(logs.join("\n")).not.toMatch(/c2VjcmV0|token|left-pad|Authorization/);
  } finally { await proxy.close(); upstream.close(); }
});

// ---------------------------------------------------------------------------
// Schema, backup classification and dictionaries
// ---------------------------------------------------------------------------

test("schema 32 installations migrate through the box reset table with their data intact, and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "jit-exe03-migrate-")); roots.push(root);
  const path = join(root, "state.sqlite"), old = new Database(path);
  old.exec(readFileSync(new URL("./fixtures/foundation-v32.sql", import.meta.url), "utf8"));
  expect(old.query("PRAGMA user_version").get()).toEqual({ user_version: 32 });
  const projectId = rid();
  old.query("INSERT INTO projects VALUES (?, ?, 2, ?)").run(projectId, "โครงการเดิม", epoch);
  old.query("INSERT INTO project_access_revisions VALUES (?, 1, 'workspace', 'web', ?)").run(projectId, epoch);
  old.close();
  const migrated = new TransactionStore(path); stores.push(migrated);
  expect(schemaVersion).toBeGreaterThanOrEqual(33);
  expect(migrated.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: schemaVersion });
  expect(readdirSync(root).some(name => name.startsWith("state.sqlite.pre-v32-"))).toBe(true);
  expect(migrated.read(tx => tx.get("SELECT level FROM project_access_revisions WHERE project_id = ?", projectId))).toEqual({ level: "workspace" });
  expect(migrated.read(tx => tx.all("SELECT * FROM execution_box_resets"))).toEqual([]);
  expect(() => migrated.transaction(tx => tx.run("INSERT INTO execution_box_resets VALUES (?, 1, 2, 'web', 0)", projectId))).toThrow();
  expect(migrated.read(tx => tx.all("PRAGMA foreign_key_check"))).toEqual([]);
  migrated.close(); stores.splice(stores.indexOf(migrated), 1);
  const reopened = new TransactionStore(path); stores.push(reopened);
  expect(reopened.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: schemaVersion });
  expect(backupImageTables.execution_box_resets).toBe("include");
});

test("every owner-visible box string exists in Thai and English", () => {
  const keys = Object.keys(dictionaries.th).filter(key => /^(error\.(box_|invalid_box_)|jobs\.box_)/.test(key));
  expect(keys.sort()).toEqual(["error.box_busy", "error.box_capacity", "error.box_directory_unsafe", "error.box_hardening_mismatch", "error.box_image_missing",
    "error.box_mount_mismatch", "error.box_network_unavailable", "error.box_not_configured", "error.box_proxy_unavailable", "error.box_reset_requires_web",
    "error.box_runtime_unavailable", "error.invalid_box_command", "error.invalid_box_mode", "jobs.box_capacity"]);
  for (const key of keys) expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
});


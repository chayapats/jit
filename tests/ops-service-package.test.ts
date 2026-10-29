import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { accessSync, chmodSync, openSync, closeSync, writeSync, readdirSync, constants as fsConstants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedTelegramSender } from "../src/delivery";
import { startFullApp, stopDrain } from "../src/ops/lifecycle";
import type { ChannelTransportFactory } from "../src/ops/service-channels";
import { runServiceCommand } from "../src/ops/service-cli";
import { assertServiceRuntime, rootSnapshotCopyCommand, serviceInvocationPath } from "../src/ops/service-trust";
import { assertRootTree, type RootPathPolicy } from "../ops/package/trusted-paths";
import { freezeInstallerArtifact } from "../ops/package/installer/trusted-paths";
import { installService, planInstall, upgradePackage, type OperatorHost } from "../src/ops/service-package";
import { gatherServiceStatus } from "../src/ops/status";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/ops/supervisor";
import { TransactionStore, inspectStoreSchema, schemaVersion } from "../src/store";
import { TelegramChannel } from "../src/telegram";
import { buildPackage, installArtifactDependencies, readManifest, validateArtifact } from "../ops/package/bun-build";
import { smokeRefusal } from "../ops/package/arm64-smoke";
import { parseServiceConfig, renderServiceUnit, serviceDatabasePath, type ServiceConfig } from "../ops/package/service-config";

/**
 * ops.service_package/v1 deterministic evidence. Simulated here: systemd
 * (a fake supervisor that runs the rendered unit's ExecStart/Environment as
 * a real child process), `getent`, `ip`, dependency installation (links the
 * build host's resolved node_modules) and the new build's `upgrade`
 * outcome in the upgrade-path tests. Not simulated: the artifact build,
 * plan/install file writes, the release symlink, the full application boot,
 * HTTP owner authentication and persisted state. Linux ARM64 and Pi
 * restart/reboot/credential evidence remain OPS05 human gates.
 */
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const stopAll: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stopAll.splice(0)) await stop();
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); await child.exited; } catch { /* Already gone. */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const repoRoot = resolve(import.meta.dir, "..");
const password = "service-package-owner-pw";
const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const chowns: Array<[string, number, number]> = [];
const recordChown = (path: string, owner: number, group: number) => { chowns.push([path, owner, group]); };
const rid = () => crypto.randomUUID();


function layout(port = 3443) {
  const root = mkdtempSync(join(tmpdir(), "jit-service-package-")); roots.push(root);
  const dirs = { opt: join(root, "opt"), work: join(root, "work"), state: join(root, "state"), backup: join(root, "backup"),
    unit: join(root, "etc-systemd-system"), journald: join(root, "etc-systemd"), configDir: join(root, "etc-jit"), local: join(root, ".local") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dirs.work, 0o755);
  const credential = join(root, "telegram-bot.token");
  writeFileSync(credential, "123456:FIXTURE_TOKEN_VALUE_must_not_leak", { mode: 0o600 });
  const service: ServiceConfig = { serviceUser: "jit-service", executablePath: join(dirs.opt, "current"), workingDirectory: dirs.work,
    stateDirectory: dirs.state, ledgerPath: join(dirs.state, "ledger.json"), backupDirectory: dirs.backup,
    routes: [{ route: "codex-subscription", model: "gpt-fixture", configured: true }, { route: "grok-owner", model: null, configured: false }],
    secretRefs: [{ name: "telegram-bot-token", store: "credential-file", key: credential }],
    network: { bindHost: "127.0.0.1", port, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30, stopTimeoutSeconds: 5 } };
  const source = join(dirs.local, "service-config.json");
  writeFileSync(source, JSON.stringify(service), { mode: 0o600 });
  return { root, dirs, service, source, credential };
}

/** Builds an artifact and "installs" dependencies by linking the build host's resolved node_modules (simulated `bun install`). */
/** Build-host packages the runtime never imports; leaving them out keeps the simulated install small. */
const devOnly = new Set(["typescript", "@typescript", "bun-types", "@types", ".bin"]);

/**
 * Builds an artifact and simulates `bun install` for this host. `runnable`
 * copies the build host's resolved production node_modules (a real,
 * symlink-free tree the release can execute); otherwise a tiny placeholder
 * tree is sealed, enough for validation-only tests.
 */
async function artifact(root: string, name: string, options: { runnable?: boolean } = {}): Promise<string> {
  const out = join(root, name);
  buildPackage({ srcDir: repoRoot, outDir: out, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  await installArtifactDependencies(out, { bunPath: process.execPath, run: async (argv, opts) => {
    if (argv[1] === "install") {
      expect(argv).toContain("--linker=hoisted");
      const target = join(opts.cwd!, "node_modules");
      if (options.runnable) {
        cpSync(join(repoRoot, "node_modules"), target, { recursive: true, filter: src => !devOnly.has(src.slice(join(repoRoot, "node_modules").length + 1).split("/")[0]!) });
      } else {
        mkdirSync(join(target, "fixture-dep"), { recursive: true });
        writeFileSync(join(target, "fixture-dep", "index.js"), "export const pinned = 1;\n");
      }
      mkdirSync(join(target, ".bin"), { recursive: true });
      symlinkSync("../fixture-dep/index.js", join(target, ".bin", "fixture"));
      return { exitCode: 0, stdout: "", timedOut: false };
    }
    return { exitCode: 0, stdout: `${Bun.version}\n`, timedOut: false };
  } });
  return out;
}


interface FakeSupervisor {
  run: CommandRunner;
  calls: string[][];
  active: () => boolean;
  upgrade?: (argv: string[], options: CommandOptions) => Promise<CommandResult>;
  identity: string | null;
  group: string | null;
  /** Simulates a path the service identity cannot read inside a staged release. */
  unreadable?: string;
  /** Whether the service identity's user session bus socket exists (`test -S`); absent by default. */
  sessionBus?: boolean;
}

/**
 * Fake systemd: `start` runs the installed unit's ExecStart with its
 * Environment and WorkingDirectory as a real child; `stop` sends SIGTERM and
 * escalates to SIGKILL after TimeoutStopSec, like systemd.
 */
/** In-process service started by the fake supervisor from the release's own modules (no sockets). */
interface RunningRelease { handle: any; web: (request: Request) => Promise<Response>; stopDrain: (handle: any, o: { timeoutMs: number }) => Promise<unknown> }

/**
 * Fake systemd. `start` reads the installed unit, takes its ExecStart
 * (`<release>/src/main.ts serve --service-config <path>`), Environment and
 * TimeoutStopSec, and boots that release's real start path in-process:
 * `readConfig(Environment)`, `readServiceConfigFile(<path>)` and
 * `startFullApp` imported from the release directory, including the real
 * OPS02 ledger checkpoint gate. HTTP goes through the
 * release's `createWebHandler` — no listener or socket. `stop` drains with
 * the unit's stop budget, like SIGTERM handling in serve.
 */
function fakeSupervisor(unitDir: string, options: { spawnService?: boolean } = {}): FakeSupervisor & { running: () => RunningRelease | null } {
  let running: RunningRelease | null = null;
  let simulatedActive = false;
  const fake: FakeSupervisor & { running: () => RunningRelease | null } = {
    calls: [], identity: `jit-service:x:${uid}:${gid}::/var/lib/jit:/usr/sbin/nologin`, group: `jit-service:x:${gid}:`,
    running: () => running,
    active: () => options.spawnService === false ? simulatedActive : running !== null,
    run: async (argv, opts) => {
      fake.calls.push(argv);
      const done = (exitCode: number, stdout = ""): CommandResult => ({ exitCode, stdout, timedOut: false });
      if (argv[0] === "getent" && argv[1] === "group") return fake.group ? done(0, fake.group + "\n") : done(2);
      if (argv[0] === "getent") return fake.identity ? done(0, fake.identity + "\n") : done(2);
      if (argv[0] === "runuser" && argv[4] === "test" && argv[5] === "-S") return done(fake.sessionBus ? 0 : 1);
      if (argv[0] === "runuser" && argv[4] === "test") {
        // The test process plays the service identity: the kernel decides access exactly as for that user.
        const mode = { "-r": fsConstants.R_OK, "-w": fsConstants.W_OK, "-x": fsConstants.X_OK }[argv[5]!];
        try { accessSync(argv[6]!, mode); return done(0); } catch { return done(1); }
      }
      if (argv[0] === "runuser" && argv[4] === "find") {
        if (fake.unreadable) return done(0, `${fake.unreadable}\n`);
        const walk = (path: string): string | null => {
          const stats = lstatSync(path);
          try { accessSync(path, fsConstants.R_OK | (stats.isDirectory() ? fsConstants.X_OK : 0)); } catch { return path; }
          if (stats.isDirectory() && !stats.isSymbolicLink()) for (const name of readdirSync(path)) { const bad = walk(join(path, name)); if (bad) return bad; }
          return null;
        };
        const bad = walk(argv[5]!);
        return done(0, bad ? `${bad}\n` : "");
      }
      if (argv[1] === "--version") return done(0, `${Bun.version}\n`);
      if (argv.includes("upgrade") && fake.upgrade) return fake.upgrade(argv, opts);
      if (argv[0] !== "systemctl") return done(127);
      const verb = argv[1];
      if (verb === "daemon-reload" || verb === "enable") return done(0);
      if (verb === "show") return done(0, `ActiveState=${fake.active() ? "active" : "inactive"}\nUnitFileState=enabled\nNRestarts=0\nMainPID=${running ? process.pid : 0}\n`);
      if (verb === "start") {
        if (options.spawnService === false) { simulatedActive = true; return done(0); }
        if (running) return done(0);
        const unit = readFileSync(join(unitDir, "jit.service"), "utf8");
        const [, entry, command, flag, configPath] = /^ExecStart=(.+)$/m.exec(unit)![1]!.split(" ");
        expect([command, flag]).toEqual(["serve", "--service-config"]);
        const env = Object.fromEntries([...unit.matchAll(/^Environment=([A-Z_]+)=(.*)$/gm)].map(m => [m[1]!, m[2]!]));
        const release = resolve(entry!, "..", "..");
        const { readConfig: releaseConfig } = await import(join(release, "src", "config.ts"));
        const { readServiceConfigFile } = await import(join(release, "src", "ops", "service-package.ts"));
        const lifecycle = await import(join(release, "src", "ops", "lifecycle.ts"));
        const { createWebHandler } = await import(join(release, "src", "web.ts"));
        const started = await lifecycle.startFullApp({ config: releaseConfig(env), service: readServiceConfigFile(configPath!) });
        if (!started.ok) return done(1, JSON.stringify(started.gates));
        running = { handle: started.handle, web: createWebHandler(started.handle.app), stopDrain: lifecycle.stopDrain };
        return done(0);
      }
      if (verb === "stop" || verb === "disable") {
        if (options.spawnService === false) { simulatedActive = false; return done(0); }
        if (running) {
          const timeout = Number(/^TimeoutStopSec=(\d+)$/m.exec(readFileSync(join(unitDir, "jit.service"), "utf8"))![1]) * 1000;
          const { handle, stopDrain: drain } = running;
          running = null;
          await drain(handle, { timeoutMs: Math.min(timeout, 300_000) });
          handle.service.close();
          handle.store.close();
        }
        return done(0);
      }
      return done(1);
    } };
  stopAll.push(async () => { if (running) await fake.run(["systemctl", "stop", "jit.service"], { timeoutMs: 1000 }); });
  return fake;
}

function cli(args: string[], fake: FakeSupervisor, l: ReturnType<typeof layout>, extra: { health?: () => Promise<boolean> } = {}) {
  return runServiceCommand([...args, "--unit-dir", l.dirs.unit, "--journald-dir", l.dirs.journald, "--config-dir", l.dirs.configDir],
    { cwd: l.root, run: fake.run, readPassword: async () => password, bunPath: process.execPath, chown: recordChown, ...extra });
}

test("plan prints the exact unit, journald and config files with modes and no secret values, and writes nothing", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  const fake = fakeSupervisor(l.dirs.unit);
  const planned = await cli(["plan", "--config", l.source, "--artifact", art], fake, l);
  expect(planned.exitCode).toBe(0);
  const plan = planned.output as Awaited<ReturnType<typeof planInstall>>;
  expect(plan.checks.filter(c => !c.ok)).toEqual([]);
  const unit = plan.files.find(f => f.path.endsWith("jit.service"))!;
  expect(unit.mode).toBe("0644");
  expect(unit.content).toContain(`ExecStart=${process.execPath} ${l.service.executablePath}/src/main.ts serve --service-config ${join(l.dirs.configDir, "service-config.json")}`);
  expect(unit.content).toContain(`Environment=JIT_DATABASE=${join(l.dirs.state, "app.sqlite")}`);
  expect(unit.content).toContain(`ReadWritePaths=${l.dirs.state} ${l.dirs.backup}`);
  expect(unit.content).toMatch(/TimeoutStopSec=20\n/);
  expect(unit.content).toContain("LogNamespace=jit");
  // #89: on a host reboot the stop summary must reach the namespace journal before it stops.
  expect(unit.content).toContain("After=systemd-journald@jit.service\n");
  expect(unit.content!.indexOf("After=systemd-journald@jit.service")).toBeLessThan(unit.content!.indexOf("[Service]"));
  expect(unit.content).toContain("WantedBy=multi-user.target");
  expect(plan.files.find(f => f.path.endsWith("journald@jit.conf"))!.content).toContain("SystemMaxUse=1048576");
  expect(plan.files.find(f => f.path.endsWith("service-config.json"))).toMatchObject({ mode: "0640", content: null });
  expect(plan.changes.find(c => c.field === "secretRefs")).toEqual({ field: "secretRefs", before: null, after: { count: 1, names: ["telegram-bot-token"] } });
  const text = JSON.stringify(planned.output);
  expect(text).not.toContain("FIXTURE_TOKEN_VALUE");
  expect(text).not.toContain("123456:");
  expect(existsSync(join(l.dirs.unit, "jit.service"))).toBe(false);
  expect(existsSync(l.service.executablePath)).toBe(false);
  expect(existsSync(l.service.ledgerPath)).toBe(false);
  expect(fake.calls.some(c => c[0] === "systemctl" && c[1] !== "show")).toBe(false);
}, 30_000);

test("configuration negatives reject before any install or background activation, with safe next actions", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  const fake = fakeSupervisor(l.dirs.unit);
  const host = (): OperatorHost => ({ run: fake.run, unitDir: l.dirs.unit, journaldDir: l.dirs.journald, configDir: l.dirs.configDir, bunPath: process.execPath });
  const failing = async (service: ServiceConfig, artifactDir = art, h = host()) =>
    (await planInstall({ service, artifactDir, host: h })).checks.filter(c => !c.ok).map(c => [c.check, c.nextAction]);
  expect(await failing(l.service)).toEqual([]);
  fake.identity = null;
  expect(await failing(l.service)).toEqual([["identity", "create-dedicated-service-user"]]);
  fake.identity = `jit-service:x:${uid}:${gid}::/home/jit:/bin/bash`;
  expect(await failing(l.service)).toEqual([["identity", "use-dedicated-non-login-identity"]]);
  fake.identity = `jit-service:x:${uid}:${gid}::/var/lib/jit:/usr/sbin/nologin`;
  chmodSync(l.dirs.state, 0o755);
  expect(await failing(l.service)).toEqual([["state-directory", "restrict-service-directory"]]);
  chmodSync(l.dirs.state, 0o700);
  expect(await failing(l.service, art, { ...host(), bunPath: join(l.root, "missing-bun") })).toEqual([["runtime", "install-pinned-bun"]]);
  chmodSync(l.credential, 0o644);
  expect(await failing(l.service)).toEqual([["secret:telegram-bot-token", "restrict-credential-file"]]);
  rmSync(l.credential);
  expect(await failing(l.service)).toEqual([["secret:telegram-bot-token", "provision-credential-file"]]);
  expect(await failing({ ...l.service, secretRefs: [{ name: "keyring-ref", store: "service-keyring", key: "jit/telegram" }] }))
    .toEqual([["secret:keyring-ref", "verify-secret-store"]]);
  writeFileSync(l.credential, "123456:FIXTURE_TOKEN_VALUE_must_not_leak", { mode: 0o600 });
  // Modified release artifact: content pin fails.
  writeFileSync(join(art, "src", "main.ts"), readFileSync(join(art, "src", "main.ts"), "utf8") + "\n// tampered\n");
  expect(await failing(l.service)).toEqual([["artifact", "rebuild-or-reinstall-artifact-dependencies"]]);
  expect(validateArtifact(art).checks).toContainEqual({ check: "content-pin", ok: false });
  // Artifact without dependencies installed for this host.
  const bare = join(l.root, "bare");
  buildPackage({ srcDir: repoRoot, outDir: bare, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  expect(validateArtifact(bare, { runtime: true }).checks).toContainEqual({ check: "dependencies", ok: false });
  // Duplicate service instance: an active installed unit blocks reinstall.
  const good = await artifact(l.root, "good");
  writeFileSync(join(l.dirs.unit, "jit.service"), "[Unit]\n");
  const active = fakeSupervisor(l.dirs.unit, { spawnService: false });
  await active.run(["systemctl", "start", "jit.service"], { timeoutMs: 1000 });
  expect((await planInstall({ service: l.service, artifactDir: good, host: { ...host(), run: active.run } })).checks.filter(c => !c.ok).map(c => c.check)).toEqual(["instance"]);
  // Strict shape: wildcard, public, home, unknown fields and secret values never parse.
  for (const bad of [
    { ...l.service, network: { ...l.service.network, bindHost: "0.0.0.0" } },
    { ...l.service, network: { ...l.service.network, bindHost: "8.8.8.8", vpnInterface: "tailscale0" } },
    { ...l.service, network: { ...l.service.network, bindHost: "100.100.1.2", vpnInterface: null } },
    // A private/VPN bind must name its HTTPS origin; only loopback may synthesize an http:// origin.
    { ...l.service, network: { bindHost: "100.100.1.2", port: 3443, vpnInterface: "tailscale0" } },
    { ...l.service, network: { bindHost: "100.100.1.2", port: 3443, vpnInterface: "tailscale0", origin: "http://100.100.1.2:3443" } },
    { ...l.service, network: { ...l.service.network, origin: "http://jit.example.test" } },
    { ...l.service, stateDirectory: "/home/dev/jit-state" },
    { ...l.service, backupDirectory: "/root/backups" },
    { ...l.service, ledgerPath: "/run/user/1000/ledger.json" },
    { ...l.service, resources: { ...l.service.resources, unbounded: true } },
    { ...l.service, secretRefs: [{ name: "telegram-bot-token", store: "credential-file", key: "relative/token" }] },
    { ...l.service, channels: { telegram: "enabled" }, secretRefs: [] },
    { ...l.service, stateDirectory: join(l.dirs.opt, "releases", "state") },
    { ...l.service, workingDirectory: "/srv/jit work" },
  ]) expect(() => parseServiceConfig(bad)).toThrow("invalid_service_config");
  expect(parseServiceConfig({ ...l.service, network: { bindHost: "100.100.1.2", port: 3443, vpnInterface: "tailscale0", origin: "https://jit.tail.example" } }).network.origin)
    .toBe("https://jit.tail.example");
  // Exposed secret-like fixture values in a reference path are redacted from operator output, never printed.
  const leaky = { ...l.service, secretRefs: [{ name: "telegram-bot-token", store: "credential-file" as const, key: join(l.root, "123456:ABCDEFGHIJKL") }] };
  writeFileSync(leaky.secretRefs[0]!.key, "x", { mode: 0o600 });
  writeFileSync(l.source, JSON.stringify(leaky), { mode: 0o600 });
  const redacted = await cli(["plan", "--config", l.source, "--artifact", good], fake, l);
  expect(JSON.stringify(redacted.output)).not.toContain("123456:ABCDEFGHIJKL");
  expect(redacted.exitCode).toBe(2);
}, 60_000);

test("fresh artifact → plan → install → supervised full app → owner state persists across stop/restart with one scheduler owner", async () => {
  const port = 3443;
  const l = layout(port);
  const art = await artifact(l.root, "artifact", { runnable: true });
  const fake = fakeSupervisor(l.dirs.unit);
  const installed = await cli(["install", "--config", l.source, "--artifact", art], fake, l);
  expect(installed).toMatchObject({ exitCode: 0, output: { ok: true, supervisor: { reloaded: true, enabled: true }, nextAction: "start-service" } });
  const manifest = readManifest(art);
  expect(readlinkSync(l.service.executablePath)).toBe(join(l.dirs.opt, "releases", manifest.artifactId));
  expect(lstatSync(join(l.dirs.configDir, "service-config.json")).mode & 0o777).toBe(0o640);
  expect(lstatSync(join(l.dirs.unit, "jit.service")).mode & 0o777).toBe(0o644);
  expect(JSON.parse(readFileSync(l.service.ledgerPath, "utf8"))).toEqual({ ledger: "jit.deletion.ledger/v1", revision: 1 });
  expect(readFileSync(join(l.dirs.unit, "jit.service"), "utf8")).not.toContain("FIXTURE_TOKEN_VALUE");
  // Owner provisioning is a trusted local step with the unit's environment, never part of service start.
  const env = Object.fromEntries([...readFileSync(join(l.dirs.unit, "jit.service"), "utf8").matchAll(/^Environment=([A-Z_]+)=(.*)$/gm)].map(m => [m[1]!, m[2]!]));
  const setup = Bun.spawn([process.execPath, join(l.service.executablePath, "src", "main.ts"), "setup", "--password-stdin"],
    { cwd: l.dirs.work, env: { ...env, PATH: process.env.PATH ?? "" }, stdin: new TextEncoder().encode(password + "\n"), stdout: "pipe", stderr: "pipe" });
  expect(await setup.exited).toBe(0);
  expect((await cli(["start"], fake, l)).exitCode).toBe(0);
  const origin = `http://127.0.0.1:${port}`;
  // In-process HTTP against the running release's Web handler: no listener, no socket.
  const fetch = (url: string, init?: RequestInit) => fake.running()!.web(new Request(url, init));
  const login = async () => {
    const response = await fetch(`${origin}/login`, { method: "POST", redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });
    return /jit_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  };
  // A request without owner credentials is not an owner command.
  expect((await fetch(`${origin}/api/projects`)).status).toBe(401);
  const token = await login();
  expect(token).toBeString();
  const { createHash } = await import("node:crypto");
  const csrf = createHash("sha256").update(`jit.csrf.v1:${token}`).digest("hex");
  const workspace = await (await fetch(`${origin}/api/projects`, { headers: { cookie: `jit_session=${token}` } })).json() as { revision: number };
  const created = await fetch(`${origin}/api/projects`, { method: "POST",
    headers: { cookie: `jit_session=${token}`, origin, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ requestId: rid(), expectedRevision: workspace.revision, name: "Packaged project" }) });
  expect(created.status).toBe(200);
  const status = await cli(["status"], fake, l);
  expect(status.output).toMatchObject({ supervisor: { active: "active" }, service: { service: "running", scheduler: "owned", routes: { total: 2, configured: 1, verified: 0 }, channels: "disabled" } });
  // A duplicate writer started outside the supervisor is refused before any background activation.
  const duplicate = Bun.spawn([process.execPath, join(l.service.executablePath, "src", "main.ts"), "serve", "--service-config", join(l.dirs.configDir, "service-config.json")],
    { cwd: l.dirs.work, env: { ...env, PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  children.push(duplicate);
  expect(await duplicate.exited).toBe(1);
  expect(await new Response(duplicate.stderr).text()).toContain("Service blocked at scheduler");
  expect((await cli(["stop"], fake, l)).output).toMatchObject({ accepted: true, supervisor: { active: "inactive" }, service: { scheduler: "free" } });
  expect((await cli(["start"], fake, l)).exitCode).toBe(0);
  const again = await login();
  const projects = await (await fetch(`${origin}/api/projects`, { headers: { cookie: `jit_session=${again}` } })).json() as { projects: { name: string }[] };
  expect(projects.projects.map(p => p.name)).toEqual(["Packaged project"]);
  const store = new TransactionStore(join(l.dirs.state, "app.sqlite"), { migrateExisting: false });
  try { expect(store.read(tx => tx.all("SELECT * FROM job_scheduler")).length).toBe(1); } finally { store.close(); }
  // Uninstall removes descriptors only: state, backups, ledger, config, releases and secret references stay.
  const removed = await cli(["uninstall"], fake, l);
  expect(removed.output).toMatchObject({ disabled: true, removed: [join(l.dirs.unit, "jit.service"), join(l.dirs.journald, "journald@jit.conf")] });
  for (const kept of [join(l.dirs.state, "app.sqlite"), l.service.ledgerPath, l.credential, join(l.dirs.configDir, "service-config.json"), l.service.executablePath]) {
    expect(existsSync(kept)).toBe(true);
  }
}, 120_000);

test("serve in the packaged release refuses a modified release before any background activation", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact", { runnable: true });
  const fake = fakeSupervisor(l.dirs.unit);
  expect((await cli(["install", "--config", l.source, "--artifact", art], fake, l)).exitCode).toBe(0);
  const release = readlinkSync(l.service.executablePath);
  writeFileSync(join(release, "src", "web-style.ts"), readFileSync(join(release, "src", "web-style.ts"), "utf8") + "\n// tampered\n");
  const env = Object.fromEntries([...readFileSync(join(l.dirs.unit, "jit.service"), "utf8").matchAll(/^Environment=([A-Z_]+)=(.*)$/gm)].map(m => [m[1]!, m[2]!]));
  const serve = Bun.spawn([process.execPath, join(l.service.executablePath, "src", "main.ts"), "serve", "--service-config", join(l.dirs.configDir, "service-config.json")],
    { cwd: l.dirs.work, env: { ...env, PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  children.push(serve);
  expect(await serve.exited).toBe(1);
  const stderr = await new Response(serve.stderr).text();
  expect(stderr).toContain("Service blocked at artifact: release failed validation: content-pin (next: reinstall-validated-artifact)");
  // Only the artifact blocks: the fresh install seed is acceptable to the real OPS02 ledger gate.
  expect(stderr).not.toContain("Service blocked at quarantine");
  const store = new TransactionStore(join(l.dirs.state, "app.sqlite"), { migrateExisting: false });
  try { expect(store.read(tx => tx.all("SELECT * FROM job_scheduler"))).toEqual([]); } finally { store.close(); }
}, 60_000);

// ---------------------------------------------------------------------------
// Upgrade through the package (ops.schema_migrations/v1 between switch and health)
// ---------------------------------------------------------------------------

async function installedForUpgrade() {
  const l = layout();
  const first = await artifact(l.root, "artifact-a");
  const fake = fakeSupervisor(l.dirs.unit, { spawnService: false });
  expect((await cli(["install", "--config", l.source, "--artifact", first], fake, l)).exitCode).toBe(0);
  new TransactionStore(serviceDatabasePath(l.service)).close();
  await fake.run(["systemctl", "start", "jit.service"], { timeoutMs: 1000 });
  const second = await artifact(l.root, "artifact-b");
  const host: OperatorHost = { run: fake.run, unitDir: l.dirs.unit, journaldDir: l.dirs.journald, configDir: l.dirs.configDir, bunPath: process.execPath };
  return { l, fake, host, a: readManifest(first), b: readManifest(second), second };
}

const evidence = (state: string, extra: Record<string, unknown> = {}) =>
  ({ exitCode: 0, stdout: JSON.stringify({ id: rid(), state, snapshotBackupId: rid(), ...extra }) + "\n", timedOut: false });

test("supported upgrade stops, runs the new build's owner upgrade, switches the release and health-gates the start", async () => {
  const u = await installedForUpgrade();
  let upgradeArgv: string[] = [], upgradeStdin = "";
  u.fake.upgrade = async (argv, options) => {
    upgradeArgv = argv; upgradeStdin = options.stdin ?? "";
    // The owner upgrade runs while the supervisor has the service stopped.
    expect(u.fake.active()).toBe(false);
    return evidence("activated");
  };
  const ledgerBefore = readFileSync(u.l.service.ledgerPath);
  const result = await upgradePackage({ service: u.l.service, artifactDir: u.second, host: u.host, ownerPassword: password, health: async () => true });
  expect(result).toMatchObject({ outcome: "upgraded", previousArtifactId: u.a.artifactId, artifactId: u.b.artifactId, activeArtifactId: u.b.artifactId,
    fromSchema: schemaVersion, toSchema: schemaVersion, supervisor: "active" });
  expect(result.recoveryBackupId).toMatch(/^[a-f0-9-]{36}$/);
  expect(upgradeArgv.slice(1)).toEqual([join(u.l.dirs.opt, "releases", u.b.artifactId, "src", "main.ts"), "upgrade", "--service-config",
    join(u.l.dirs.configDir, "service-config.json"), "--password-stdin"]);
  expect(upgradeStdin).toBe(`${password}\n`);
  expect(JSON.stringify(result)).not.toContain(password);
  expect(readFileSync(u.l.service.ledgerPath)).toEqual(ledgerBefore);
  const verbs = u.fake.calls.filter(c => c[0] === "systemctl" && c[1] !== "show").map(c => c[1]);
  expect(verbs.slice(-3)).toEqual(["stop", "daemon-reload", "start"]);
}, 60_000);

test("a failed owner upgrade keeps the prior release active; nothing is switched", async () => {
  const u = await installedForUpgrade();
  u.fake.upgrade = async () => ({ exitCode: 1, stdout: JSON.stringify({ error: "engine_unavailable", upgrade: { id: rid(), state: "failed", snapshotBackupId: null } }) + "\n", timedOut: false });
  const result = await upgradePackage({ service: u.l.service, artifactDir: u.second, host: u.host, ownerPassword: password, health: async () => true });
  expect(result).toMatchObject({ outcome: "upgrade-failed", activeArtifactId: u.a.artifactId, supervisor: "active", nextAction: "inspect-upgrade-journal" });
  expect(result.detail).toContain("engine_unavailable");
  expect(u.fake.active()).toBe(true);
}, 60_000);

test("failed health rolls back only to a compatible prior release; after a schema change the recovery point is reported instead", async () => {
  const u = await installedForUpgrade();
  u.fake.upgrade = async () => evidence("activated");
  const rolled = await upgradePackage({ service: u.l.service, artifactDir: u.second, host: u.host, ownerPassword: password, health: async () => false });
  expect(rolled).toMatchObject({ outcome: "rolled-back", activeArtifactId: u.a.artifactId, supervisor: "active" });
  expect(readlinkSync(u.l.service.executablePath)).toBe(join(u.l.dirs.opt, "releases", u.a.artifactId));
  // Simulated schema advance by the new build's activation: the prior release can no longer serve this state.
  u.fake.upgrade = async () => {
    const db = new Database(serviceDatabasePath(u.l.service)); db.exec(`PRAGMA user_version = ${schemaVersion + 1}`); db.close();
    return evidence("activated");
  };
  const unhealthy = await upgradePackage({ service: u.l.service, artifactDir: u.second, host: u.host, ownerPassword: password, health: async () => false });
  expect(unhealthy).toMatchObject({ outcome: "activation-unhealthy", activeArtifactId: u.b.artifactId, toSchema: schemaVersion + 1,
    nextAction: "restore-recovery-point-through-quarantine", supervisor: "inactive" });
  expect(unhealthy.recoveryBackupId).toMatch(/^[a-f0-9-]{36}$/);
  expect(inspectStoreSchema(serviceDatabasePath(u.l.service))).toBe(schemaVersion + 1);
}, 60_000);

test("upgrade blocks before stopping on a quarantined ledger, a modified artifact or a service that will not stop", async () => {
  const u = await installedForUpgrade();
  u.fake.upgrade = async () => { throw new Error("must not run"); };
  // Establish the OPS02 checkpoint (as the first boot does), then lose it: newer ledger state cannot be proven.
  const { syncLedgerCheckpoint } = await import("../src/ops/lifecycle-ledger");
  const established = new TransactionStore(serviceDatabasePath(u.l.service));
  try { expect(syncLedgerCheckpoint(established, u.l.service.ledgerPath, Date.now()).state).toBe("trusted"); } finally { established.close(); }
  const ledger = readFileSync(u.l.service.ledgerPath);
  rmSync(u.l.service.ledgerPath);
  expect(await upgradePackage({ service: u.l.service, artifactDir: u.second, host: u.host, ownerPassword: password, health: async () => true }))
    .toMatchObject({ outcome: "blocked", nextAction: "restore_the_ledger_checkpoint_file_from_its_configured_location_then_retry", activeArtifactId: u.a.artifactId });
  writeFileSync(u.l.service.ledgerPath, ledger, { mode: 0o600 });
  const tampered = await artifact(u.l.root, "artifact-c");
  writeFileSync(join(tampered, "package.json"), readFileSync(join(tampered, "package.json"), "utf8") + " ");
  expect(await upgradePackage({ service: u.l.service, artifactDir: tampered, host: u.host, ownerPassword: password, health: async () => true }))
    .toMatchObject({ outcome: "blocked", nextAction: "rebuild-or-reinstall-artifact-dependencies" });
  expect(u.fake.calls.some(c => c[1] === "stop")).toBe(false);
  const stuck: CommandRunner = async (argv, options) => argv[1] === "show"
    ? { exitCode: 0, stdout: "ActiveState=deactivating\n", timedOut: false } : u.fake.run(argv, options);
  expect(await upgradePackage({ service: u.l.service, artifactDir: u.second, host: { ...u.host, run: stuck }, ownerPassword: password, health: async () => true }))
    .toMatchObject({ outcome: "blocked", nextAction: "terminate-supervised-process-and-reconcile", activeArtifactId: u.a.artifactId });
}, 60_000);

// ---------------------------------------------------------------------------
// Opt-in channels in the shared start path
// ---------------------------------------------------------------------------

function channelSetup(telegram: "enabled" | "disabled" = "enabled") {
  const l = layout();
  writeFileSync(l.service.ledgerPath, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
  const service: ServiceConfig = { ...l.service, executablePath: join(l.dirs.opt, "release"), channels: { telegram } };
  const config = readConfig({ JIT_DATABASE: serviceDatabasePath(service) });
  return { l, service, config };
}

function fixtureTransports(sender: ScriptedTelegramSender, polls: number[]): ChannelTransportFactory {
  return ({ botToken }) => {
    expect(botToken).toContain("FIXTURE_TOKEN_VALUE");
    return { sender, updates: { getUpdates: async (offset: number) => { polls.push(offset); return []; } } };
  };
}

test("an enabled Telegram channel fails closed without a supported transport or with an unsafe token file", async () => {
  const { l, service, config } = channelSetup();
  const blockedAt = async (transports?: ChannelTransportFactory) => {
    const started = await startFullApp({ config, service, ...(transports ? { transports } : {}) });
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    return started.gates.filter(g => g.state === "blocked").map(g => [g.gate, g.nextAction]);
  };
  expect(await blockedAt()).toEqual([["channels", "install-supported-telegram-transport"]]);
  chmodSync(l.credential, 0o644);
  expect(await blockedAt(fixtureTransports(new ScriptedTelegramSender(), []))).toEqual([["channels", "restrict-telegram-token-file"], ["secrets", "verify-secret-store"]]);
  expect(gatherServiceStatus(config, service)).toMatchObject({ service: "blocked", channels: "blocked" });
  const store = new TransactionStore(serviceDatabasePath(service), { migrateExisting: false });
  try {
    expect(store.read(tx => tx.all("SELECT * FROM job_scheduler"))).toEqual([]);
    expect(store.read(tx => tx.all("SELECT * FROM delivery_worker"))).toEqual([]);
  } finally { store.close(); }
  // A quarantined installation starts neither the scheduler nor delivery, even with a working transport.
  chmodSync(l.credential, 0o600);
  const { syncLedgerCheckpoint } = await import("../src/ops/lifecycle-ledger");
  const established = new TransactionStore(serviceDatabasePath(service));
  try { expect(syncLedgerCheckpoint(established, service.ledgerPath, Date.now()).state).toBe("trusted"); } finally { established.close(); }
  rmSync(service.ledgerPath);
  expect(await blockedAt(fixtureTransports(new ScriptedTelegramSender(), []))).toEqual([["quarantine", "restore_the_ledger_checkpoint_file_from_its_configured_location_then_retry"]]);
});

test("boot starts the delivery worker and Telegram poller after reconciliation; unknown sends stay unknown across restart", async () => {
  const { service, config } = channelSetup();
  const sender = new ScriptedTelegramSender();
  const polls: number[] = [];
  const started = await startFullApp({ config, service, transports: fixtureTransports(sender, polls) });
  if (!started.ok) throw new Error(JSON.stringify(started.gates));
  const { app, store, channels } = started.handle;
  expect(channels).not.toBeNull();
  expect(store.read(tx => tx.get<{ pid: number }>("SELECT pid FROM delivery_worker WHERE id = 1"))?.pid).toBe(process.pid);
  await app.setupOwner(password);
  const token = await app.login(password);
  const actor = app.authenticate(token).actor;
  const project = app.execute(actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { name: "Channel project" } }).project;
  const telegram = new TelegramChannel(store, started.handle.config);
  const owner = telegram.authenticate(token);
  const pending = telegram.execute(owner, { kind: "telegram.bind", requestId: rid(), expectedRevision: telegram.status(owner).binding.revision, payload: { telegramUserId: 42, telegramChatId: 77 } });
  telegram.execute(owner, { kind: "telegram.confirm", requestId: rid(), expectedRevision: pending.binding.revision,
    payload: { telegramUserId: 42, telegramChatId: 77, challengeNonce: pending.binding.challengeNonce! } });
  const commit = (dedupeKey: string) => {
    const current = app.project(actor, project.id);
    app.execute(actor, { kind: "delivery.commit", requestId: rid(), projectId: project.id, expectedRevision: current.revision,
      payload: { kind: "report", text: "รายงานบริการ", dedupeKey } });
  };
  commit("report:service:0001");
  expect(channels!.tick().sent).toBe(1);
  await channels!.settled();
  expect(sender.external.map(m => m.dedupeKey)).toEqual(["report:service:0001"]);
  expect(polls).toEqual([0]);
  // The remote accepts but the response is lost: the outcome is unknown, never sent.
  sender.scripts = ["timeout_after_accept"];
  commit("report:service:0002");
  channels!.tick();
  const drained = await stopDrain(started.handle, { timeoutMs: 5000 });
  expect(drained).toMatchObject({ outcome: "stopped", unknownDeliveries: 1 });
  expect(store.read(tx => tx.all("SELECT * FROM delivery_worker"))).toEqual([]);
  started.handle.service.close();
  store.close();
  const restartedSender = new ScriptedTelegramSender();
  const restarted = await startFullApp({ config, service, transports: fixtureTransports(restartedSender, []) });
  if (!restarted.ok) throw new Error(JSON.stringify(restarted.gates));
  restarted.handle.channels!.tick();
  await restarted.handle.channels!.settled();
  expect(restartedSender.calls).toBe(0);
  const statuses = restarted.handle.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence"))
    .map(r => (JSON.parse(r.record_json) as { status: string }).status);
  expect(statuses).toEqual(["sent", "unknown"]);
  await stopDrain(restarted.handle, { timeoutMs: 5000 });
  restarted.handle.service.close();
  restarted.handle.store.close();
});

test("the rendered unit sets the bot token reference path, never the token, when Telegram is enabled", async () => {
  const { service } = channelSetup();
  const unit = await renderServiceUnit(service, { bunPath: process.execPath, configPath: "/etc/jit/service-config.json" });
  expect(unit).toContain(`Environment=JIT_TELEGRAM_BOT_TOKEN_PATH=${service.secretRefs[0]!.key}`);
  expect(unit).not.toContain("FIXTURE_TOKEN_VALUE");
});

test("all units expose only the Podman socket directory; schway additionally requires the identity's session bus", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  const scripted = await renderServiceUnit(l.service, { bunPath: process.execPath, configPath: "/etc/jit/service-config.json", gid, uid });
  expect(scripted).toContain("ProtectHome=tmpfs\n");
  expect(scripted).not.toContain("DBUS_SESSION_BUS_ADDRESS");
  expect(scripted).toContain(`BindPaths=-/run/user/${uid}/podman\n`);
  expect(scripted).toContain(`After=user@${uid}.service`);

  const schway = { ...l.service, runPort: "schway" as const };
  writeFileSync(l.source, JSON.stringify(schway), { mode: 0o600 });
  const fake = fakeSupervisor(l.dirs.unit);
  const blockedPlan = (await cli(["plan", "--config", l.source, "--artifact", art], fake, l)).output as Awaited<ReturnType<typeof planInstall>>;
  expect(blockedPlan.ok).toBe(false);
  expect(blockedPlan.checks.filter(c => !c.ok)).toEqual([{ check: "session-bus", ok: false, nextAction: "enable-service-user-session-bus",
    detail: "service identity has no user session bus for its Secret Service" }]);
  expect(fake.calls).toContainEqual(["runuser", "-u", l.service.serviceUser, "--", "test", "-S", `/run/user/${uid}/bus`]);

  fake.sessionBus = true;
  const plan = (await cli(["plan", "--config", l.source, "--artifact", art], fake, l)).output as Awaited<ReturnType<typeof planInstall>>;
  expect(plan.checks.filter(c => !c.ok)).toEqual([]);
  expect(plan.checks.find(c => c.check === "session-bus")!.detail).toContain("unverified");
  const unit = plan.files.find(f => f.path.endsWith("jit.service"))!.content!;
  expect(unit).toContain(`Wants=network-online.target\nAfter=user@${uid}.service\nWants=user@${uid}.service\n`);
  expect(unit).toContain(`ProtectHome=tmpfs\nBindPaths=-/run/user/${uid}/podman\nBindPaths=/run/user/${uid}/bus\n`);
  expect(unit).not.toContain("ProtectHome=true");
  expect(unit).toContain(`Environment=XDG_RUNTIME_DIR=/run/user/${uid}\n`);
  expect(unit).toContain(`Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus\n`);
  expect(unit).toContain("Environment=JIT_RUN_PORT=schway");
  // The rest of the hardening stays as in scripted mode.
  for (const line of ["NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", `ReadWritePaths=${l.dirs.state} ${l.dirs.backup}`]) expect(unit).toContain(line);
  await expect(renderServiceUnit(schway, { bunPath: process.execPath, uid: 0 })).rejects.toThrow("invalid_service_config");
}, 30_000);

test("the Linux ARM64 package smoke is opt-in and refuses desktop hosts", () => {
  expect(smokeRefusal({ optIn: undefined, platform: "linux", arch: "arm64" })).toContain("JIT_OPS_SMOKE=1");
  expect(smokeRefusal({ optIn: "1", platform: "darwin", arch: "arm64" })).toContain("desktop success is not Pi evidence");
  expect(smokeRefusal({ optIn: "1", platform: "linux", arch: "x64" })).toContain("Linux arm64");
  expect(smokeRefusal({ optIn: "1", platform: "linux", arch: "arm64" })).toBeNull();
});

// ---------------------------------------------------------------------------
// Review round 1 regressions
// ---------------------------------------------------------------------------

test("build output is allowed in designated ignored subtrees of the checkout and never overlaps packaged entries", () => {
  const scratch = join(repoRoot, ".tmp", `build-${rid()}`);
  try {
    const built = buildPackage({ srcDir: repoRoot, outDir: join(scratch, "artifact"), engineContract: "jit.schway.bridge/v1", engineRevision: null });
    expect(validateArtifact(join(scratch, "artifact")).ok).toBe(true);
    expect(built.contentHash).toMatch(/^[a-f0-9]{64}$/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  for (const outDir of [repoRoot, join(repoRoot, "src", "out"), join(repoRoot, "vendor", "out"), join(repoRoot, "ops", "package", "out"),
    join(repoRoot, "out"), join(repoRoot, ".tmp"), resolve(repoRoot, "..")]) {
    expect(() => buildPackage({ srcDir: repoRoot, outDir, engineContract: "jit.schway.bridge/v1", engineRevision: null })).toThrow("invalid_build_options");
  }
});

test("the installed dependency tree is sealed: a modified, added or symlinked dependency file fails runtime validation", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  expect(existsSync(join(art, "node_modules", ".bin"))).toBe(false);
  expect(validateArtifact(art, { runtime: true }).ok).toBe(true);
  const dep = join(art, "node_modules", "fixture-dep", "index.js");
  const original = readFileSync(dep, "utf8");
  writeFileSync(dep, "export const pinned = 2;\n");
  expect(validateArtifact(art, { runtime: true }).checks).toContainEqual({ check: "dependencies", ok: false });
  writeFileSync(dep, original);
  expect(validateArtifact(art, { runtime: true }).ok).toBe(true);
  writeFileSync(join(art, "node_modules", "fixture-dep", "extra.js"), "1");
  expect(validateArtifact(art, { runtime: true }).ok).toBe(false);
  rmSync(join(art, "node_modules", "fixture-dep", "extra.js"));
  symlinkSync(dep, join(art, "node_modules", "linked.js"));
  expect(validateArtifact(art, { runtime: true }).ok).toBe(false);
  rmSync(join(art, "node_modules", "linked.js"));
  // A forged record with the right metadata but another tree digest is rejected too.
  const record = JSON.parse(readFileSync(join(art, "dependencies.json"), "utf8"));
  writeFileSync(join(art, "dependencies.json"), JSON.stringify({ ...record, dependencyHash: "0".repeat(64) }));
  expect(validateArtifact(art, { runtime: true }).ok).toBe(false);
  writeFileSync(join(art, "dependencies.json"), JSON.stringify({ ...record, extra: true }));
  expect(validateArtifact(art, { runtime: true }).ok).toBe(false);
});

test("dependency install keeps Bun's cache outside the artifact with a minimal environment and never seals an in-artifact cache", async () => {
  const l = layout();
  const install = async (name: string, env: Record<string, string | undefined>, writeCache?: "symlink" | "plain") => {
    const out = join(l.root, name);
    buildPackage({ srcDir: repoRoot, outDir: out, engineContract: "jit.schway.bridge/v1", engineRevision: null });
    const seen: Record<string, string>[] = [];
    const run: CommandRunner = async (argv, opts) => {
      if (argv[1] !== "install") return { exitCode: 0, stdout: `${Bun.version}\n`, timedOut: false };
      seen.push(opts.env!);
      const modules = join(opts.cwd!, "node_modules");
      mkdirSync(join(modules, "fixture-dep"), { recursive: true });
      writeFileSync(join(modules, "fixture-dep", "index.js"), "export const pinned = 1;\n");
      // Bun's fallback when no cache location is given: a cache inside the artifact.
      if (writeCache) {
        mkdirSync(join(modules, ".bun-cache", "fixture-dep@1"), { recursive: true });
        if (writeCache === "symlink") symlinkSync(join(modules, ".bun-cache", "fixture-dep@1"), join(modules, ".bun-cache", "fixture-dep-1"));
      }
      return { exitCode: 0, stdout: "", timedOut: false };
    };
    const result = installArtifactDependencies(out, { bunPath: process.execPath, run, env });
    return { out, seen, result };
  };

  const home = join(l.root, "service-home");
  const viaHome = await install("via-home", { PATH: "/usr/bin:/bin", HOME: home, OPENAI_API_KEY: "sk-must-not-pass" });
  await viaHome.result;
  expect(viaHome.seen).toEqual([{ PATH: "/usr/bin:/bin", HOME: home, BUN_INSTALL_CACHE_DIR: join(home, ".bun", "install", "cache") }]);
  expect(validateArtifact(viaHome.out, { runtime: true }).ok).toBe(true);

  const cacheDir = join(l.root, "operator-cache");
  const viaOperator = await install("via-operator", { PATH: "/usr/bin:/bin", HOME: home, BUN_INSTALL_CACHE_DIR: cacheDir });
  await viaOperator.result;
  expect(viaOperator.seen[0]!.BUN_INSTALL_CACHE_DIR).toBe(cacheDir);

  // No HOME: a temporary cache outside the artifact, removed afterwards.
  const noHome = await install("no-home", { PATH: "/usr/bin:/bin" });
  await noHome.result;
  const temporary = noHome.seen[0]!.BUN_INSTALL_CACHE_DIR!;
  expect(Object.keys(noHome.seen[0]!).sort()).toEqual(["BUN_INSTALL_CACHE_DIR", "PATH"]);
  expect(temporary.startsWith(noHome.out)).toBe(false);
  expect(existsSync(temporary)).toBe(false);

  // A cache configured inside the artifact is refused before bun runs.
  const inside = join(l.root, "inside");
  const refused = await install("inside", { PATH: "/usr/bin:/bin", BUN_INSTALL_CACHE_DIR: join(inside, "node_modules", ".bun-cache") });
  await expect(refused.result).rejects.toThrow("dependency_cache_in_artifact");
  expect(refused.seen).toEqual([]);

  // An install that still leaves a cache in the artifact never seals, with or without symlinks.
  for (const kind of ["symlink", "plain"] as const) {
    const leaked = await install(`leaked-${kind}`, { PATH: "/usr/bin:/bin", HOME: home }, kind);
    await expect(leaked.result).rejects.toThrow("dependency_cache_in_artifact");
    expect(existsSync(join(leaked.out, "dependencies.json"))).toBe(false);
  }
});

test("install assigns the ledger to the service identity and the config to root:<gid>, renders the real GID, and fails closed on ownership errors", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  const fake = fakeSupervisor(l.dirs.unit, { spawnService: false });
  fake.identity = `jit-service:x:${uid}:4242::/var/lib/jit:/usr/sbin/nologin`;
  fake.group = "jit-service:x:4242:";
  const failing = await runServiceCommand(["install", "--config", l.source, "--artifact", art, "--unit-dir", l.dirs.unit, "--journald-dir", l.dirs.journald,
    "--config-dir", l.dirs.configDir], { cwd: l.root, run: fake.run, bunPath: process.execPath,
    chown: () => { throw new Error("EPERM"); } });
  expect(failing).toMatchObject({ exitCode: 1, output: { ok: false, nextAction: "run-install-as-root" } });
  expect(existsSync(l.service.executablePath)).toBe(false);
  expect(fake.calls.some(c => c[1] === "enable")).toBe(false);
  fake.group = null;
  expect((await cli(["plan", "--config", l.source, "--artifact", art], fake, l)).output).toMatchObject({ ok: false });
  fake.group = "jit-service:x:4242:";
  chowns.splice(0);
  rmSync(l.service.ledgerPath, { force: true });
  const installed = await cli(["install", "--config", l.source, "--artifact", art], fake, l);
  expect(installed.exitCode).toBe(0);
  expect(chowns).toEqual([[l.dirs.configDir, 0, 4242], [join(l.dirs.configDir, "service-config.json"), 0, 4242], [l.service.ledgerPath, uid, 4242]]);
  // The service identity traverses root:<gid> 0750 to read its 0640 configuration.
  expect(lstatSync(l.dirs.configDir).mode & 0o777).toBe(0o750);
  expect(readFileSync(join(l.dirs.unit, "jit.service"), "utf8")).toMatch(/^Group=4242$/m);
  expect(lstatSync(l.service.ledgerPath).mode & 0o777).toBe(0o600);
});

test("status and preflight are read-only: a missing database is reported blocked and never created; an existing one is not modified", async () => {
  const l = layout();
  const config = readConfig({ JIT_DATABASE: serviceDatabasePath(l.service) });
  const db = serviceDatabasePath(l.service);
  const status = gatherServiceStatus(config, l.service);
  expect(status).toMatchObject({ service: "blocked", blockedGates: expect.arrayContaining(["schema"]) });
  expect(existsSync(db)).toBe(false);
  new TransactionStore(db).close();
  chmodSync(db, 0o640);
  const before = { bytes: readFileSync(db), mode: lstatSync(db).mode, mtime: lstatSync(db).mtimeMs };
  const siblings = () => ["-wal", "-shm", "-journal"].filter(suffix => existsSync(db + suffix));
  const existingSiblings = siblings();
  expect(gatherServiceStatus(config, l.service).blockedGates).not.toContain("schema");
  expect({ bytes: readFileSync(db), mode: lstatSync(db).mode, mtime: lstatSync(db).mtimeMs }).toEqual(before);
  expect(siblings()).toEqual(existingSiblings);
});

test("a root-run status judges state ownership against the configured identity, never root", async () => {
  const l = layout();
  new TransactionStore(serviceDatabasePath(l.service)).close();
  const fake = fakeSupervisor(l.dirs.unit);
  const operator = rootOperator(l, fake);
  const status = async (caller: number) => (await runServiceCommand(["status", "--config", l.source, "--unit-dir", l.dirs.unit, "--journald-dir", l.dirs.journald, "--config-dir", l.dirs.configDir],
    { ...operator.deps, uid: caller })).output as { service: { blockedGates: string[] } };
  // The test process owns the state, playing the service identity resolved through getent.
  expect((await status(0)).service.blockedGates).not.toContain("config");
  expect(fake.calls).toContainEqual(["getent", "passwd", l.service.serviceUser]);
  // A non-root caller keeps the running-uid ownership check; the identity lookup only selects its Podman socket.
  fake.calls.length = 0;
  expect((await status(uid)).service.blockedGates).not.toContain("config");
  expect(fake.calls.some(c => c[0] === "runuser")).toBe(false);
  // State owned by someone other than the identity stays blocked under root.
  fake.identity = `${l.service.serviceUser}:x:${uid + 1}:${gid}::/var/lib/jit:/usr/sbin/nologin`;
  expect((await status(0)).service.blockedGates).toContain("config");
  // An unresolvable identity is never trusted.
  fake.identity = null;
  expect((await status(0)).service.blockedGates).toContain("config");
});

test("the command runner enforces a wall-clock timeout and kills the whole process group, including descendants holding the pipe", async () => {
  const { spawnRunner } = await import("../src/ops/supervisor");
  const grandchild = `const g = Bun.spawn([process.execPath, "-e", "await Bun.sleep(20000)"], { stdout: "inherit", stderr: "ignore" }); console.log(g.pid); await Bun.sleep(20000);`;
  const started = Date.now();
  const result = await spawnRunner([process.execPath, "-e", grandchild], { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  expect(result.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(2800);
  const pid = Number(result.stdout.trim().split("\n")[0]);
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  await Bun.sleep(200);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
  const quick = await spawnRunner([process.execPath, "-e", "console.log('ok')"], { timeoutMs: 10_000 });
  expect(quick).toEqual({ exitCode: 0, stdout: "ok\n", timedOut: false });
});

test("an idle stop with historical failed jobs reports stopped, not interrupted", async () => {
  const l = layout();
  const config = readConfig({ JIT_DATABASE: serviceDatabasePath(l.service) });
  const store = new TransactionStore(config.databasePath);
  const queue = new JobQueue(store, config.jobs, [{
    id: "test.fail", title: "Failing fixture", revision: 1, replay: "read",
    route: { provider: "fixture", model: "scripted", authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 }, validate: () => true,
    run: async () => ({ state: "failed", reason: "worker_failed" }),
  }]);
  const app = new Application(store, config, { jobs: queue });
  await app.setupOwner(password);
  const actor = app.authenticate(await app.login(password)).actor;
  const project = app.execute(actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { name: "History" } }).project;
  app.execute(actor, { kind: "job.enqueue", requestId: "historical-fail-01", projectId: project.id, expectedRevision: project.revision,
    payload: { type: "test.fail", configurationRevision: 1, policyRevision: config.jobs.revision, purpose: "Failing fixture", inputRevision: project.revision,
      input: {}, priority: "background", limits: { roles: 4, calls: 4, rounds: 4, hops: 4, contextTokens: 100, outputTokens: 100, retries: 1, wallMs: 60000 } } });
  queue.pump();
  await queue.idle();
  try {
    expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('waiting', 'blocked', 'failed')")!.n)).toBeGreaterThan(0);
    // Nothing was in flight: this drain interrupted nothing, whatever the job history holds.
    expect(await stopDrain({ queue, store }, { timeoutMs: 5000 })).toMatchObject({ outcome: "stopped", fencedJobs: 0, nextAction: "none" });
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// Review round 2 regressions
// ---------------------------------------------------------------------------

test("every manifest field is bound into the content pin, and appVersion must match the packaged package.json", async () => {
  const l = layout();
  const art = join(l.root, "artifact");
  const built = buildPackage({ srcDir: repoRoot, outDir: art, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  expect(validateArtifact(art).ok).toBe(true);
  const forged: Record<string, unknown> = {
    artifactId: rid(), appVersion: "9.9.9", bunVersion: "9.9.9", lockHash: "a".repeat(64), engineContract: "jit.schway.bridge/v2",
    engineRevision: "9.9.9", arch: built.arch === "arm64" ? "x64" : "arm64", piValidation: { status: "pending", detail: "forged" },
    builtAt: "2030-01-01T00:00:00.000Z",
  };
  for (const [field, value] of Object.entries(forged)) {
    writeFileSync(join(art, "manifest.json"), JSON.stringify({ ...built, [field]: value }));
    const result = validateArtifact(art);
    expect([field, result.ok]).toEqual([field, false]);
    expect(result.checks).toContainEqual({ check: "content-pin", ok: false });
  }
  writeFileSync(join(art, "manifest.json"), JSON.stringify(built));
  expect(validateArtifact(art).ok).toBe(true);
  // A package.json edited to match a forged appVersion still breaks the content pin; the cross-check names it too.
  const pkg = JSON.parse(readFileSync(join(art, "package.json"), "utf8"));
  writeFileSync(join(art, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
  expect(validateArtifact(art).checks).toEqual(expect.arrayContaining([{ check: "content-pin", ok: false }, { check: "app-version", ok: false }]));
});

test("plan validates access as the service identity and rejects inaccessible directories and unsafe existing ledgers", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  const fake = fakeSupervisor(l.dirs.unit);
  const host = (): OperatorHost => ({ run: fake.run, unitDir: l.dirs.unit, journaldDir: l.dirs.journald, configDir: l.dirs.configDir, bunPath: process.execPath });
  const failing = async () => (await planInstall({ service: l.service, artifactDir: art, host: host() })).checks.filter(c => !c.ok).map(c => [c.check, c.nextAction]);
  expect(await failing()).toEqual([]);
  chmodSync(l.dirs.work, 0o000);
  try { expect(await failing()).toEqual([["access:working-directory", "grant-service-identity-access"]]); }
  finally { chmodSync(l.dirs.work, 0o755); }
  // Existing ledgers: wrong mode, not service-owned, symlink.
  writeFileSync(l.service.ledgerPath, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }), { mode: 0o644 });
  chmodSync(l.service.ledgerPath, 0o644);
  expect(await failing()).toEqual([["ledger", "restrict-ledger-mode-0600"]]);
  chmodSync(l.service.ledgerPath, 0o600);
  expect(await failing()).toEqual([]);
  fake.identity = `jit-service:x:${uid + 1}:${gid}::/var/lib/jit:/usr/sbin/nologin`;
  expect((await failing()).map(c => c[0])).toContain("ledger");
  fake.identity = `jit-service:x:${uid}:${gid}::/var/lib/jit:/usr/sbin/nologin`;
  const target = join(l.root, "elsewhere.json");
  writeFileSync(target, "{}", { mode: 0o600 });
  rmSync(l.service.ledgerPath);
  symlinkSync(target, l.service.ledgerPath);
  expect(await failing()).toContainEqual(["ledger", "replace-ledger-with-regular-file"]);
  rmSync(l.service.ledgerPath);
  chmodSync(l.service.ledgerPath.replace(/ledger\.json$/, ""), 0o500);
  try { expect(await failing()).toContainEqual(["access:ledger-directory", "grant-service-identity-access"]); }
  finally { chmodSync(l.service.ledgerPath.replace(/ledger\.json$/, ""), 0o700); }
});

test("a failed ledger chown removes the new seed, so a retry re-seeds and re-assigns it instead of inheriting it", async () => {
  const l = layout();
  const art = await artifact(l.root, "artifact");
  const fake = fakeSupervisor(l.dirs.unit, { spawnService: false });
  const deps = (chown: (path: string, owner: number, group: number) => void) => ({ cwd: l.root, run: fake.run, bunPath: process.execPath, chown });
  const args = ["install", "--config", l.source, "--artifact", art, "--unit-dir", l.dirs.unit, "--journald-dir", l.dirs.journald, "--config-dir", l.dirs.configDir];
  const first = await runServiceCommand(args, deps((path) => { if (path === l.service.ledgerPath) throw new Error("EPERM"); }));
  expect(first).toMatchObject({ exitCode: 1, output: { ok: false } });
  expect(existsSync(l.service.ledgerPath)).toBe(false);
  expect(existsSync(l.service.executablePath)).toBe(false);
  const retried: string[] = [];
  const second = await runServiceCommand(args, deps(path => { retried.push(path); }));
  expect(second.exitCode).toBe(0);
  expect(retried).toContain(l.service.ledgerPath);
});

test("read-only stores read committed WAL data with both sidecars and fail closed with only one", async () => {
  const { openReadOnlyStore } = await import("../src/ops/readonly-store");
  const l = layout();
  const db = join(l.dirs.state, "wal.sqlite");
  const live = new TransactionStore(db);
  try {
    live.transaction(tx => tx.run("PRAGMA user_version = 22"));
    live.transaction(tx => tx.run("CREATE TABLE IF NOT EXISTS probe (n INTEGER)"));
    live.transaction(tx => tx.run("INSERT INTO probe VALUES (1)"));
    expect(existsSync(`${db}-wal`) && existsSync(`${db}-shm`)).toBe(true);
    expect(openReadOnlyStore(db)!.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM probe")!.n)).toBe(1);
    // Copy the database plus its WAL but not its SHM: committed data lives only in the WAL.
    const copy = join(l.dirs.state, "copy.sqlite");
    writeFileSync(copy, readFileSync(db));
    writeFileSync(`${copy}-wal`, readFileSync(`${db}-wal`));
    expect(() => openReadOnlyStore(copy)!.read(tx => tx.get("SELECT count(*) AS n FROM probe"))).toThrow("store_sidecars_incomplete");
    expect(existsSync(`${copy}-shm`)).toBe(false);
  } finally { live.close(); }
  // Clean close removes both sidecars; the immutable read then sees everything that was checkpointed.
  expect(openReadOnlyStore(db)!.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM probe")!.n)).toBe(1);
  expect(openReadOnlyStore(join(l.dirs.state, "absent.sqlite"))).toBeNull();
  // Platform-independent: no SQLite URI is involved (macOS system SQLite honours `file:` URIs, Linux's
  // bundled SQLite treats them as literal names), so a name that looks like a URI still reads as a file.
  const odd = join(l.dirs.state, "odd?immutable=0#x.sqlite");
  new TransactionStore(odd).close();
  const bytes = readFileSync(odd);
  expect(openReadOnlyStore(odd)!.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(schemaVersion);
  expect(readFileSync(odd)).toEqual(bytes);
  expect(["-wal", "-shm", "-journal"].filter(suffix => existsSync(odd + suffix))).toEqual([]);
});

// ---------------------------------------------------------------------------
// Review round 3 regressions
// ---------------------------------------------------------------------------

test("the ledger and backups may not collide with the database, its sidecars or any managed path", async () => {
  const l = layout();
  const db = join(l.dirs.state, "app.sqlite");
  for (const ledgerPath of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`, `${db}.backups/ledger.json`, `${db}.upgrades/ledger.json`,
    `${db}.restores/ledger.json`, `${db}.restore-pending`, `${db}.upgrade-fence`, join(l.dirs.state, ".jit-host", "ledger.json"),
    join(l.dirs.state, "pr-cache", "ledger.json"), l.dirs.state, l.dirs.backup, join(l.dirs.backup, "ledger.json"), l.dirs.work]) {
    expect(() => parseServiceConfig({ ...l.service, ledgerPath })).toThrow("invalid_service_config");
  }
  for (const backupDirectory of [db, `${db}.backups`, `${db}-wal`, l.dirs.state, l.root, join(l.dirs.state, ".jit-host"), join(l.dirs.state, "pr-cache")]) {
    expect(() => parseServiceConfig({ ...l.service, backupDirectory })).toThrow("invalid_service_config");
  }
  // The OPS02 default checkpoint location stays allowed.
  expect(parseServiceConfig({ ...l.service, ledgerPath: `${db}.lifecycle-ledger.json` }).ledgerPath).toBe(`${db}.lifecycle-ledger.json`);
  // Fresh install and start refuse the colliding configuration before writing anything.
  const art = await artifact(l.root, "artifact");
  writeFileSync(l.source, JSON.stringify({ ...l.service, ledgerPath: db }), { mode: 0o600 });
  const fake = fakeSupervisor(l.dirs.unit);
  expect(await cli(["install", "--config", l.source, "--artifact", art], fake, l)).toMatchObject({ exitCode: 2, output: { error: "invalid_service_config" } });
  expect(existsSync(db)).toBe(false);
  await expect(startFullApp({ config: readConfig({ JIT_DATABASE: db }), service: { ...l.service, ledgerPath: `${db}-wal` } })).rejects.toThrow("invalid_service_config");
  expect(existsSync(db)).toBe(false);
});

test("release and dependency modes are canonical and sealed; a nested 0600 member never yields a release that cannot boot", async () => {
  const l = layout();
  // A source checkout with a restrictive nested member is canonicalized by the build.
  const src = join(l.root, "checkout");
  for (const entry of ["package.json", "bun.lock", "src", "ops/package", "vendor"]) cpSync(join(repoRoot, entry), join(src, entry), { recursive: true });
  chmodSync(join(src, "src", "config.ts"), 0o600);
  chmodSync(join(src, "src", "ops"), 0o700);
  const out = join(l.root, "canonical");
  buildPackage({ srcDir: src, outDir: out, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  expect(lstatSync(join(out, "src", "config.ts")).mode & 0o777).toBe(0o644);
  expect(lstatSync(join(out, "src", "ops")).mode & 0o777).toBe(0o755);
  expect(validateArtifact(out).ok).toBe(true);
  // A release member made 0600 after the build breaks the seal.
  chmodSync(join(out, "src", "config.ts"), 0o600);
  expect(validateArtifact(out).checks).toEqual(expect.arrayContaining([{ check: "content-pin", ok: false }, { check: "release-modes", ok: false }]));
  chmodSync(join(out, "src", "config.ts"), 0o644);
  expect(validateArtifact(out).ok).toBe(true);
  // Dependencies: canonicalized at install; a nested 0600 dependency file fails runtime validation.
  const art = await artifact(l.root, "artifact");
  expect(lstatSync(join(art, "node_modules", "fixture-dep", "index.js")).mode & 0o777).toBe(0o644);
  chmodSync(join(art, "node_modules", "fixture-dep", "index.js"), 0o600);
  expect(validateArtifact(art, { runtime: true }).checks).toContainEqual({ check: "dependencies", ok: false });
  chmodSync(join(art, "node_modules", "fixture-dep", "index.js"), 0o644);
  // Install and upgrade prove the whole staged release readable as the service identity before switching.
  const fake = fakeSupervisor(l.dirs.unit, { spawnService: false });
  fake.unreadable = join(l.dirs.opt, "releases", "x", "src", "config.ts");
  const refused = await cli(["install", "--config", l.source, "--artifact", art], fake, l);
  expect(refused).toMatchObject({ exitCode: 1, output: { ok: false, nextAction: "grant-service-identity-access" } });
  expect(existsSync(l.service.executablePath)).toBe(false);
  expect(existsSync(l.service.ledgerPath)).toBe(false);
  delete fake.unreadable;
  expect((await cli(["install", "--config", l.source, "--artifact", art], fake, l)).exitCode).toBe(0);
});

test("the bot token reader rejects FIFOs, symlinks and oversized files without blocking or reading them", async () => {
  const { inspectBotTokenFile, readBotToken, botCredentialConfigured } = await import("../src/telegram/secrets");
  const { channelReadiness } = await import("../src/ops/service-channels");
  const l = layout();
  const transports = fixtureTransports(new ScriptedTelegramSender(), []);
  const blockedAction = (path: string) => {
    const readiness = channelReadiness({ enabled: true, botTokenPath: path, transports });
    return readiness.state === "blocked" ? readiness.nextAction : readiness.state;
  };
  expect(readBotToken(l.credential)).toContain("FIXTURE_TOKEN_VALUE");
  expect(blockedAction(l.credential)).toBe("ready");
  const link = join(l.root, "token-link");
  symlinkSync(l.credential, link);
  expect(inspectBotTokenFile(link)).toEqual({ state: "blocked", code: "telegram_token_not_regular" });
  expect(() => readBotToken(link)).toThrow("telegram_token_not_regular");
  expect(blockedAction(link)).toBe("replace-telegram-token-with-regular-file");
  const huge = join(l.root, "huge.token");
  writeFileSync(huge, "x".repeat(1024 * 1024), { mode: 0o600 });
  expect(inspectBotTokenFile(huge)).toEqual({ state: "blocked", code: "telegram_token_invalid" });
  expect(() => readBotToken(huge)).toThrow("telegram_token_invalid");
  expect(botCredentialConfigured(huge)).toBe(false);
  const fifo = join(l.root, "token.fifo");
  const made = Bun.spawnSync(["mkfifo", "-m", "600", fifo]);
  if (made.exitCode !== 0) { console.warn("skip FIFO case: mkfifo unavailable"); return; }
  const started = Date.now();
  expect(inspectBotTokenFile(fifo)).toEqual({ state: "blocked", code: "telegram_token_not_regular" });
  expect(() => readBotToken(fifo)).toThrow("telegram_token_not_regular");
  expect(blockedAction(fifo)).toBe("replace-telegram-token-with-regular-file");
  expect(botCredentialConfigured(fifo)).toBe(false);
  // Status (metadata only) on an enabled channel with a FIFO reference returns promptly and blocked.
  const service: ServiceConfig = { ...l.service, secretRefs: [{ name: "telegram-bot-token", store: "credential-file", key: fifo }], channels: { telegram: "enabled" } };
  expect(gatherServiceStatus(readConfig({ JIT_DATABASE: serviceDatabasePath(service) }), service)).toMatchObject({ channels: "blocked", telegram: "unconfigured" });
  expect(Date.now() - started).toBeLessThan(2000);
});

test("installer install never seeds/chmods/chowns a mutable ledger path as root", async () => {
  const l = layout(), staged = await artifact(l.root, "installer-artifact"), fake = fakeSupervisor(l.dirs.unit, { spawnService: false });
  const ownership: string[] = [];
  const host: OperatorHost = { run: fake.run, unitDir: l.dirs.unit, journaldDir: l.dirs.journald, configDir: l.dirs.configDir,
    bunPath: process.execPath, skipLedgerSeed: true, chown: path => { ownership.push(path); } };
  const missing = await installService({ service: l.service, artifactDir: staged, host });
  expect(missing.ok).toBe(false);
  expect(missing.plan.checks.at(-1)?.nextAction).toBe("prepare-service-ledger-as-service-user");
  expect(existsSync(l.service.ledgerPath)).toBe(false);
  expect(ownership).not.toContain(l.service.ledgerPath);
  writeFileSync(l.service.ledgerPath, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }), { mode: 0o600 });
  const installed = await installService({ service: l.service, artifactDir: staged, host });
  expect(installed.ok).toBe(true);
  expect(ownership).not.toContain(l.service.ledgerPath);
});


// OPS08: root is simulated by the current uid inside a disposable filesystem boundary.
function rootOperator(l: ReturnType<typeof layout>, fake = fakeSupervisor(l.dirs.unit, { spawnService: false })) {
  const runtimeDir = join(l.root, "operator-cli"); mkdirSync(runtimeDir, { recursive: true });
  const bunPath = join(runtimeDir, "bun"); writeFileSync(bunPath, "fixture runtime", { mode: 0o755 });
  const foreign = new Set<string>();
  const policy: RootPathPolicy = { root: l.root, uid, lstat: path => {
    const stats = lstatSync(path); if (foreign.has(path)) stats.uid = uid + 1; return stats;
  } };
  let passwords = 0;
  const deps = { cwd: l.root, run: fake.run, bunPath, uid: 0, runtimeDir, rootPathPolicy: policy, chown: recordChown,
    readPassword: async () => { passwords++; return password; }, health: async () => true };
  const invoke = (args: string[]) => runServiceCommand([...args, "--unit-dir", l.dirs.unit, "--journald-dir", l.dirs.journald,
    "--config-dir", l.dirs.configDir], deps);
  return { deps, invoke, foreign, fake, passwords: () => passwords, policy };
}

const rootCommands = ["plan", "install", "start", "stop", "restart", "status", "upgrade", "disable", "uninstall"];
for (const command of rootCommands) {
  for (const kind of ["group-write", "other-write", "foreign-artifact", "symlink", "symlink-ancestor", "foreign-ancestor", "writable-ancestor", "writable-node_modules", "writable-dependency", "foreign-dependency", "dangling-dependency"]) {
    test(`OPS08 root ${command} refuses ${kind} before commands or password input`, async () => {
      const l = layout(), operator = rootOperator(l), parent = join(l.root, "build"), artifact = join(parent, "artifact");
      mkdirSync(join(artifact, "node_modules/fixture"), { recursive: true });
      const dependency = join(artifact, "node_modules/fixture/index.js"); writeFileSync(dependency, "fixture");
      let bad = artifact;
      if (kind === "group-write") chmodSync(artifact, 0o775);
      if (kind === "other-write") chmodSync(artifact, 0o757);
      if (kind === "foreign-artifact") operator.foreign.add(artifact);
      if (kind === "symlink") { rmSync(artifact, { recursive: true }); symlinkSync(operator.deps.runtimeDir, artifact); }
      if (kind === "symlink-ancestor") {
        const real = join(l.root, "real"); mkdirSync(join(real, "artifact"), { recursive: true });
        rmSync(parent, { recursive: true }); symlinkSync(real, parent); bad = parent;
      }
      if (kind === "foreign-ancestor") { operator.foreign.add(parent); bad = parent; }
      if (kind === "writable-ancestor") { chmodSync(parent, 0o775); bad = parent; }
      if (kind === "writable-node_modules") { bad = join(artifact, "node_modules"); chmodSync(bad, 0o775); }
      if (kind === "writable-dependency") { bad = dependency; chmodSync(bad, 0o666); }
      if (kind === "foreign-dependency") { bad = dependency; operator.foreign.add(bad); }
      if (kind === "dangling-dependency") { bad = dependency; rmSync(bad); symlinkSync(join(l.root, "missing"), bad); }
      const result = await operator.invoke([command, "--config", l.source, "--artifact", artifact, "--password-stdin"]);
      expect(result).toMatchObject({ exitCode: 2, output: { error: "unsafe_root_path", path: bad } });
      expect((result.output as { nextAction: string }).nextAction).toContain(rootSnapshotCopyCommand);
      expect(operator.fake.calls).toEqual([]); expect(operator.passwords()).toBe(0);
    });
  }
}

for (const kind of ["config", "config-ancestor", "installed-config", "bun", "runtime", "unit", "unit-dropin", "journald", "release-parent", "active-link", "active-target", "active-link-ancestor"]) {
  test(`OPS08 root status refuses unsafe ${kind} even without --artifact`, async () => {
    const l = layout(), operator = rootOperator(l);
    let bad = l.source;
    if (kind === "config-ancestor") bad = l.dirs.local;
    if (kind === "installed-config") bad = join(l.dirs.configDir, "service-config.json");
    if (kind === "bun") bad = operator.deps.bunPath;
    if (kind === "runtime") { bad = join(operator.deps.runtimeDir, "import.ts"); writeFileSync(bad, "fixture"); }
    if (kind === "unit") bad = join(l.dirs.unit, "jit.service");
    if (kind === "unit-dropin") { mkdirSync(join(l.dirs.unit, "jit.service.d")); bad = join(l.dirs.unit, "jit.service.d/override.conf"); }
    if (kind === "journald") bad = join(l.dirs.journald, "journald@jit.conf");
    if (kind === "release-parent") { bad = join(l.dirs.opt, "releases"); mkdirSync(bad); }
    if (kind.startsWith("active-")) {
      const release = join(l.dirs.opt, "release"); mkdirSync(release); symlinkSync(release, l.service.executablePath);
      bad = kind === "active-link" ? l.service.executablePath : kind === "active-target" ? release : l.dirs.opt;
    }
    if (!existsSync(bad)) writeFileSync(bad, "fixture");
    operator.foreign.add(bad);
    const result = await operator.invoke(["status", "--config", l.source]);
    expect(result).toMatchObject({ exitCode: 2, output: { error: "unsafe_root_path", path: bad } });
    expect(operator.fake.calls).toEqual([]);
  });
}

test("OPS08 root runtime rejects invocation links and ancestor dependency fallbacks before loading app imports", () => {
  const l = layout(), operator = rootOperator(l), entry = join(l.root, "entry.ts");
  symlinkSync(join(operator.deps.runtimeDir, "main.ts"), entry);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).toThrow("unsafe_root_path");
  mkdirSync(join(l.root, "node_modules")); chmodSync(join(l.root, "node_modules"), 0o777);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy)).toThrow("unsafe_root_path");
});

test("OPS08 non-root keeps existing status behavior for a service-writable runtime and artifact", async () => {
  const l = layout(), operator = rootOperator(l), artifact = join(l.root, "mutable"); mkdirSync(artifact); chmodSync(artifact, 0o777);
  operator.deps.uid = uid || 1000; operator.foreign.add(operator.deps.runtimeDir);
  const result = await operator.invoke(["status", "--config", l.source, "--artifact", artifact]);
  expect(result.exitCode).toBe(0); expect(result.output).not.toHaveProperty("error");
  expect(operator.fake.calls.some(argv => argv[0] === "runuser")).toBe(false);
});

test("OPS08 protected snapshot installs and upgrades from fresh inodes despite retained build descriptors", async () => {
  const l = layout(), operator = rootOperator(l), first = await artifact(l.root, "first");
  expect((await operator.invoke(["plan", "--config", l.source, "--artifact", first])).exitCode).toBe(0);
  expect((await operator.invoke(["install", "--config", l.source, "--artifact", first])).exitCode).toBe(0);
  new TransactionStore(serviceDatabasePath(l.service)).close();
  const second = await artifact(l.root, "second"), original = join(second, "src/main.ts"), fd = openSync(original, "r+");
  try {
    const frozen = freezeInstallerArtifact(second, join(l.dirs.opt, "releases"), readManifest(second), operator.policy);
    const protectedEntry = join(frozen.artifact, "src/main.ts"), bytes = readFileSync(protectedEntry);
    expect(lstatSync(original).ino).not.toBe(lstatSync(protectedEntry).ino);
    operator.deps.readPassword = async () => { writeSync(fd, "attacker", 0, "utf8"); return password; };
    const calls: string[][] = [];
    operator.fake.upgrade = async (argv, options) => {
      calls.push(argv); expect(operator.fake.active()).toBe(false); expect(options.stdin).toBe(`${password}\n`);
      expect(readFileSync(protectedEntry)).toEqual(bytes);
      expect(options.env?.PATH).toBe("/usr/sbin:/usr/bin:/sbin:/bin");
      return evidence("activated");
    };
    const result = await operator.invoke(["upgrade", "--artifact", frozen.artifact, "--password-stdin"]);
    expect(result).toMatchObject({ exitCode: 0, output: { outcome: "upgraded", recoveryBackupId: expect.any(String), supervisor: "active" } });
    expect(calls).toHaveLength(1); expect(calls[0]!.slice(0, 4)).toEqual(["runuser", "-u", l.service.serviceUser, "--"]);
    expect(calls[0]).toContain(join(l.dirs.opt, "releases", readManifest(second).artifactId, "src/main.ts"));
    expect(() => assertRootTree(readlinkSync(l.service.executablePath), operator.policy)).not.toThrow();
  } finally { closeSync(fd); }
}, 60_000);

test("OPS08 upgrade refuses an unsafe pre-existing destination before stopping the unit", async () => {
  const u = await installedForUpgrade(), operator = rootOperator(u.l, u.fake);
  const target = join(u.l.dirs.opt, "releases", u.b.artifactId); cpSync(u.second, target, { recursive: true });
  const bad = join(target, "node_modules"); chmodSync(bad, 0o775);
  u.fake.calls.length = 0;
  const result = await operator.invoke(["upgrade", "--artifact", u.second, "--password-stdin"]);
  expect(result).toMatchObject({ exitCode: 2, output: { error: "unsafe_root_path", path: bad } });
  expect(u.fake.calls.some(argv => argv[0] === "systemctl" && argv[1] === "stop")).toBe(false);
  expect(u.fake.active()).toBe(true);
  expect(operator.passwords()).toBe(0);
}, 60_000);

test("OPS08 original Linux command line preserves entry symlinks despite Bun canonicalizing argv", () => {
  const l = layout(), operator = rootOperator(l), direct = join(operator.deps.runtimeDir, "main.ts"), alias = join(l.root, "alias.ts");
  writeFileSync(direct, "fixture"); symlinkSync(direct, alias);
  const argv = [operator.deps.bunPath, direct, "service", "status"];
  const raw = [operator.deps.bunPath, "--no-env-file", alias, "service", "status", ""].join("\0");
  const entry = serviceInvocationPath(argv, raw, l.root);
  expect(entry).toBe(alias);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).toThrow("unsafe_root_path");
  const supported = [operator.deps.bunPath, "run", "operator-cli/main.ts", "service", "status", ""].join("\0");
  expect(serviceInvocationPath(argv, supported, l.root)).toBe(direct);
  expect(() => serviceInvocationPath(argv, "bun\0-e\0unrecognized wrapper\0", l.root)).toThrow("unsafe_root_path");
});

test("OPS08 CLI recovery command is copied verbatim from the operator runbook", () => {
  expect(readFileSync(join(repoRoot, "docs/runbooks/ops-service.md"), "utf8")).toContain(rootSnapshotCopyCommand);
});

test("OPS08 non-root plan retains its source-config behavior", async () => {
  const l = layout(), operator = rootOperator(l), art = await artifact(l.root, "artifact");
  operator.deps.uid = uid || 1000; chmodSync(l.source, 0o666);
  expect((await operator.invoke(["plan", "--config", l.source, "--artifact", art])).exitCode).toBe(0);
});


for (const kind of ["foreign-owner", "symlink", "dangling-symlink", "corrupt-artifact"] as const) {
  test(`OPS08-F refuses ${kind} at the new destination without reading the password`, async () => {
    const u = await installedForUpgrade(), operator = rootOperator(u.l, u.fake);
    const target = join(u.l.dirs.opt, "releases", u.b.artifactId);
    if (kind === "symlink" || kind === "dangling-symlink") symlinkSync(kind === "symlink" ? u.second : join(u.l.root, "missing"), target);
    else {
      cpSync(u.second, target, { recursive: true });
      if (kind === "foreign-owner") operator.foreign.add(target);
      else writeFileSync(join(target, "src/main.ts"), "invalid artifact content");
    }
    const result = await operator.invoke(["upgrade", "--artifact", u.second, "--password-stdin"]);
    expect(result).toMatchObject({ exitCode: 2, output: { error: kind === "corrupt-artifact" ? "release_copy_invalid" : "unsafe_root_path" } });
    expect(operator.passwords()).toBe(0); expect(u.fake.calls.some(argv => argv[0] === "systemctl" && argv[1] === "stop")).toBe(false);
    if (kind !== "corrupt-artifact") expect((result.output as { nextAction: string }).nextAction).toContain(rootSnapshotCopyCommand);
  }, 60_000);
}

test("OPS08-F normal upgrade reads the password exactly once and later checks still refuse a changed destination", async () => {
  const good = await installedForUpgrade(), operator = rootOperator(good.l, good.fake);
  good.fake.upgrade = async () => evidence("activated");
  const result = await operator.invoke(["upgrade", "--artifact", good.second, "--password-stdin"]);
  expect(result).toMatchObject({ exitCode: 0, output: { outcome: "upgraded" } }); expect(operator.passwords()).toBe(1);
  const race = await installedForUpgrade(), racingOperator = rootOperator(race.l, race.fake);
  const target = join(race.l.dirs.opt, "releases", race.b.artifactId); let passwords = 0;
  racingOperator.deps.readPassword = async () => { passwords++; cpSync(race.second, target, { recursive: true }); chmodSync(join(target, "node_modules"), 0o775); return password; };
  const refused = await racingOperator.invoke(["upgrade", "--artifact", race.second, "--password-stdin"]);
  expect(refused).toMatchObject({ exitCode: 2, output: { error: "unsafe_root_path" } }); expect(passwords).toBe(1);
  expect(race.fake.calls.some(argv => argv[0] === "systemctl" && argv[1] === "stop")).toBe(false);
}, 60_000);

test("OPS09 install and existing-install upgrade enable the user socket and render every sandbox directive", async () => {
  const u = await installedForUpgrade(), original = u.fake.run;
  const run: CommandRunner = async (argv, opts) => {
    if (argv.includes("podman") || argv[0] === "loginctl" || argv.includes("podman.socket") || argv[2]?.startsWith("user@")) {
      u.fake.calls.push(argv); return { exitCode: 0, stdout: "", timedOut: false };
    }
    return original(argv, opts);
  };
  u.host.run = run;
  u.host.chown = recordChown;
  await original(["systemctl", "stop", "jit.service"], { timeoutMs: 1000 });
  const installed = await installService({ service: u.l.service, artifactDir: u.second, host: u.host });
  expect(installed.plan.checks.filter(check => !check.ok)).toEqual([]);
  expect(installed.ok).toBe(true); expect(installed.podman?.state).toBe("ready");
  expect(u.fake.calls).toContainEqual(["loginctl", "enable-linger", u.l.service.serviceUser]);
  expect(u.fake.calls.some(args => args.includes("podman.socket") && args[0] === "runuser" && args.includes("--user"))).toBe(true);
  // Simulate the old installed descriptor and release before a real upgrade.
  const unitPath = join(u.l.dirs.unit, "jit.service");
  writeFileSync(unitPath, readFileSync(unitPath, "utf8").replace(/^Environment=JIT_PODMAN_MODE=.*\n/m, "").replace(/^BindPaths=-.*podman\n/m, ""));
  const first = join(u.l.dirs.opt, "releases", u.a.artifactId);
  rmSync(u.l.service.executablePath); symlinkSync(first, u.l.service.executablePath);
  u.fake.upgrade = async () => evidence("activated");
  const upgraded = await upgradePackage({ service: u.l.service, artifactDir: u.second, host: u.host, ownerPassword: password, health: async () => true });
  expect(upgraded).toMatchObject({ outcome: "upgraded", podman: { state: "ready" } });
  const unit = readFileSync(unitPath, "utf8");
  for (const line of ["NoNewPrivileges=true", "ProtectSystem=strict", "RestrictSUIDSGID=true", "PrivateTmp=true", "ProtectKernelTunables=true", "ProtectControlGroups=true", "UMask=0077", "KillMode=mixed", "LimitNOFILE=4096", "TasksMax=256", "Environment=JIT_PODMAN_MODE=remote", `BindPaths=-/run/user/${uid}/podman`]) expect(unit).toContain(line);
  expect(unit).toContain(`-/run/user/${uid}/podman\nUMask`);
  expect(unit).toContain("InaccessiblePaths=-/var/lib/jit/.local/share/containers");
  // The remote client still loads containers.conf before connecting; the normal strict filesystem makes it read-only.
  expect(unit.match(/^InaccessiblePaths=.*/m)?.[0]).not.toContain(".config/containers");
  expect(unit.match(/^ReadWritePaths=.*/m)?.[0]).not.toContain(".local/share/containers"); expect(unit).not.toContain(`ReadWritePaths=/var/lib/jit `);
  expect(u.fake.calls.filter(args => args.includes("podman.socket"))).toHaveLength(2);
}, 30_000);

test("OPS09 only the protected managed activation entry is admitted by the root bootstrap", () => {
  const l = layout(), operator = rootOperator(l), activation = join(l.root, "opt/jit/current");
  mkdirSync(join(operator.deps.runtimeDir, "src")); writeFileSync(join(operator.deps.runtimeDir, "src/main.ts"), "// fixture");
  mkdirSync(join(l.root, "opt/jit"), { recursive: true }); symlinkSync(operator.deps.runtimeDir, activation);
  const entry = join(activation, "src/main.ts");
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).not.toThrow();
  operator.foreign.add(activation);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).toThrow("unsafe_root_path");
  operator.foreign.delete(activation); chmodSync(join(l.root, "opt/jit"), 0o777);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).toThrow("unsafe_root_path");
  chmodSync(join(l.root, "opt/jit"), 0o755); chmodSync(join(operator.deps.runtimeDir, "src/main.ts"), 0o666);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).toThrow("unsafe_root_path");
  chmodSync(join(operator.deps.runtimeDir, "src/main.ts"), 0o644);
  symlinkSync(operator.deps.runtimeDir, join(l.root, "alias"));
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, join(l.root, "alias/src/main.ts"))).toThrow("unsafe_root_path");
  const other = join(l.root, "other"); mkdirSync(join(other, "src"), { recursive: true }); writeFileSync(join(other, "src/main.ts"), "// other");
  rmSync(activation); symlinkSync(other, activation);
  expect(() => assertServiceRuntime(operator.deps.runtimeDir, operator.deps.bunPath, operator.policy, entry)).toThrow("unsafe_root_path");
});

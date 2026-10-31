import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installerHealth, installerOwnerLink, installerS14Schema, prepareInstallerHome, runInstaller, type InstallerOptions } from "../ops/package/installer/installer";
import { captureOwnerPipe, deliverS14OwnerLink } from "../ops/package/installer/owner-link";
import { provisionS14Images } from "../ops/package/installer/s14-images";
import { buildPackage, installArtifactDependencies, readManifest } from "../ops/package/bun-build";
import { parseServiceConfig, serviceDatabasePath, serviceEnvironment, type ServiceConfig } from "../ops/package/service-config";
import { defaultHealth, installService, upgradePackage, type OperatorHost } from "../src/ops/service-package";
import { SystemdSupervisor } from "../src/ops/supervisor";
import { runServiceCommand } from "../src/ops/service-cli";
import { S14Store, s14SchemaVersion } from "../src/s14/store";
import { requireOwnerSetup } from "../src/ops/owner-setup";
import { collectS14ServiceEvidence } from "../ops/package/s14-service-evidence";
import { S14Application } from "../src/s14/application";
import { s14Policy } from "../src/s14/policy";
import { createS14Handler } from "../src/s14/web";
import { createS14Product } from "../src/s14/web-product";

const roots: string[] = [], source = resolve(import.meta.dir, ".."), GiB = 1024 ** 3;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-installer-")); roots.push(root);
  const facts = { family: "ubuntu", arch: "x64", ramMb: 8192, cpus: 4, diskBytes: 100 * GiB, freeBytes: 80 * GiB };
  mkdirSync(join(root, "proc/self"), { recursive: true });
  for (const name of ["uid_map", "gid_map"]) writeFileSync(join(root, "proc/self", name), "0 0 4294967295\n");
  writeFileSync(join(root, "host.json"), JSON.stringify(facts));
  const lines: string[] = [];
  const options: InstallerOptions = { root, source, bunPath: process.execPath, facts, dryRun: true, s14: true, out: line => lines.push(line),
    run: async () => { throw new Error("host commands forbidden"); } };
  return { root, lines, options, at: (path: string) => join(root, path) };
}

test("explicit S14 coexists with byte-identical legacy state/config/unit/keyring and repairs idempotently", async () => {
  const f = fixture();
  await runInstaller({ ...f.options, s14: false });
  writeFileSync(f.at("var/lib/jit/state/app.sqlite"), "legacy database sentinel");
  writeFileSync(f.at("var/lib/jit/backups/keep"), "legacy backup sentinel");
  const legacy = ["var/lib/jit/state/app.sqlite", "var/lib/jit/backups/keep", "etc/jit/service-config.json", "etc/systemd/system/jit.service", "etc/systemd/journald@jit.conf", "var/lib/jit/keyring-unlock"];
  const before = legacy.map(path => readFileSync(f.at(path)));
  const result = await runInstaller(f.options), config = result.config;
  expect(config.runtime).toBe("s14"); expect(config.serviceUser).toBe("jit-s14"); expect(config.network.port).toBe(3001);
  expect(() => installerOwnerLink(config)).toThrow("s14_private_owner_link_required");
  expect(serviceDatabasePath(config)).toBe(join(realpathSync(f.root), "var/lib/jit-s14/state/application.sqlite"));
  const unit = readFileSync(f.at("etc/systemd/system/jit-s14.service"), "utf8");
  for (const text of ["User=jit-s14", "/opt/jit-s14/bin/bun", "serve --s14 --no-refusal-page", "ProtectSystem=strict", "ProtectHome=tmpfs", "NoNewPrivileges=true", "RestrictSUIDSGID=true", "PrivateTmp=true", "ProtectControlGroups=true", "ProtectKernelTunables=true", "LogNamespace=jit-s14", "/.schway", "BindPaths=/run/user/1001/bus", "BindPaths=-/run/user/1001/podman", "JIT_PODMAN_MODE=remote", "size=128M,mode=0700,uid=1001,gid=1001", "Environment=JIT_S14_GIT_SCRATCH="]) expect(unit).toContain(text);
  expect(unit).not.toContain("JIT_DATABASE="); expect(unit).not.toContain("--service-config");
  expect(Object.fromEntries(serviceEnvironment(config)).JIT_S14_DATABASE).toBe(serviceDatabasePath(config));
  const configBytes = readFileSync(f.at("etc/jit-s14/service-config.json")), unlock = readFileSync(f.at("var/lib/jit-s14/keyring-unlock"));
  const ranges = readFileSync(f.at("etc/subuid"));
  writeFileSync(join(config.stateDirectory, "keep"), "S14 state");
  await runInstaller(f.options);
  expect(readFileSync(f.at("etc/jit-s14/service-config.json"))).toEqual(configBytes);
  expect(readFileSync(f.at("var/lib/jit-s14/keyring-unlock"))).toEqual(unlock);
  expect(readFileSync(f.at("etc/subuid"))).toEqual(ranges);
  expect(readFileSync(join(config.stateDirectory, "keep"), "utf8")).toBe("S14 state");
  await runInstaller({ ...f.options, uninstall: true });
  expect(existsSync(f.at("etc/systemd/system/jit-s14.service"))).toBe(false);
  expect(existsSync(f.at("etc/jit-s14/service-config.json"))).toBe(true);
  legacy.forEach((path, index) => expect(readFileSync(f.at(path))).toEqual(before[index]!));
  expect(f.lines.join("\n")).not.toContain("?token=");
});

test("S14 missing Podman/images remains chat-only and a re-run repairs without weakening the unit", async () => {
  const f = fixture(), result = await runInstaller({ ...f.options, simulation: { podman: false } });
  expect(result.events.at(-1)).toBe("owner-link");
  expect(result.config.s14!.images).toBeUndefined();
  const unit = readFileSync(f.at("etc/systemd/system/jit-s14.service"), "utf8");
  expect(unit).not.toContain("JIT_S14_COMPUTER_ROOT="); expect(unit).toContain("ProtectSystem=strict");
  expect(f.lines.join("\n")).toContain("computer_image_digest_required");
  expect(f.lines.join("\n")).toContain("computer_local_podman_required");
  expect((await runInstaller(f.options)).config.s14!.images).toBeDefined();
  expect(existsSync(f.at("var/lib/jit"))).toBe(false);
});

test("S14 schema and home helpers never create a legacy database or ledger seed", () => {
  const f = fixture(), home = f.at("home"); mkdirSync(home);
  prepareInstallerHome(home, true);
  expect(existsSync(join(home, "ledger/checkpoint.json"))).toBe(false);
  for (const path of ["vault", "computers", ".schway"]) expect(statSync(join(home, path)).mode & 0o777).toBe(0o700);
  expect(installerS14Schema(home)).toBeNull();
  const db = join(home, "state/application.sqlite"), store = new S14Store(db); store.close();
  expect(installerS14Schema(home, true)).toBe(s14SchemaVersion);
  expect(existsSync(join(home, "state/app.sqlite"))).toBe(false);
});

test("installer and upgrade health use the actual S14 sign-in route; legacy's route and redirects cannot pass", async () => {
  const f = fixture(), { config } = await runInstaller(f.options), store = new S14Store(f.at("health.sqlite"));
  const app = new S14Application(store, { policy: s14Policy(), chat: { async reply() { throw new Error("no model"); } } });
  const origin = "http://127.0.0.1:3001", handler = createS14Handler(app, origin, undefined, createS14Product(app));
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${origin}/s14/login`); expect(init?.redirect).toBe("manual");
    return handler(new Request(url, init));
  }) as typeof fetch;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(request);
  try {
    expect((await handler(new Request(`${origin}/login`))).status).toBe(303);
    expect(await installerHealth(config, request)).toBe(true);
    const supervisor = new SystemdSupervisor(async () => ({ exitCode: 0, timedOut: false, stdout: "ActiveState=active\n" }), { unit: "jit-s14.service" });
    expect(await defaultHealth(config, supervisor)()).toBe(true);
    expect(await installerHealth(config, (async () => new Response(null, { status: 303, headers: { location: "/login" } })) as unknown as typeof fetch)).toBe(false);
  } finally { fetchSpy.mockRestore(); store.close(); }
});

test("POSIX --s14 dry-run passes selection through and defaults to legacy without host commands", async () => {
  const f = fixture();
  for (const flags of [["--s14"], []]) {
    const child = Bun.spawn(["sh", join(source, "install.sh"), "--yes", "--dry-run", "--root", f.root, ...flags], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 }); expect(stdout).not.toContain("?token=");
    expect(existsSync(f.at(`etc/systemd/system/${flags.length ? "jit-s14" : "jit"}.service`))).toBe(true);
  }
});

test("installer runs the actual owner-link CLI via private fd 3 and terminal-only output while logs stay empty", async () => {
  const f = fixture(), db = f.at("application.sqlite"), origin = "http://127.0.0.1:3001", terminal: string[] = [];
  const log = spyOn(console, "log"), error = spyOn(console, "error");
  const argv = [process.execPath, join(source, "src/main.ts"), "owner-link", "--s14", "--output-fd", "3"];
  const env = { JIT_S14_DATABASE: db, JIT_S14_ORIGIN: origin };
  try {
    await deliverS14OwnerLink(argv, env, origin, { capture: captureOwnerPipe, terminal: () => ({ write: text => { terminal.push(text); }, close() {} }) });
    expect(terminal).toHaveLength(1);
    const token = terminal[0]!.match(/token=([a-f0-9]{64})/)![1]!;
    const store = new S14Store(db);
    try {
      store.transaction(tx => requireOwnerSetup(store, tx, token, Date.now()));
      expect(readFileSync(`${db}.owner-setup.json`, "utf8")).not.toContain(token);
      store.transaction(tx => tx.run("INSERT INTO owner VALUES ('owner','fixture',1)"));
    } finally { store.close(); }
    await deliverS14OwnerLink(argv, env, origin, { capture: captureOwnerPipe, terminal: () => ({ write: text => { terminal.push(text); }, close() {} }) });
    expect(terminal[1]).toBe(`Open ${origin}/s14/login to finish setup\n`);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  } finally { log.mockRestore(); error.mockRestore(); }
});

test("private delivery discards stdout/stderr, bounds output/time, and refuses non-terminal or malformed links", async () => {
  const discarded = await captureOwnerPipe([process.execPath, "-e", 'console.log("log sentinel"); console.error("error sentinel"); require("node:fs").writeSync(3,"private sentinel");'], {});
  expect(discarded).toBe("private sentinel");
  await expect(captureOwnerPipe([process.execPath, "-e", 'require("node:fs").writeSync(3,"a".repeat(2000));'], {})).rejects.toThrow("owner_link_pipe_failed");
  await expect(captureOwnerPipe([process.execPath, "-e", "setInterval(()=>{},1000)"], {}, 100)).rejects.toThrow("owner_link_pipe_failed");
  let captures = 0, writes = 0;
  await expect(deliverS14OwnerLink([], {}, "http://127.0.0.1:3001", { capture: async () => { captures++; return ""; }, terminal: () => { throw new Error("operator_terminal_required"); } })).rejects.toThrow("operator_terminal_required");
  expect(captures).toBe(0);
  for (const value of ["https://evil.test/owner/setup?token=" + "a".repeat(64) + "\n", "garbage\n", "http://127.0.0.1:3001/owner/setup?token=" + "a".repeat(64) + "\nlog"]) {
    await expect(deliverS14OwnerLink([], {}, "http://127.0.0.1:3001", { capture: async () => value, terminal: () => ({ write() { writes++; }, close() {} }) })).rejects.toThrow("owner_link_pipe_invalid");
  }
  expect(writes).toBe(0);
});

test("actual controlling-terminal delivery bypasses redirected installer stdout/stderr", async () => {
  const f = fixture(), log = f.at("installer.log"), db = f.at("application.sqlite");
  let terminal = "";
  const child = Bun.spawn(["/bin/sh", "-c", 'exec "$JIT_TEST_BUN" "$JIT_TEST_FIXTURE" >"$JIT_TEST_LOG" 2>&1'], {
    env: { JIT_TEST_BUN: process.execPath, JIT_TEST_FIXTURE: join(source, "tests/fixtures/s14-installer-terminal.ts"), JIT_TEST_LOG: log,
      JIT_S14_DATABASE: db, JIT_S14_ORIGIN: "http://127.0.0.1:3001" },
    terminal: { cols: 80, rows: 24, data: (_terminal, data) => { terminal += data.toString(); } },
  });
  try {
    expect(await child.exited).toBe(0);
    expect(terminal.match(/\/owner\/setup\?token=[a-f0-9]{64}/g)).toHaveLength(1);
    expect(readFileSync(log, "utf8")).toBe("installer-safe-progress\n");
  } finally { child.terminal?.close(); }
});

test("Bot images build as the identity from the packaged context, use verified digests and fail closed on absent pins", async () => {
  const calls: string[][] = [], asUser = (argv: string[]) => ["runuser", "-u", "jit-s14", "--", ...argv];
  const run: OperatorHost["run"] = async (argv, options) => {
    calls.push(argv); expect(argv.slice(0, 4)).toEqual(["runuser", "-u", "jit-s14", "--"]); expect(options.timeoutMs).toBeGreaterThan(0);
    return { exitCode: 0, timedOut: false, stdout: argv.includes("inspect") ? `sha256:${"c".repeat(64)}\n` : "" };
  };
  expect(await provisionS14Images("/trusted/release", 1234, run, asUser)).toEqual({ base: `localhost/jit-s14-base@sha256:${"c".repeat(64)}`, browser: `localhost/jit-s14-browser@sha256:${"c".repeat(64)}` });
  expect(calls.filter(argv => argv.includes("build"))).toHaveLength(2);
  expect(calls[0]).toContain("/trusted/release/ops/box/Containerfile");
  calls.length = 0;
  const pins = { base: `localhost/jit-s14-base@sha256:${"c".repeat(64)}`, browser: `localhost/jit-s14-browser@sha256:${"c".repeat(64)}` };
  expect(await provisionS14Images("/trusted/release", 1234, run, asUser, pins)).toEqual(pins);
  expect(calls.some(argv => argv.includes("build"))).toBe(false);
  expect(await provisionS14Images("/trusted/release", 1234, async () => ({ exitCode: 0, timedOut: false, stdout: "" }), asUser)).toBeUndefined();
});

async function artifact(root: string, name: string, runnable = false) {
  const path = join(root, name); buildPackage({ srcDir: source, outDir: path, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  await installArtifactDependencies(path, { bunPath: process.execPath, run: async (argv, options) => {
    if (argv.includes("install")) {
      if (runnable) cpSync(join(source, "node_modules"), join(path, "node_modules"), { recursive: true, filter: file => !["typescript", "@typescript", "bun-types", "@types", ".bin"].includes(file.slice(join(source, "node_modules").length + 1).split("/")[0]!) });
      else { mkdirSync(join(options.cwd!, "node_modules")); writeFileSync(join(options.cwd!, "node_modules/fixture.js"), "export {};\n"); }
    }
    return { exitCode: 0, stdout: Bun.version, timedOut: false };
  } });
  return path;
}

test("rendered service argv/environment boots the packaged S14 entrypoint and restarts the same state without a listener", async () => {
  const f = fixture(), { config } = await runInstaller(f.options), release = await artifact(f.root, "runnable", true);
  symlinkSync(release, config.executablePath);
  const unit = readFileSync(f.at("etc/systemd/system/jit-s14.service"), "utf8");
  const argv = unit.match(/^ExecStart=(.+)$/m)![1]!.split(" ").slice(1);
  const env = Object.fromEntries([...unit.matchAll(/^Environment=([^=\n]+)=(.*)$/gm)].map(match => [match[1]!, match[2]!]));
  expect(env.JIT_S14_DATABASE).toBe(serviceDatabasePath(config));
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = Bun.spawn([process.execPath, "--preload", join(source, "tests/fixtures/s14-service-preload.ts"), ...argv], { cwd: config.workingDirectory, env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
    expect(JSON.parse(stdout).state).toBe("s14_listening");
    expect(stdout).not.toContain("?token=");
    expect(existsSync(serviceDatabasePath(config))).toBe(true);
    expect(existsSync(`${serviceDatabasePath(config)}.lifecycle.sqlite`)).toBe(true);
    expect(existsSync(`${serviceDatabasePath(config)}.owner-setup.json`)).toBe(false);
    expect(existsSync(join(config.stateDirectory, "app.sqlite"))).toBe(false);
  }
}, 30_000);

test("S14 service package install/upgrade/compatible rollback select only its unit and never legacy upgrade or password", async () => {
  const f = fixture(), { config } = await runInstaller(f.options), calls: string[][] = [];
  const art = await artifact(f.root, "first"), next = await artifact(f.root, "next");
  let active = false, schema = s14SchemaVersion;
  const host: OperatorHost = { unitDir: f.at("etc/systemd/system"), journaldDir: f.at("etc/systemd"), configDir: f.at("etc/jit-s14"), bunPath: process.execPath,
    skipLedgerSeed: true, chown() {}, run: async argv => {
      calls.push(argv);
      let stdout = "";
      if (argv[0] === "getent") stdout = argv[1] === "passwd" ? `jit-s14:x:${process.getuid!()}:${process.getgid!()}:Jit:${f.at("var/lib/jit-s14")}:/usr/sbin/nologin\n` : `jit-s14:x:${process.getgid!()}:\n`;
      else if (argv[1] === "--version") stdout = Bun.version;
      else if (argv[0] === "systemctl") {
        if (argv[1] === "stop") active = false;
        if (argv[1] === "start") active = true;
        stdout = `ActiveState=${active ? "active" : "inactive"}\nUnitFileState=enabled\nMainPID=0\nNRestarts=0\n`;
      } else if (argv.includes("check-s14")) stdout = String(schema);
      return { exitCode: 0, stdout, timedOut: false };
    } };
  const installed = await installService({ service: config, artifactDir: art, host });
  expect(installed.plan.checks.filter(check => !check.ok)).toEqual([]); expect(installed.ok).toBe(true);
  expect(existsSync(config.ledgerPath)).toBe(false);
  expect(existsSync(serviceDatabasePath(config))).toBe(false);
  const first = readlinkSync(config.executablePath);
  const result = await upgradePackage({ service: config, artifactDir: next, host, ownerPassword: "", health: async () => false });
  expect(result.outcome).toBe("rolled-back"); expect(readlinkSync(config.executablePath)).toBe(first);
  expect(await upgradePackage({ service: config, artifactDir: next, host, ownerPassword: "", health: async () => true })).toMatchObject({ outcome: "upgraded" });
  expect(readManifest(readlinkSync(config.executablePath)).artifactId).toBe(readManifest(next).artifactId);
  schema--;
  expect(await upgradePackage({ service: config, artifactDir: art, host, ownerPassword: "", health: async () => true })).toMatchObject({ outcome: "blocked" });
  expect(calls.some(argv => argv.includes("upgrade") && argv.includes("--password-stdin"))).toBe(false);
  expect(calls.filter(argv => argv[0] === "systemctl" && argv[1] !== "daemon-reload").every(argv => argv.includes("jit-s14.service") || argv.some(arg => arg.startsWith("user@")))).toBe(true);
  let passwordReads = 0;
  const cli = await runServiceCommand(["upgrade", "--config", join(host.configDir, "service-config.json"), "--artifact", art, "--unit-dir", host.unitDir, "--journald-dir", host.journaldDir], { cwd: f.root, run: host.run, bunPath: process.execPath, uid: 1000, readPassword: async () => { passwordReads++; return "must not be read"; } });
  expect(passwordReads).toBe(0); expect(cli.exitCode).toBe(1);
});

test("S14 configuration refuses path overlaps, non-Schway routes and mismatched listeners", async () => {
  const f = fixture(), { config } = await runInstaller(f.options);
  for (const change of [{ s14: { ...config.s14, vaultDirectory: config.stateDirectory } }, { s14: { ...config.s14, gitScratch: config.s14!.computerRoot } }, { runPort: "scripted" }, { runtime: undefined }, { network: { ...config.network, origin: "http://127.0.0.1:3000" } }, { network: { ...config.network, port: 4000, origin: "https://jit.example.test" } }]) {
    expect(() => parseServiceConfig({ ...config, ...change })).toThrow("invalid_service_config");
  }
});

test("service evidence summary drops arbitrary diagnostics and retains unrun evidence as pending", async () => {
  const f = fixture(), { config } = await runInstaller(f.options), calls: string[][] = [];
  const sentinel = "PRIVATE_DIAGNOSTIC_SENTINEL";
  const summary = await collectS14ServiceEvidence(config, async argv => {
    calls.push(argv); return { exitCode: 1, timedOut: false, stdout: `${sentinel}\nActiveState=failed\n` };
  });
  expect(JSON.stringify(summary)).not.toContain(sentinel);
  expect(JSON.stringify(summary)).not.toContain(config.stateDirectory);
  expect(summary.readiness).toBe("service_observations_only");
  expect(summary.pending).toContain("cancel-restart-reboot");
  expect(summary.checks.serviceActive).toBe(false);
  expect(calls.some(argv => argv.includes("start") || argv.includes("run") || argv.includes("exec"))).toBe(false);
});

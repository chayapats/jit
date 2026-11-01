import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installerHealth, installerOwnerLink, installerS14Schema, prepareInstallerHome, runInstaller, type InstallerOptions } from "../ops/package/installer/installer";
import { captureOwnerPipe, deliverS14OwnerLink, prepareS14OwnerLink } from "../ops/package/installer/owner-link";
import { prepareS14Image, provisionS14Images } from "../ops/package/installer/s14-images";
import { botComputerUserNamespace } from "../src/s14/computer-types";
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
  const options: InstallerOptions = { root, source, bunPath: process.execPath, facts, dryRun: true, out: line => lines.push(line),
    run: async () => { throw new Error("host commands forbidden"); } };
  return { root, lines, options, at: (path: string) => join(root, path) };
}

function installationBytes(f: ReturnType<typeof fixture>, name: "jit" | "jit-s14") {
  const tree = (path: string): unknown => {
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    return { mode: stat.mode, uid: stat.uid, gid: stat.gid, link: stat.isSymbolicLink() ? readlinkSync(path) : null,
      bytes: stat.isFile() ? readFileSync(path).toString("hex") : null,
      children: stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map(name => [name, tree(join(path, name))])) : null };
  };
  return [`var/lib/${name}`, `opt/${name}`, `etc/${name}`, `etc/systemd/system/${name}.service`, `etc/systemd/journald@${name}.conf`].map(path => tree(f.at(path)));
}

test.each(["x64", "arm64"])("default install/repair/uninstall and explicit legacy actions preserve the other complete installation: %s", async arch => {
  const f = fixture(), options = { ...f.options, facts: { ...f.options.facts, arch } };
  await runInstaller({ ...options, s14: false });
  const sentinels = ["state/app.sqlite", "state/app.sqlite-wal", "state/app.sqlite-shm", "state/native/session", "boxes/work/file", "boxes/profile/cookies", "backups/image", ".local/share/keyrings/login.keyring", ".schway/native", "ledger/checkpoint.json"];
  for (const name of ["jit", "jit-s14"]) {
    if (name === "jit-s14") await runInstaller(options);
    for (const path of sentinels) {
      const full = f.at(`var/lib/${name}/${path}`); mkdirSync(resolve(full, ".."), { recursive: true }); writeFileSync(full, `${name} retained ${path}`);
    }
  }
  const legacy = installationBytes(f, "jit"), s14Config = readFileSync(f.at("etc/jit-s14/service-config.json"));
  await runInstaller(options);
  expect(readFileSync(f.at("etc/jit-s14/service-config.json"))).toEqual(s14Config);
  expect(installationBytes(f, "jit")).toEqual(legacy);
  // After S14 repair, replace only fake mount images with compact byte sentinels for the other-runtime actions.
  // Real logical-size/commitment/repair preservation is covered by s14-disk-pool.test.ts.
  const compactFakeImages = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) compactFakeImages(join(path, name));
    else if (stat.isFile() && stat.size >= 1024 ** 3) writeFileSync(path, `retained fake disk ${path}`);
  };
  compactFakeImages(f.at("var/lib/jit-s14/computers"));
  const s14 = installationBytes(f, "jit-s14");
  await runInstaller({ ...options, s14: false });
  expect(installationBytes(f, "jit-s14")).toEqual(s14);
  await runInstaller({ ...options, s14: false, uninstall: true });
  expect(installationBytes(f, "jit-s14")).toEqual(s14);
  expect(existsSync(f.at("etc/systemd/system/jit.service"))).toBe(false);
  const retainedLegacy = installationBytes(f, "jit");
  await runInstaller({ ...options, uninstall: true });
  expect(installationBytes(f, "jit")).toEqual(retainedLegacy);
  expect(existsSync(f.at("etc/systemd/system/jit-s14.service"))).toBe(false);
  for (const name of ["jit", "jit-s14"]) for (const path of sentinels) expect(readFileSync(f.at(`var/lib/${name}/${path}`), "utf8")).toBe(`${name} retained ${path}`);
  expect(readFileSync(f.at("etc/jit-s14/service-config.json"))).toEqual(s14Config);
});

test("internal apply omission defaults to S14; explicit false and low-level omitted helper flags remain legacy", async () => {
  for (const flags of [[], ["--s14", "false"], ["--s14", "true"]]) {
    const f = fixture(), child = Bun.spawn([process.execPath, join(source, "ops/package/installer/main.ts"), "apply", "--root", f.root, "--dry-run", "true", "--source", source, ...flags], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).not.toContain("?token=");
    expect(existsSync(f.at(`etc/systemd/system/${flags.includes("false") ? "jit" : "jit-s14"}.service`))).toBe(true);
  }
  const f = fixture(), home = f.at("helper-home"); mkdirSync(home); prepareInstallerHome(home);
  expect(existsSync(join(home, "ledger/checkpoint.json"))).toBe(true);
  expect(existsSync(join(home, "vault"))).toBe(false);
});

test("shell selectors refuse conflicts/duplicates before detection, consent or any writes", async () => {
  for (const flags of [["--s14", "--legacy"], ["--legacy", "--s14"], ["--legacy", "--legacy"], ["--s14", "--s14"]]) {
    const f = fixture(), before = readdirSync(f.root).sort();
    const child = Bun.spawn(["sh", join(source, "install.sh"), "--dry-run", "--root", f.root, ...flags], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("Failed at arguments"); expect(stderr).not.toContain("Apply this plan");
    expect(readdirSync(f.root).sort()).toEqual(before);
  }
});

test("invalid internal selections and a legacy config at the S14 path refuse before mutable installation changes", async () => {
  for (const flags of [["--s14", "invalid"], ["--s14", "false", "--s14", "true"], ["--legacy", "true"]]) {
    const f = fixture(), before = readdirSync(f.root).sort();
    const child = Bun.spawn([process.execPath, join(source, "ops/package/installer/main.ts"), "apply", "--root", f.root, "--dry-run", "true", "--source", source, ...flags], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toContain("Failed at installer-input");
    expect(readdirSync(f.root).sort()).toEqual(before);
  }
  const f = fixture(); await runInstaller({ ...f.options, s14: false });
  mkdirSync(f.at("etc/jit-s14"));
  const legacyConfig = readFileSync(f.at("etc/jit/service-config.json"));
  writeFileSync(f.at("etc/jit-s14/service-config.json"), legacyConfig);
  const legacy = installationBytes(f, "jit"), s14 = installationBytes(f, "jit-s14");
  await expect(runInstaller(f.options)).rejects.toThrow("Failed at configuration");
  expect(installationBytes(f, "jit")).toEqual(legacy); expect(installationBytes(f, "jit-s14")).toEqual(s14);
});

test("actual sudo re-exec block carries explicit legacy/default S14 through local and downloaded bootstrap paths", async () => {
  const script = readFileSync(join(source, "install.sh"), "utf8");
  const block = script.slice(script.indexOf("step=privileges\n"), script.indexOf("PATH=/usr/sbin:/usr/bin:/sbin:/bin\n"));
  for (const s14 of [true, false]) for (const downloaded of [true, false]) {
    const f = fixture(), harness = f.at("reexec.sh"), recorded = f.at("argv.json"), recorder = f.at("record.ts");
    writeFileSync(recorder, 'await Bun.write(process.env.RECORDED!, JSON.stringify({argv:process.argv.slice(2),script:await Bun.stdin.text()}));\n');
    writeFileSync(harness, `set -eu\ns14=${s14}\ncomputer_slots=8\nsource_dir=${downloaded ? "" : source}\nuninstall=true\nrelease_url=https://release.example.test\nscratch=\nreported=false\nfailed() { exit 90; }\ntrusted_input() { :; }\nid() { printf '1001\\n'; }\ncurl() { for fetched in "$@"; do :; done; cp "$BOOTSTRAP" "$fetched"; }\nsudo() { "$TEST_BUN" "$RECORDER" "$@"; }\n${block}`);
    // curl's output argument is positional in the real bootstrap; record without any network or sudo.
    const env = { PATH: process.env.PATH, HOME: f.root, BOOTSTRAP: join(source, "install.sh"), TEST_BUN: process.execPath, RECORDER: recorder, RECORDED: recorded };
    const child = Bun.spawn(downloaded ? ["sh", "-s"] : ["sh", harness], { cwd: f.root, env, stdin: downloaded ? new TextEncoder().encode(readFileSync(harness, "utf8")) : "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: "", stdout: "" });
    const result = JSON.parse(readFileSync(recorded, "utf8"));
    expect(result.argv).toEqual(["sh", "-s", "--", "--yes", ...(s14 ? ["--s14", "--computer-slots", "8"] : ["--legacy"]), ...(!downloaded ? ["--source", source] : []), "--uninstall"]);
    expect(result.script).toBe(downloaded ? script : readFileSync(harness, "utf8"));
  }
});

test("default S14 coexists with byte-identical legacy state/config/unit/keyring and repairs idempotently", async () => {
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
  const owned = new S14Store(serviceDatabasePath(config));
  const ownerApp = new S14Application(owned, { policy: s14Policy(), chat: { async reply() { throw new Error("model forbidden"); } } });
  await ownerApp.provisionOwner("fixture-retained-owner-267");
  const owner = owned.read(tx => tx.get("SELECT * FROM owner")); owned.close();
  const databaseBytes = readFileSync(serviceDatabasePath(config)), ledgerBytes = readFileSync(`${serviceDatabasePath(config)}.lifecycle.sqlite`);
  const configBytes = readFileSync(f.at("etc/jit-s14/service-config.json")), unlock = readFileSync(f.at("var/lib/jit-s14/keyring-unlock"));
  const ranges = readFileSync(f.at("etc/subuid"));
  writeFileSync(join(config.stateDirectory, "keep"), "S14 state");
  await runInstaller(f.options);
  expect(readFileSync(f.at("etc/jit-s14/service-config.json"))).toEqual(configBytes);
  expect(readFileSync(f.at("var/lib/jit-s14/keyring-unlock"))).toEqual(unlock);
  expect(readFileSync(f.at("etc/subuid"))).toEqual(ranges);
  expect(readFileSync(join(config.stateDirectory, "keep"), "utf8")).toBe("S14 state");
  expect(readFileSync(serviceDatabasePath(config))).toEqual(databaseBytes);
  expect(readFileSync(`${serviceDatabasePath(config)}.lifecycle.sqlite`)).toEqual(ledgerBytes);
  // Inspect a private copy: even a normal writable SQLite open can advance the original header.
  const ownerCopy = f.at("owner-verification.sqlite");
  cpSync(serviceDatabasePath(config), ownerCopy);
  cpSync(`${serviceDatabasePath(config)}.lifecycle.sqlite`, `${ownerCopy}.lifecycle.sqlite`);
  const repaired = new S14Store(ownerCopy);
  try { expect(repaired.read(tx => tx.get("SELECT * FROM owner"))).toEqual(owner); }
  finally { repaired.close(); }
  await runInstaller({ ...f.options, uninstall: true });
  expect(existsSync(f.at("etc/systemd/system/jit-s14.service"))).toBe(false);
  expect(existsSync(f.at("etc/jit-s14/service-config.json"))).toBe(true);
  expect(readFileSync(serviceDatabasePath(config))).toEqual(databaseBytes);
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
  expect(f.lines.join("\n")).toContain("s14-disk-pool");
  expect((await runInstaller(f.options)).config.s14!.images).toBeDefined();
  const failed = await runInstaller({ ...f.options, simulation: { failStep: "optional-s14-images" } });
  expect(failed.config.s14!.images).toBeUndefined();
  expect(JSON.parse(readFileSync(f.at("etc/jit-s14/service-config.json"), "utf8")).s14.images).toBeUndefined();
  expect(readFileSync(f.at("etc/systemd/system/jit-s14.service"), "utf8")).not.toContain("JIT_BOX_IMAGE_BASE=");
  expect(existsSync(f.at("var/lib/jit"))).toBe(false);
});

test("S14 schema and home helpers never create a legacy database or ledger seed", () => {
  const f = fixture(), home = f.at("home"); mkdirSync(home);
  prepareInstallerHome(home, true);
  expect(existsSync(join(home, "ledger/checkpoint.json"))).toBe(false);
  for (const path of ["vault", ".schway"]) expect(statSync(join(home, path)).mode & 0o777).toBe(0o700);
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

test("POSIX bare/default and --s14 select S14; --legacy alone selects legacy on both architectures", async () => {
  for (const arch of ["x64", "arm64"]) for (const flags of [[], ["--s14"], ["--legacy"]]) {
    const f = fixture();
    writeFileSync(f.at("host.json"), JSON.stringify({ ...f.options.facts, arch }));
    const child = Bun.spawn(["sh", join(source, "install.sh"), "--yes", "--dry-run", "--root", f.root, ...flags], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 }); expect(stdout).not.toContain("?token=");
    const name = flags.includes("--legacy") ? "jit" : "jit-s14", other = name === "jit" ? "jit-s14" : "jit";
    expect(existsSync(f.at(`etc/systemd/system/${name}.service`))).toBe(true);
    expect(existsSync(f.at(`var/lib/${other}`))).toBe(false);
  }
}, 30_000);

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

test("S14 bootstrap captures before service start and displays only after successful health", async () => {
  const f = fixture(), result = await runInstaller(f.options);
  expect(result.events.indexOf("owner-terminal")).toBeLessThan(result.events.indexOf("service-install"));
  expect(result.events.indexOf("state-initialize")).toBeLessThan(result.events.indexOf("owner-link-prepare"));
  expect(result.events.indexOf("owner-link-prepare")).toBeLessThan(result.events.indexOf("service-start"));
  expect(result.events.indexOf("health")).toBeLessThan(result.events.indexOf("owner-link"));
});

test.each([false, true])("an S14 installer rerun stops before image preparation and restores chat after preparation failure=%s", async failImages => {
  const f = fixture();
  await runInstaller({ ...f.options, s14: false });
  await runInstaller(f.options);
  const legacyPaths = ["etc/jit/service-config.json", "etc/systemd/system/jit.service", "etc/systemd/journald@jit.conf", "var/lib/jit/keyring-unlock"];
  const legacy = legacyPaths.map(path => readFileSync(f.at(path)));
  const result = await runInstaller({ ...f.options, simulation: failImages ? { failStep: "optional-s14-images" } : {} });
  const order = result.events;
  expect(order).toContain("service-stop");
  expect(order.indexOf("owner-terminal")).toBeLessThan(order.indexOf("service-stop"));
  expect(order.indexOf("service-stop")).toBeLessThan(order.indexOf("optional-s14-images"));
  expect(order.indexOf("optional-s14-images")).toBeLessThan(order.indexOf("service-install"));
  expect(order.indexOf("service-install")).toBeLessThan(order.indexOf("service-start"));
  expect(order.indexOf("service-start")).toBeLessThan(order.indexOf("health"));
  expect(order.at(-1)).toBe("owner-link");
  if (failImages) {
    expect(result.config.s14!.images).toBeUndefined();
    const unit = readFileSync(f.at("etc/systemd/system/jit-s14.service"), "utf8");
    expect(unit).toContain("serve --s14"); expect(unit).not.toContain("JIT_S14_COMPUTER_ROOT=");
  }
  legacyPaths.forEach((path, i) => expect(readFileSync(f.at(path))).toEqual(legacy[i]!));
});

test("an unavailable operator terminal refuses a rerun before stopping or preparing images", async () => {
  const f = fixture(); await runInstaller(f.options); f.lines.length = 0;
  await expect(runInstaller({ ...f.options, simulation: { failStep: "owner-terminal" } })).rejects.toThrow("Failed at owner-terminal");
  expect(f.lines).not.toContain("Step: service-stop");
  expect(f.lines).not.toContain("Step: optional-s14-images");
});

test.each([true, false])("a pre-activation rerun failure restores prior config and resumes only a previously active service=%s", async serviceActive => {
  const f = fixture(); await runInstaller(f.options);
  const configPath = f.at("etc/jit-s14/service-config.json"), unitPath = f.at("etc/systemd/system/jit-s14.service");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.s14.images = { base: `localhost/previous-base@sha256:${"c".repeat(64)}`, browser: `localhost/previous-browser@sha256:${"d".repeat(64)}` };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const previousConfig = readFileSync(configPath), previousUnit = readFileSync(unitPath);
  f.lines.length = 0;
  await expect(runInstaller({ ...f.options, simulation: { failStep: "service-install", serviceActive } })).rejects.toThrow("Failed at service-install");
  expect(readFileSync(configPath)).toEqual(previousConfig);
  expect(readFileSync(unitPath)).toEqual(previousUnit);
  expect(readFileSync(f.at("etc/jit-s14/installer-previous-config.json"))).toEqual(previousConfig);
  expect(f.lines).toContain("Step: service-rollback");
  expect(f.lines.includes("Step: service-resume")).toBe(serviceActive);
  expect(f.lines).not.toContain("Step: owner-link-prepare");
});

test("a later installer failure after unavailable images preserves the prior installation with an explicit cleanup recovery path", async () => {
  const f = fixture(); await runInstaller(f.options);
  const configPath = f.at("etc/jit-s14/service-config.json"), unitPath = f.at("etc/systemd/system/jit-s14.service");
  const previousConfig = readFileSync(configPath), previousUnit = readFileSync(unitPath);
  f.lines.length = 0;
  await expect(runInstaller({ ...f.options, simulation: { failStep: "optional-s14-images" }, out: line => {
    f.lines.push(line);
    if (line === "Step: service-install") throw new Error("simulated pre-activation write failure");
  } })).rejects.toThrow("confirm Podman image cleanup");
  expect(readFileSync(configPath)).toEqual(previousConfig);
  expect(readFileSync(unitPath)).toEqual(previousUnit);
  expect(readFileSync(f.at("etc/jit-s14/installer-previous-config.json"))).toEqual(previousConfig);
  expect(f.lines).toContain("Step: service-rollback");
  expect(f.lines).not.toContain("Step: service-resume");
  expect(f.lines).not.toContain("Step: owner-link-prepare");
});

test.each(["healthy", "failed"] as const)("prepared private delivery remains silent until %s health and is never reissued", async health => {
  const f = fixture(), db = f.at("prepared.sqlite"), origin = "http://127.0.0.1:3001", terminal: string[] = [];
  let captures = 0, closes = 0;
  const pending = await prepareS14OwnerLink([process.execPath, join(source, "src/main.ts"), "owner-link", "--s14", "--output-fd", "3"],
    { JIT_S14_DATABASE: db, JIT_S14_ORIGIN: origin }, origin, { capture: async (argv, env) => { captures++; return captureOwnerPipe(argv, env); }, terminal: () => ({ write: text => { terminal.push(text); }, close() { closes++; } }) });
  expect(terminal).toEqual([]); expect(captures).toBe(1);
  expect(JSON.stringify(pending)).toBe("{}");
  if (health === "healthy") {
    pending.deliver(); expect(terminal).toHaveLength(1);
    expect(() => pending.deliver()).toThrow("owner_link_delivery_closed");
  }
  pending.close(); pending.close();
  expect(closes).toBe(1); expect(captures).toBe(1);
  expect(() => pending.deliver()).toThrow("owner_link_delivery_closed");
  if (health === "failed") expect(terminal).toEqual([]);
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
  const release = fixture().at("release");
  mkdirSync(join(release, "ops"), { recursive: true });
  cpSync(join(source, "ops/box"), join(release, "ops/box"), { recursive: true });
  const calls: string[][] = [], asUser = (argv: string[]) => ["runuser", "-u", "jit-s14", "--", ...argv];
  const run: OperatorHost["run"] = async (argv, options) => {
    calls.push(argv); expect(argv.slice(0, 4)).toEqual(["runuser", "-u", "jit-s14", "--"]); expect(options.timeoutMs).toBeGreaterThan(0);
    return { exitCode: 0, timedOut: false, stdout: argv.includes("inspect") ? `sha256:${"c".repeat(64)}\n` : "" };
  };
  const pins = await provisionS14Images(release, 1234, run, asUser);
  expect(pins).toMatchObject({ base: `localhost/jit-s14-base@sha256:${"c".repeat(64)}`, browser: `localhost/jit-s14-browser@sha256:${"c".repeat(64)}` });
  expect(calls.filter(argv => argv.includes("build"))).toHaveLength(2);
  expect(calls.filter(argv => argv.includes("create"))).toHaveLength(2);
  expect(calls[0]).toContain(join(release, "ops/box/Containerfile"));
  expect(pins!.buildInputsHash).toMatch(/^[a-f0-9]{64}$/);
  calls.length = 0;
  expect(await provisionS14Images(release, 1234, run, asUser, pins)).toEqual(pins);
  expect(calls.some(argv => argv.includes("build"))).toBe(false);
  expect(calls.filter(argv => argv.includes("create"))).toHaveLength(2);
  // Existing installations without input provenance must rebuild, too.
  calls.length = 0;
  await provisionS14Images(release, 1234, run, asUser, { base: pins!.base, browser: pins!.browser });
  expect(calls.filter(argv => argv.includes("build"))).toHaveLength(2);
  for (const input of ["Containerfile", "runner", "sanitize", "cdp-relay"]) {
    const path = join(release, "ops/box", input);
    const original = readFileSync(path);
    writeFileSync(path, original.toString("utf8") + "\n# changed\n");
    calls.length = 0;
    expect(await provisionS14Images(release, 1234, async argv => {
      calls.push(argv); return { exitCode: 1, timedOut: false, stdout: "" };
    }, asUser, pins)).toBeUndefined();
    expect(calls[0]).toContain("build");
    calls.length = 0;
    const rebuilt = await provisionS14Images(release, 1234, run, asUser, pins);
    expect(rebuilt!.buildInputsHash).not.toBe(pins!.buildInputsHash);
    expect(calls.filter(argv => argv.includes("build"))).toHaveLength(2);
    writeFileSync(path, original);
  }
  expect(await provisionS14Images(release, 1234, async () => ({ exitCode: 0, timedOut: false, stdout: "" }), asUser)).toBeUndefined();
});

test.each(["success", "create-failed", "create-timeout", "create-threw", "cleanup-failed", "cleanup-timeout", "cleanup-threw"])("image mapping preparation: %s", async outcome => {
  const image = `localhost/prepared@sha256:${"a".repeat(64)}`, calls: string[][] = [];
  const asUser = (args: string[]) => ["runuser", "-u", "jit-s14", "--", ...args];
  const prepared = await prepareS14Image(image, 1234, async (argv, options) => {
    calls.push(argv);
    const creating = argv.includes("create"), phase = creating ? "create" : "cleanup";
    expect(options.timeoutMs).toBe(creating ? 600_000 : 30_000);
    if (outcome === `${phase}-threw`) throw new Error("private diagnostic");
    return { exitCode: outcome === `${phase}-failed` ? 1 : 0, timedOut: outcome === `${phase}-timeout`, stdout: "" };
  }, asUser);
  expect(prepared).toBe(outcome === "success");
  expect(calls).toHaveLength(2); // Never retry a create, including after timeout; always attempt exact-name cleanup.
  const create = calls[0]!, cleanup = calls[1]!;
  expect(create.slice(0, 8)).toEqual(["runuser", "-u", "jit-s14", "--", "podman", "--remote", "--url", "unix:///run/user/1234/podman/podman.sock"]);
  for (const arg of [`--userns=${botComputerUserNamespace}`, "--user=1000:1000", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pull=never", "--unsetenv-all", "--http-proxy=false"]) expect(create).toContain(arg);
  expect(create.at(-1)).toBe(image);
  expect(create).not.toContain("--mount"); expect(create).not.toContain("run"); expect(create).not.toContain("start");
  const name = create[create.indexOf("--name") + 1]!;
  expect(name).toMatch(/^jit-s14-image-prepare-[a-f0-9-]{36}$/);
  expect(cleanup.slice(-4)).toEqual(["rm", "--force", "--ignore", name]);
});

test("unprepared new and reused images never become configured pins", async () => {
  const release = fixture().at("release");
  mkdirSync(join(release, "ops"), { recursive: true });
  cpSync(join(source, "ops/box"), join(release, "ops/box"), { recursive: true });
  const run: OperatorHost["run"] = async argv => ({ exitCode: 0, timedOut: false, stdout: argv.includes("inspect") ? `sha256:${"c".repeat(64)}` : "" });
  const pins = await provisionS14Images(release, 1234, run, args => args);
  for (const current of [undefined, pins]) {
    const calls: string[][] = [];
    expect(await provisionS14Images(release, 1234, async (argv, options) => {
      calls.push(argv);
      return argv.includes("create") ? { exitCode: 1, timedOut: false, stdout: "" } : run(argv, options);
    }, args => args, current)).toBeUndefined();
    expect(calls.filter(argv => argv.includes("create"))).toHaveLength(1);
    expect(calls.at(-1)).toContain("rm");
  }
  let calls = 0;
  expect(await prepareS14Image("mutable:tag", 1234, async () => { calls++; throw new Error(); }, args => args)).toBe(false);
  expect(calls).toBe(0);
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

test("actual packaged entrypoint completes scripted first-owner Web setup, device sign-in and one persisted reply", async () => {
  const f = fixture(), { config } = await runInstaller(f.options), release = await artifact(f.root, "first-run", true);
  const env = Object.fromEntries(serviceEnvironment(config));
  const child = Bun.spawn([process.execPath, "--preload", join(source, "tests/fixtures/s14-packaged-first-run.ts"), join(release, "src/main.ts"), "serve"], {
    cwd: config.workingDirectory, env, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim().split("\n").map(line => JSON.parse(line).state)).toEqual(["s14_listening", "packaged_first_reply"]);
  expect(stdout).not.toContain("?token=");
  expect(existsSync(join(config.stateDirectory, "app.sqlite"))).toBe(false);
  const store = new S14Store(serviceDatabasePath(config));
  try {
    expect(store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM owner"))!.count).toBe(1);
    expect(store.read(tx => tx.get("SELECT name FROM sqlite_master WHERE name='projects'"))).toBeNull();
  } finally { store.close(); }
}, 30_000);

test("S14 service package install/upgrade/compatible rollback select only its unit and never legacy upgrade or password", async () => {
  const f = fixture(), { config } = await runInstaller(f.options), calls: string[][] = [];
  const art = await artifact(f.root, "first"), next = await artifact(f.root, "next");
  let active = false, schema = s14SchemaVersion, preparationFails = false;
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
      if (preparationFails && argv.includes("create")) return { exitCode: 1, stdout: "private diagnostic", timedOut: false };
      return { exitCode: 0, stdout, timedOut: false };
    } };
  const installed = await installService({ service: config, artifactDir: art, host });
  expect(installed.plan.checks.filter(check => !check.ok)).toEqual([]); expect(installed.ok).toBe(true);
  expect(existsSync(config.ledgerPath)).toBe(false);
  expect(existsSync(serviceDatabasePath(config))).toBe(false);
  const first = readlinkSync(config.executablePath);
  preparationFails = true;
  calls.length = 0;
  expect(await upgradePackage({ service: config, artifactDir: next, host, ownerPassword: "", health: async () => { throw new Error("must not activate"); } })).toMatchObject({ outcome: "blocked", detail: "S14 computer image preparation failed before activation" });
  expect(readlinkSync(config.executablePath)).toBe(first);
  expect(calls.filter(argv => argv.includes("create"))).toHaveLength(1);
  expect(calls.some(argv => argv[0] === "systemctl" && argv[1] === "start" && argv.includes("jit-s14.service"))).toBe(false);
  preparationFails = false;
  calls.length = 0;
  let healthCalls = 0;
  const result = await upgradePackage({ service: config, artifactDir: next, host, ownerPassword: "", health: async () => ++healthCalls === 2 });
  expect(healthCalls).toBe(2);
  expect(result.outcome).toBe("rolled-back"); expect(readlinkSync(config.executablePath)).toBe(first);
  const prepareIndices = calls.flatMap((argv, i) => argv.includes("create") ? [i] : []);
  expect(prepareIndices).toHaveLength(2);
  const startIndex = calls.findIndex(argv => argv[0] === "systemctl" && argv[1] === "start" && argv.includes("jit-s14.service"));
  expect(Math.max(...prepareIndices)).toBeLessThan(startIndex);
  healthCalls = 0;
  const unhealthy = await upgradePackage({ service: config, artifactDir: next, host, ownerPassword: "", health: async () => { healthCalls++; return false; } });
  expect(healthCalls).toBe(2);
  expect(unhealthy).toMatchObject({ outcome: "activation-unhealthy", supervisor: null });
  expect(readlinkSync(config.executablePath)).toBe(first);
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
  const images = { base: `localhost/base@sha256:${"c".repeat(64)}`, browser: `localhost/browser@sha256:${"d".repeat(64)}`, buildInputsHash: "e".repeat(64) };
  expect(parseServiceConfig({ ...config, s14: { ...config.s14, images } }).s14!.images).toEqual(images);
  expect(() => parseServiceConfig({ ...config, s14: { ...config.s14, images: { ...images, buildInputsHash: "invalid" } } })).toThrow("invalid_service_config");
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

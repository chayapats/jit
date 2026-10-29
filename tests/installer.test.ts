import { searxngImage } from "../src/web-tools/searxng";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installerDefaults, installerHealth, pinnedImages, prepareInstallerHome, runInstaller, subordinateIds, type HostFacts, type InstallerOptions } from "../ops/package/installer/installer";
import { buildInstallerRelease } from "../ops/package/installer/release";
import { artifactContentHash, buildPackage, installArtifactDependencies, validateArtifact } from "../ops/package/bun-build";
import { assertRootPath, assertRootTree, freezeInstallerArtifact } from "../ops/package/installer/trusted-paths";

const roots: string[] = [], source = resolve(import.meta.dir, ".."), GiB = 1024 ** 3;
const facts: HostFacts = { family: "ubuntu", arch: "x64", ramMb: 8192, cpus: 4, diskBytes: 100 * GiB, freeBytes: 80 * GiB };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture(overrides: Partial<HostFacts> = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-installer-")); roots.push(root);
  const hardware = { ...facts, ...overrides }; writeFileSync(join(root, "host.json"), JSON.stringify(hardware));
  const lines: string[] = [], calls: string[][] = [];
  const options: InstallerOptions = { root, facts: hardware, source, bunPath: process.execPath, dryRun: true, out: line => lines.push(line),
    run: async argv => { calls.push(argv); throw new Error("fake root must never execute a host command"); } };
  return { root, lines, calls, options, at: (path: string) => join(root, path) };
}

async function stagedFixture() {
  const f = fixture(), staging = f.at("staging"), releases = f.at("opt/jit/releases");
  const manifest = buildPackage({ srcDir: source, outDir: staging, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  await installArtifactDependencies(staging, { bunPath: process.execPath, env: {}, run: async argv => {
    if (argv[1] === "install") { mkdirSync(join(staging, "node_modules/example"), { recursive: true }); writeFileSync(join(staging, "node_modules/example/index.js"), "export default 1;\n"); }
    return { exitCode: 0, stdout: Bun.version, timedOut: false };
  } });
  mkdirSync(releases, { recursive: true });
  return { ...f, staging, releases, manifest, policy: { root: f.root, uid: process.getuid!() } };
}

test("fake-root privileged release uses protected new inodes including dependencies and every ancestor", async () => {
  const f = await stagedFixture(), file = join(f.staging, "src/main.ts"), fd = openSync(file, "r+");
  try {
    const frozen = freezeInstallerArtifact(f.staging, f.releases, f.manifest, f.policy);
    expect(() => assertRootTree(frozen.artifact, f.policy)).not.toThrow();
    const walk = (path: string) => {
      const stats = lstatSync(path);
      expect(stats.uid).toBe(f.policy.uid); expect(stats.mode & 0o022).toBe(0); expect(stats.isSymbolicLink()).toBe(false);
      if (stats.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    };
    walk(frozen.artifact);
    for (let path = frozen.artifact; path !== f.root; path = dirname(path)) expect(lstatSync(path).mode & 0o022).toBe(0);
    const pinned = readFileSync(join(frozen.artifact, "src/main.ts"), "utf8");
    expect(lstatSync(join(frozen.artifact, "src/main.ts")).ino).not.toBe(lstatSync(file).ino);
    writeSync(fd, "attacker", 0, "utf8");
    writeFileSync(join(f.staging, "node_modules/example/index.js"), "attacker");
    expect(readFileSync(join(frozen.artifact, "src/main.ts"), "utf8")).toBe(pinned);
    expect(validateArtifact(frozen.artifact, { runtime: true }).ok).toBe(true);
    chmodSync(f.releases, 0o775);
    expect(() => assertRootTree(frozen.artifact, f.policy)).toThrow("unsafe_root_path");
  } finally { closeSync(fd); }
});

test("fake-root release rejects staging mutation, resealed code, metadata links, dangling links and writable ancestors", async () => {
  const f = await stagedFixture();
  writeFileSync(join(f.staging, "src/main.ts"), "attacker");
  expect(() => freezeInstallerArtifact(f.staging, f.releases, f.manifest, f.policy)).toThrow("release_copy_invalid");
  const resealed = { ...f.manifest, contentHash: artifactContentHash(f.staging, f.manifest) };
  writeFileSync(join(f.staging, "manifest.json"), JSON.stringify(resealed));
  expect(() => freezeInstallerArtifact(f.staging, f.releases, f.manifest, f.policy)).toThrow("release_copy_invalid");
  for (const name of ["manifest.json", "dependencies.json", "node_modules/example/index.js"]) {
    const target = join(f.staging, name), saved = readFileSync(target); rmSync(target);
    symlinkSync(join(f.root, "missing"), target);
    expect(() => freezeInstallerArtifact(f.staging, f.releases, f.manifest, f.policy)).toThrow("unsafe_root_path");
    rmSync(target); writeFileSync(target, saved);
  }
  symlinkSync(join(f.root, "missing"), f.at("dangling"));
  expect(() => assertRootPath(f.at("dangling/code.ts"), f.policy)).toThrow("unsafe_root_path");
  expect(() => assertRootPath(f.releases, { ...f.policy, uid: f.policy.uid + 1 })).toThrow("unsafe_root_path");
  chmodSync(f.at("opt"), 0o777);
  expect(() => freezeInstallerArtifact(f.staging, f.releases, f.manifest, f.policy)).toThrow("unsafe_root_path");
});

test("installer health reaches IPv4/IPv6 HTTP listener with HTTPS origin Host and never follows ingress redirects", async () => {
  const f = fixture(), { config } = await runInstaller(f.options);
  for (const bindHost of ["127.0.0.1", "::1"]) {
    const network = { ...config.network, bindHost, origin: "https://private.example:8443" };
    const request = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe(`http://${bindHost === "::1" ? "[::1]" : bindHost}:3000/login`);
      expect(new Headers(init?.headers).get("host")).toBe("private.example:8443");
      expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    expect(await installerHealth({ ...config, network }, request)).toBe(true);
    expect(await installerHealth({ ...config, network }, (async () => new Response(null, { status: 302 })) as unknown as typeof fetch)).toBe(false);
  }
});

test("keyring and ledger preparation stays in the service identity and preserves the unlock value", () => {
  const f = fixture(), home = f.at("home"); mkdirSync(home);
  prepareInstallerHome(home);
  const unlock = readFileSync(join(home, "keyring-unlock"), "utf8");
  expect(lstatSync(join(home, "keyring-unlock")).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(home, "ledger/checkpoint.json")).mode & 0o777).toBe(0o600);
  prepareInstallerHome(home); expect(readFileSync(join(home, "keyring-unlock"), "utf8")).toBe(unlock);
  rmSync(join(home, "keyring-unlock")); symlinkSync(f.at("missing"), join(home, "keyring-unlock"));
  expect(() => prepareInstallerHome(home)).toThrow("unsafe_unlock_file"); expect(existsSync(f.at("missing"))).toBe(false);
});

test("host defaults scale RAM/CPU/disk on x64 and arm64 without Pi constants", () => {
  const ordinary = installerDefaults(facts), small = installerDefaults({ ...facts, arch: "arm64", ramMb: 1024, cpus: 1, diskBytes: 8 * GiB, freeBytes: 4 * GiB });
  expect(ordinary.diskReserveBytes).toBe(2 * GiB);
  expect(small.memoryMaxBytes).toBeLessThan(ordinary.memoryMaxBytes);
  expect(small.boxMemoryMb).toBe(256); expect(small.boxCpus).toBe(0.5);
  expect(small.diskReserveBytes).toBeLessThan(ordinary.diskReserveBytes);
  const large = installerDefaults({ ...facts, ramMb: 262144, cpus: 64, diskBytes: 2048 * GiB });
  expect(large.memoryMaxBytes).toBe(8 * GiB); expect(large.maxBoxes).toBe(8); expect(large.diskReserveBytes).toBe(16 * GiB);
  expect(() => installerDefaults({ ...facts, arch: "armv7l" })).toThrow("unsupported-host-facts");
});

test("fake-root install creates restricted attachments and units, preserves config/data/keyring/ranges on repair", async () => {
  const f = fixture(), first = await runInstaller(f.options), configPath = f.at("/etc/jit/service-config.json");
  expect(f.calls).toHaveLength(0);
  expect(statSync(f.at("/opt/jit/bin")).mode & 0o777).toBe(0o755);
  expect(statSync(join(first.config.stateDirectory, "attachments")).mode & 0o777).toBe(0o700);
  expect(statSync(f.at("/var/lib/jit/keyring-unlock")).mode & 0o777).toBe(0o600);
  expect(statSync(configPath).mode & 0o777).toBe(0o640);
  const unit = readFileSync(f.at("/etc/systemd/system/jit.service"), "utf8");
  expect(unit).toContain("User=jit"); expect(unit).toContain("127.0.0.1"); expect(unit).not.toContain("User=root");
  expect(first.config.runPort).toBe("schway"); expect(first.config.network.bindHost).toBe("127.0.0.1");
  const config = readFileSync(configPath, "utf8"), unlock = readFileSync(f.at("/var/lib/jit/keyring-unlock"), "utf8"), range = readFileSync(f.at("/etc/subuid"), "utf8");
  writeFileSync(join(first.config.stateDirectory, "keep-data"), "preserve");
  await runInstaller(f.options);
  expect(readFileSync(configPath, "utf8")).toBe(config); expect(readFileSync(f.at("/var/lib/jit/keyring-unlock"), "utf8")).toBe(unlock);
  expect(readFileSync(f.at("/etc/subuid"), "utf8")).toBe(range); expect(readFileSync(join(first.config.stateDirectory, "keep-data"), "utf8")).toBe("preserve");
  expect(f.lines.join("\n")).not.toContain(unlock); expect(f.lines.join("\n")).not.toContain("?token=");
});

test("missing Podman and unavailable optional images never block core installation", async () => {
  const f = fixture({ family: "fedora", arch: "arm64" });
  const result = await runInstaller({ ...f.options, simulation: { podman: false, images: [{ feature: "sanitizer", ref: `registry.example/sanitizer@sha256:${"a".repeat(64)}` }] } });
  expect(result.events).toContain("health"); expect(f.lines.join("\n")).toContain("Chat-only installation is ready");
  expect(existsSync(f.at("/etc/subuid"))).toBe(false); expect(f.calls).toHaveLength(0);
});

test("image list is digest-only, extensible and includes the managed search pin; invalid optional list is skipped", async () => {
  expect(pinnedImages()).toContainEqual({ feature: "search", ref: searxngImage });
  expect(() => pinnedImages([{ feature: "search", ref: "searxng:latest" }])).toThrow("invalid-image-list");
  const f = fixture(); await runInstaller({ ...f.options, simulation: { images: [{ feature: "search", ref: "searxng:latest" }] } });
  expect(f.lines.join("\n")).toContain("skipping pre-pull"); expect(f.lines.at(-1)).toContain("Dry run complete");
});

test("a failed optional digest pull reports its feature and still reaches owner-link", async () => {
  const f = fixture();
  const result = await runInstaller({ ...f.options, simulation: { failStep: "optional-images", images: [{ feature: "sanitizer", ref: `registry.example/sanitizer@sha256:${"b".repeat(64)}` }] } });
  expect(f.lines.join("\n")).toContain("Optional image unavailable: sanitizer");
  expect(result.events.at(-1)).toBe("owner-link");
});

test("subuid/gid allocation avoids every existing range and is idempotent", () => {
  const before = "other:100000:65536\n", gid = "group:200000:65536\n", ranges = subordinateIds(before, gid, "jit");
  expect(ranges.subuid).toBe(`${before}jit:265536:65536\n`); expect(ranges.subgid).toBe(`${gid}jit:265536:65536\n`);
  expect(subordinateIds(ranges.subuid, ranges.subgid, "jit")).toEqual(ranges);
  expect(() => subordinateIds("broken\n", "", "jit")).toThrow("invalid-subordinate-ids");
});

test("low disk reserve fails before provisioning and names the step and next action", async () => {
  const f = fixture({ freeBytes: GiB });
  await expect(runInstaller(f.options)).rejects.toThrow("Failed at disk-reserve. Next: free disk space");
  expect(existsSync(f.at("/var/lib/jit"))).toBe(false); expect(f.calls).toHaveLength(0);
});

test("failure at each core step is actionable and a subsequent repair resumes", async () => {
  for (const step of ["identity", "directories", "subordinate-ids", "keyring", "artifact", "configuration", "service-install", "state-initialize", "owner-link", "service-start", "health"]) {
    const f = fixture();
    await expect(runInstaller({ ...f.options, simulation: { failStep: step } })).rejects.toThrow(`Failed at ${step}. Next:`);
    expect((await runInstaller(f.options)).events).toContain("optional-box-doctor"); expect(f.calls).toHaveLength(0);
  }
});

test("uninstall removes only units/journald and preserves data/config/identity material", async () => {
  const f = fixture(), installation = await runInstaller(f.options);
  writeFileSync(join(installation.config.stateDirectory, "keep"), "data");
  await runInstaller({ ...f.options, uninstall: true });
  expect(existsSync(f.at("/etc/systemd/system/jit.service"))).toBe(false);
  expect(existsSync(f.at("/etc/systemd/journald@jit.conf"))).toBe(false);
  expect(readFileSync(join(installation.config.stateDirectory, "keep"), "utf8")).toBe("data");
  expect(existsSync(f.at("/etc/jit/service-config.json"))).toBe(true);
  expect(existsSync(f.at("/var/lib/jit/keyring-unlock"))).toBe(true);
  expect(existsSync(join(installation.config.stateDirectory, "attachments"))).toBe(true);
});

test("fake-root path traversal through a symlink fails before writing outside its root", async () => {
  const f = fixture(), other = fixture(); mkdirSync(f.at("/var")); symlinkSync(other.root, f.at("/var/lib"));
  await expect(runInstaller(f.options)).rejects.toThrow("unexpected symlink");
  expect(existsSync(join(other.root, "jit"))).toBe(false);
  await expect(runInstaller({ ...f.options, root: "/" })).rejects.toThrow("disposable absolute --root");
});

test("POSIX scripted dry run asks once; cancellation makes no changes; --yes repairs/uninstalls with no host tools", async () => {
  const f = fixture(), traps = join(f.root, "traps"), called = join(f.root, "host-command-called"); mkdirSync(traps);
  for (const tool of ["sudo", "systemctl", "apt-get", "dnf", "loginctl", "runuser", "podman", "useradd"]) writeFileSync(join(traps, tool), `#!/bin/sh\nprintf called >> '${called}'\nexit 99\n`, { mode: 0o755 });
  const exec = async (args: string[], input: string) => {
    const child = Bun.spawn(["sh", join(source, "install.sh"), "--dry-run", "--root", f.root, ...args], { env: { ...process.env, PATH: `${traps}:${process.env.PATH}` }, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  const cancelled = await exec([], "n\n"); expect(cancelled.exit).toBe(0); expect(cancelled.stdout).toContain("Cancelled"); expect(existsSync(f.at("/var"))).toBe(false);
  const confirmed = await exec([], "y\n"); expect(confirmed.exit).toBe(0); expect(confirmed.stderr.match(/Apply this plan/g)).toHaveLength(1);
  const again = await exec(["--yes"], ""); expect(again.exit).toBe(0); expect(again.stderr).not.toContain("Apply this plan");
  const removed = await exec(["--yes", "--uninstall"], ""); expect(removed.exit).toBe(0); expect(existsSync(f.at("/etc/systemd/system/jit.service"))).toBe(false);
  expect(existsSync(called)).toBe(false);
});

test("release tarball carries an intact artifact and can dry-run before installing any dependencies", async () => {
  const f = fixture(), output = f.at("assets"), extracted = f.at("extracted");
  const release = await buildInstallerRelease(source, output, "test-installer"); mkdirSync(extracted);
  expect(readFileSync(release.bootstrap, "utf8")).toContain("release_url=https://github.com/chayapats/jit/releases/download/test-installer");
  const unpack = Bun.spawn(["tar", "-xzf", release.archive, "-C", extracted], { stdout: "ignore", stderr: "pipe" });
  expect(await unpack.exited).toBe(0);
  expect(validateArtifact(join(extracted, "artifact")).ok).toBe(true);
  expect(existsSync(join(extracted, "artifact/node_modules"))).toBe(false);
  const child = Bun.spawn(["sh", join(extracted, "install.sh"), "--dry-run", "--yes", "--root", f.root], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" }); expect(stdout).toContain("Dry run complete");
});

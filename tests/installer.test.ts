import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installerDefaults, pinnedImages, runInstaller, subordinateIds, type HostFacts, type InstallerOptions } from "../ops/package/installer/installer";
import { buildInstallerRelease } from "../ops/package/installer/release";
import { validateArtifact } from "../ops/package/bun-build";

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

test("image list is digest-only, extensible and empty until real images exist; invalid optional list is skipped", async () => {
  expect(pinnedImages()).toEqual([]);
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

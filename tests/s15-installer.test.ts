import { afterEach, expect, test } from "bun:test";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInstaller, type HostFacts, type InstallerOptions } from "../ops/package/installer/installer";
import { readS15ComputerProgress, renderS15ProxySocket, renderS15Sudoers, renderS15Unit, runS15Installer, s15Installation, s15InstallerConfig, s15OwnerLinkArguments, s15QemuProcesses, stopS15WorkingVms, type S15ComputerProgress, type S15InstallerOptions } from "../ops/package/installer/s15";
import { assertNoSecretValues } from "../ops/package/service-config";
import { renderVmmLauncher } from "../src/s15/vm/vmm-launcher";
import { parseS15RuntimeConfig, readS15RuntimeConfig } from "../src/s15/runtime-config";
import { selectRuntime } from "../src/runtime-selection";

const roots: string[] = [], source = resolve(import.meta.dir, ".."), GiB = 1024 ** 3;
const facts: HostFacts = { family: "ubuntu", arch: "x64", ramMb: 19 * 1024, cpus: 10, diskBytes: 195 * GiB, freeBytes: 152 * GiB };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s15-installer-"))); roots.push(root);
  mkdirSync(join(root, "proc/self"), { recursive: true });
  for (const name of ["uid_map", "gid_map"]) writeFileSync(join(root, "proc/self", name), "0 0 4294967295\n");
  writeFileSync(join(root, "host.json"), JSON.stringify(facts));
  const lines: string[] = [];
  const options: S15InstallerOptions = { root, facts, source, bunPath: process.execPath, dryRun: true, out: line => lines.push(line), sleep: async () => {},
    run: async () => { throw new Error("fake root must never execute a host command"); } };
  return { root, lines, options, at: (path: string) => join(root, path) };
}
const install = (f: ReturnType<typeof fixture>, simulation: S15InstallerOptions["simulation"] = {}, extra: Partial<S15InstallerOptions> = {}) => runS15Installer({ ...f.options, ...extra, simulation });
/** Byte/mode/link snapshot of one installation's trees, without following links. */
function tree(f: ReturnType<typeof fixture>, paths: string[]) {
  const visit = (path: string): unknown => {
    if (!existsSync(path) && !(() => { try { lstatSync(path); return true; } catch { return false; } })()) return null;
    const stat = lstatSync(path);
    return { mode: stat.mode, link: stat.isSymbolicLink() ? readlinkSync(path) : null, bytes: stat.isFile() ? readFileSync(path).toString("hex") : null,
      children: stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map(name => [name, visit(join(path, name))])) : null };
  };
  return paths.map(path => visit(f.at(path)));
}
const s15Trees = ["var/lib/jit-s15", "var/lib/jit-s15-vm", "var/lib/jit-s15-vmm", "opt/jit-s15", "etc/jit-s15", "etc/sudoers.d", "etc/systemd/system/jit-s15.service", "etc/systemd/system/jit-s15-vm-proxy.socket", "etc/systemd/journald@jit-s15.conf"];
const otherTrees = (name: "jit" | "jit-s14") => [`var/lib/${name}`, `opt/${name}`, `etc/${name}`, `etc/systemd/system/${name}.service`, `etc/systemd/journald@${name}.conf`];
const stateMarker = (f: ReturnType<typeof fixture>) => f.at("var/lib/jit-s15/state/runtime/composition.json");

test("a fresh S15 install creates the separate installation, its QEMU identity boundary and a credential-free config", async () => {
  const f = fixture(), result = await install(f, { release: "release-a" });
  expect(result.events).toEqual(["preflight", "disk-reserve", "identity", "directories", "keyring", "vm-identity", "artifact", "configuration", "owner-terminal", "state-initialize", "owner-link-prepare", "service-install", "service-start", "health", "owner-link", "working-computer"]);
  const config = JSON.parse(readFileSync(f.at(s15Installation.config), "utf8"));
  expect(lstatSync(f.at(s15Installation.config)).mode & 0o777).toBe(0o640);
  expect(config).toMatchObject({ contract: "s15-runtime/v1", directory: "/var/lib/jit-s15/state", origin: "http://127.0.0.1:3002", policy: null, resourceBots: [], browser: null, github: null, google: null,
    conversation: { route: { provider: "codex", model: "gpt-6.1-sol" } }, team: { maxConcurrentOperations: 2, memory: "off" },
    vm: { id: "working", limaInstance: null, local: true, vmm: { user: "jit-s15-vmm", uid: 1002, directory: "/var/lib/jit-s15-vm", launcher: "/opt/jit-s15/libexec/jit-s15-vmm" } } });
  expect(config.installationId).toMatch(/^s15_[a-f0-9]{16}$/);
  expect(config.models).toHaveLength(1);
  expect(config.models[0]).toMatchObject({ provider: "codex", modelId: "gpt-6.1-sol", charge: "subscription", availability: "available" });
  expect(config.disclosure).toEqual({ sources: [], approvals: [], githubRecipient: null, googleRecipient: null, browser: [], acquisitions: [], registries: [] });
  expect(() => parseS15RuntimeConfig(config)).not.toThrow(); expect(() => assertNoSecretValues(JSON.stringify(config))).not.toThrow();
  expect(JSON.stringify(config)).not.toMatch(/token|password|secret|budget/i);
  // Unit, launcher and sudoers rule.
  const unit = readFileSync(f.at(s15Installation.unit), "utf8");
  expect(unit).toBe(renderS15Unit({ uid: 1001, vmmUid: 1002, memoryMaxBytes: Math.floor(facts.ramMb / 3) * 1024 ** 2 }));
  expect(unit).toContain("ExecStart=/opt/jit-s15/bin/bun /opt/jit-s15/current/src/main.ts serve --s15 --config /etc/jit-s15/s15-runtime.json");
  expect(unit).toContain("User=jit-s15\n"); expect(unit).toContain("ReadWritePaths=/var/lib/jit-s15 /var/lib/jit-s15-vm\n");
  expect(unit).toContain("BindPaths=/run/user/1002\n"); expect(unit).toContain("LogNamespace=jit-s15\n"); expect(unit).not.toContain("NoNewPrivileges");
  expect(unit).not.toMatch(/qemu|kvm/i);
  expect(readFileSync(f.at(s15Installation.journald), "utf8")).toContain("SystemMaxUse=");
  // The registry-proxy socket is bound by systemd in the root mount namespace and passed to the controller.
  const socket = readFileSync(f.at(s15Installation.proxySocketUnit), "utf8");
  expect(socket).toBe(renderS15ProxySocket());
  for (const line of ["ListenStream=/var/lib/jit-s15-vm/control/proxy.sock", "FileDescriptorName=jit-s15-vm-proxy", "SocketUser=jit-s15", "SocketGroup=jit-s15-vm", "SocketMode=0660", "PartOf=jit-s15.service"]) expect(socket).toContain(`${line}\n`);
  for (const line of ["Requires=jit-s15-vm-proxy.socket", "Sockets=jit-s15-vm-proxy.socket"]) expect(unit).toContain(`${line}\n`);
  expect(readFileSync(f.at(s15Installation.launcher), "utf8")).toBe(renderVmmLauncher(config.vm.vmm));
  expect(lstatSync(f.at(s15Installation.launcher)).mode & 0o777).toBe(0o755);
  expect(readFileSync(f.at(s15Installation.sudoers), "utf8")).toBe(renderS15Sudoers());
  expect(renderS15Sudoers()).toContain("jit-s15 ALL=(jit-s15-vmm) NOPASSWD: /opt/jit-s15/libexec/jit-s15-vmm\n");
  expect(lstatSync(f.at(s15Installation.sudoers)).mode & 0o777).toBe(0o440);
  expect(readdirSync(f.at("etc/sudoers.d"))).toEqual(["jit-s15-vmm"]);
  // Directories and the atomically switched release.
  for (const [path, mode] of [["var/lib/jit-s15", 0o700], ["var/lib/jit-s15-vmm", 0o700], ["var/lib/jit-s15-vm", 0o750], ["var/lib/jit-s15-vm/control", 0o750], ["var/lib/jit-s15-vm/control/images", 0o750], ["var/lib/jit-s15-vm/machines", 0o750], ["etc/jit-s15", 0o750]] as const)
    expect({ path, mode: lstatSync(f.at(path)).mode & 0o777 }).toEqual({ path, mode });
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-a"));
  expect(existsSync(stateMarker(f))).toBe(true);
  expect(JSON.parse(readFileSync(f.at(s15Installation.installerState), "utf8"))).toMatchObject({ runtime: "s15", release: "/opt/jit-s15/releases/release-a" });
  expect(f.lines).toContain("Working computer: Ready / พร้อมใช้");
  expect(f.lines.some(line => line.includes("/settings/provider") && line.includes("Codex"))).toBe(true);
  expect(f.lines.join("\n")).not.toContain("?token=");
});

test("a re-run repairs idempotently: config, installation id and state are preserved and nothing is re-initialized", async () => {
  const f = fixture(); await install(f, { release: "release-a" });
  const config = readFileSync(f.at(s15Installation.config)), marker = readFileSync(stateMarker(f));
  writeFileSync(join(f.at("var/lib/jit-s15/state"), "owner-data"), "retained");
  rmSync(f.at(s15Installation.launcher)); chmodSync(f.at("var/lib/jit-s15-vm/control"), 0o777);
  const again = await install(f, { release: "release-a" });
  expect(again.events).toContain("service-stop");
  expect(readFileSync(f.at(s15Installation.config))).toEqual(config);
  expect(readFileSync(stateMarker(f))).toEqual(marker); expect(readFileSync(join(f.at("var/lib/jit-s15/state"), "owner-data"), "utf8")).toBe("retained");
  expect(existsSync(f.at(s15Installation.launcher))).toBe(true); expect(lstatSync(f.at("var/lib/jit-s15-vm/control")).mode & 0o777).toBe(0o750);
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-a"));
});

test("BROW15-02: a failed upgrade restores the previous release's composition manifest; a per-release copy serves rollback by hand", async () => {
  const f = fixture(); await install(f, { release: "release-a" }); await install(f, { release: "release-b" });
  const before = readFileSync(stateMarker(f), "utf8"), copy = f.at("etc/jit-s15/composition.release-b.json");
  // The new release lists a store the previous release does not know, then fails its health check.
  const started = () => { writeFileSync(stateMarker(f), JSON.stringify({ contract: "s15-composition/v1", stores: ["browser.sqlite"] })); writeFileSync(f.at("var/lib/jit-s15/state/runtime/browser.sqlite"), "store of the new release", { mode: 0o600 }); };
  await expect(install(f, { release: "release-c", health: [false, true], started })).rejects.toThrow(/The previous release \/opt\/jit-s15\/releases\/release-b is active again and healthy\./);
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-b"));
  expect(readFileSync(stateMarker(f), "utf8")).toBe(before); expect(lstatSync(stateMarker(f)).mode & 0o777).toBe(0o600);
  // The added store stays on disk, unlisted: an earlier release checks only the stores its manifest lists.
  expect(readFileSync(f.at("var/lib/jit-s15/state/runtime/browser.sqlite"), "utf8")).toBe("store of the new release");
  expect(readFileSync(copy, "utf8")).toBe(before); expect(lstatSync(copy).mode & 0o777).toBe(0o640);
  // A healthy upgrade keeps the manifest the new release wrote and refreshes the copy of the release it left.
  await install(f, { release: "release-c", started });
  expect(JSON.parse(readFileSync(stateMarker(f), "utf8")).stores).toEqual(["browser.sqlite"]); expect(readFileSync(copy, "utf8")).toBe(before);
  await install(f, { release: "release-d" }); expect(JSON.parse(readFileSync(f.at("etc/jit-s15/composition.release-c.json"), "utf8")).stores).toEqual(["browser.sqlite"]);
});

test("an upgrade switches the release atomically; a failed health check restores the previous release and unit", async () => {
  const f = fixture(); await install(f, { release: "release-a" });
  await install(f, { release: "release-b" });
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-b"));
  const unit = readFileSync(f.at(s15Installation.unit), "utf8"), state = tree(f, ["var/lib/jit-s15/state"]);
  await expect(install(f, { release: "release-c", health: [false, true] })).rejects.toThrow(/Failed at health\. Next: .*The previous release \/opt\/jit-s15\/releases\/release-b is active again and healthy\./);
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-b"));
  expect(readFileSync(f.at(s15Installation.unit), "utf8")).toBe(unit);
  expect(tree(f, ["var/lib/jit-s15/state"])).toEqual(state);
  // Releases are immutable and retained; a later healthy re-run moves forward.
  expect(existsSync(f.at("opt/jit-s15/releases/release-c"))).toBe(true);
  await install(f, { release: "release-c" });
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-c"));
});

const freshSteps = ["preflight", "disk-reserve", "identity", "directories", "keyring", "vm-identity", "artifact", "configuration", "owner-terminal", "state-initialize", "owner-link-prepare", "service-install", "service-start", "health"];
test.each(freshSteps)("a fresh install failing at %s leaves no unit, release link or new state, and a re-run completes", async failStep => {
  const f = fixture();
  await expect(install(f, { release: "release-a", ...(failStep === "health" ? { health: [false] } : { failStep }) })).rejects.toThrow(`Failed at ${failStep}.`);
  for (const path of [s15Installation.unit, s15Installation.journald, s15Installation.proxySocketUnit, "opt/jit-s15/current", "var/lib/jit-s15/state"]) expect({ path, exists: existsSync(f.at(path)) }).toEqual({ path, exists: false });
  expect(f.lines.includes("Step: rollback")).toBe(["service-install", "service-start", "health"].includes(failStep));
  const result = await install(f, { release: "release-a" });
  expect(result.events.at(-1)).toBe("working-computer");
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-a")); expect(existsSync(stateMarker(f))).toBe(true);
});

test.each([...freshSteps.filter(step => step !== "preflight"), "service-stop"])("an upgrade failing at %s keeps the previous release, unit, config and state", async failStep => {
  const f = fixture(); await install(f, { release: "release-a" });
  const before = tree(f, ["opt/jit-s15/current", "etc/jit-s15/s15-runtime.json", s15Installation.unit, s15Installation.journald, s15Installation.proxySocketUnit, "var/lib/jit-s15/state"]);
  await expect(install(f, { release: "release-b", ...(failStep === "health" ? { health: [false, true] } : { failStep }) })).rejects.toThrow(`Failed at ${failStep}.`);
  expect(tree(f, ["opt/jit-s15/current", "etc/jit-s15/s15-runtime.json", s15Installation.unit, s15Installation.journald, s15Installation.proxySocketUnit, "var/lib/jit-s15/state"])).toEqual(before);
  await install(f, { release: "release-b" });
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-b"));
});

test("the working computer's progress is printed; a failure keeps the healthy controller and names the reason", async () => {
  const f = fixture();
  await expect(install(f, { release: "release-a", computer: [{ state: "running", step: "download", history: ["host", "download"] }, { state: "running", step: "boot", history: ["host", "download", "checksum", "disk", "boot"] }, { state: "failed", step: "download", code: "vm_image_unavailable" }] }))
    .rejects.toThrow(/Failed at working-computer\. Next: Couldn’t download the Ubuntu image\. Check this machine’s internet connection/);
  // Each recorded step is printed once, in order, including steps finished between polls.
  expect(f.lines.filter(line => line.startsWith("Working computer: "))).toEqual(["Check this machine: KVM, QEMU, disk and memory / ตรวจเครื่องนี้: KVM, QEMU, ดิสก์ และหน่วยความจำ",
    "Download the pinned Ubuntu image / ดาวน์โหลด Ubuntu รุ่นที่ระบุไว้", "Verify the image checksum / ตรวจ checksum ของไฟล์", "Create the disk and the machine’s keys / สร้างดิสก์และกุญแจของเครื่อง", "First boot / เปิดเครื่องครั้งแรก"].map(text => `Working computer: ${text}`));
  expect(f.lines).not.toContain("Step: rollback");
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-a")); expect(existsSync(f.at(s15Installation.unit))).toBe(true);
  // A host that cannot run the nested VM completes with the reason; the Web offers an owner-supplied VM.
  const g = fixture(), result = await install(g, { release: "release-a", computer: [{ state: "none", host: "vm_kvm_unavailable" }] });
  expect(result.computer).toEqual({ state: "none", host: "vm_kvm_unavailable" });
  expect(g.lines.some(line => line.includes("Working computer unavailable on this host (vm_kvm_unavailable)") && line.includes("nested virtualization"))).toBe(true);
});

test("legacy and S14 installations stay byte-identical through S15 install, upgrade, rollback and uninstall", async () => {
  const f = fixture(), base: InstallerOptions = { root: f.root, facts, source, bunPath: process.execPath, dryRun: true, run: async () => { throw new Error("no host commands"); } };
  await runInstaller({ ...base, s14: false }); await runInstaller({ ...base, s14: true });
  // Replace the S14 fake-root sparse disk images with compact byte sentinels (their real handling is covered elsewhere).
  const compact = (path: string) => { const stat = lstatSync(path); if (stat.isDirectory()) for (const name of readdirSync(path)) compact(join(path, name)); else if (stat.isFile() && stat.size >= 1024 ** 3) writeFileSync(path, `retained fake disk ${path}`); };
  compact(f.at("var/lib/jit-s14/computers"));
  for (const name of ["jit", "jit-s14"]) { mkdirSync(f.at(`var/lib/${name}/state`), { recursive: true }); writeFileSync(f.at(`var/lib/${name}/state/sentinel`), `${name} data`); }
  const legacy = tree(f, otherTrees("jit")), s14 = tree(f, otherTrees("jit-s14")), subids = tree(f, ["etc/subuid", "etc/subgid"]);
  await install(f, { release: "release-a" }); await install(f, { release: "release-b" });
  await expect(install(f, { release: "release-c", health: [false, true] })).rejects.toThrow("Failed at health.");
  await runS15Installer({ ...f.options, uninstall: true });
  expect(tree(f, otherTrees("jit"))).toEqual(legacy); expect(tree(f, otherTrees("jit-s14"))).toEqual(s14); expect(tree(f, ["etc/subuid", "etc/subgid"])).toEqual(subids);
  // And the reverse: re-running the other installers leaves the S15 installation unchanged.
  await install(f, { release: "release-b" });
  const s15 = tree(f, s15Trees);
  // (A full S14 repair over the compacted fake disks is covered by the S14 suites; its uninstall is exercised here.)
  await runInstaller({ ...base, s14: false }); await runInstaller({ ...base, s14: false, uninstall: true }); await runInstaller({ ...base, s14: true, uninstall: true });
  expect(tree(f, s15Trees)).toEqual(s15);
});

test("a foreign file at the S15 config path is never reinterpreted and refuses before any change", async () => {
  const f = fixture(), legacy = { serviceUser: "jit", executablePath: "/opt/jit/current", workingDirectory: "/var/lib/jit/work", stateDirectory: "/var/lib/jit/state" };
  for (const foreign of [JSON.stringify(legacy), JSON.stringify({ ...s15InstallerConfig({ installationId: "s15_other", vmm: { user: "jit-s15-vmm", uid: 1002, directory: "/var/lib/jit-s15-vm", launcher: "/opt/jit-s15/libexec/jit-s15-vmm" } }), directory: "/var/lib/jit-s14/state" }), "{not json"]) {
    rmSync(f.at("etc"), { recursive: true, force: true }); mkdirSync(f.at("etc/jit-s15"), { recursive: true }); writeFileSync(f.at(s15Installation.config), foreign);
    const before = readdirSync(f.root).sort();
    await expect(install(f, { release: "release-a" })).rejects.toThrow("Failed at preflight.");
    expect(readdirSync(f.root).sort()).toEqual(before); expect(readFileSync(f.at(s15Installation.config), "utf8")).toBe(foreign);
  }
});

test("uninstall removes only the S15 service units and retains config, state, releases, launcher, rule and VM disks", async () => {
  const f = fixture(); await install(f, { release: "release-a" });
  mkdirSync(f.at("var/lib/jit-s15-vm/machines/jit-work-0123456789ab"), { recursive: true }); writeFileSync(f.at("var/lib/jit-s15-vm/machines/jit-work-0123456789ab/disk.qcow2"), "guest disk");
  const retained = ["etc/jit-s15", "var/lib/jit-s15/state", "var/lib/jit-s15-vm", "opt/jit-s15", "etc/sudoers.d"], before = tree(f, retained);
  const result = await runS15Installer({ ...f.options, uninstall: true });
  expect(result.events).toEqual(["uninstall"]);
  for (const path of [s15Installation.unit, s15Installation.journald, s15Installation.proxySocketUnit, "var/lib/jit-s15/.config/systemd/user/gnome-keyring-daemon.service"]) expect(existsSync(f.at(path))).toBe(false);
  expect(tree(f, retained)).toEqual(before);
  await runS15Installer({ ...f.options, uninstall: true });
  expect(tree(f, retained)).toEqual(before);
  // Re-installing re-attaches to the retained state without re-initializing it.
  const marker = readFileSync(stateMarker(f)); await install(f, { release: "release-a" }); expect(readFileSync(stateMarker(f))).toEqual(marker);
});

async function sh(args: string[], stdin = "") {
  const child = Bun.spawn(["sh", join(source, "install.sh"), ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("install.sh: --s15 is mutually exclusive with --s14/--legacy and S14 slots, refusing before any write", async () => {
  for (const flags of [["--s15", "--s14"], ["--s14", "--s15"], ["--s15", "--legacy"], ["--legacy", "--s15"], ["--s15", "--s15"], ["--s15", "--computer-slots", "12"]]) {
    const f = fixture(), before = readdirSync(f.root).sort();
    const result = await sh(["--dry-run", "--root", f.root, ...flags]);
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Failed at arguments"); expect(result.stderr).not.toContain("Apply this plan");
    expect(readdirSync(f.root).sort()).toEqual(before);
  }
});

test("install.sh --s15 --dry-run prints the S15 plan and installs into the fake root only; --uninstall keeps data", async () => {
  const f = fixture();
  const result = await sh(["--dry-run", "--root", f.root, "--s15", "--yes", "--source", source]);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(result.stdout).toContain("Selected runtime: S15 (--s15). Installation: jit-s15, separate; legacy and S14 installations are never read or changed.");
  expect(result.stdout).toContain('"runtime":"s15"'); expect(result.stdout).toContain("Dry run complete.");
  expect(parseS15RuntimeConfig(JSON.parse(readFileSync(f.at(s15Installation.config), "utf8"))).directory).toBe("/var/lib/jit-s15/state");
  for (const name of ["etc/jit", "etc/jit-s14", "opt/jit", "opt/jit-s14", "var/lib/jit", "var/lib/jit-s14"]) expect(existsSync(f.at(name))).toBe(false);
  const removal = await sh(["--dry-run", "--root", f.root, "--s15", "--uninstall", "--yes", "--source", source]);
  expect({ code: removal.code, stderr: removal.stderr }).toEqual({ code: 0, stderr: "" });
  expect(removal.stdout).toContain("Action: uninstall jit-s15 only.");
  expect(existsSync(f.at(s15Installation.unit))).toBe(false); expect(existsSync(f.at(s15Installation.config))).toBe(true);
});

test("the internal apply entry accepts --s15 only alone, never with an S14 selection or slots", async () => {
  for (const flags of [["--s15", "true", "--s14", "true"], ["--s15", "true", "--s14", "false"], ["--s15", "false"], ["--s15", "true", "--computer-slots", "8"], ["--s15", "yes"]]) {
    const f = fixture(), before = readdirSync(f.root).sort();
    const child = Bun.spawn([process.execPath, join(source, "ops/package/installer/main.ts"), "apply", "--root", f.root, "--dry-run", "true", "--source", source, ...flags], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1); expect(await new Response(child.stderr).text()).toContain("Failed at installer-input");
    expect(readdirSync(f.root).sort()).toEqual(before);
  }
});

test("the privileged re-exec carries --s15 through local and downloaded bootstrap paths", async () => {
  const script = readFileSync(join(source, "install.sh"), "utf8");
  const block = script.slice(script.indexOf("step=privileges\n"), script.indexOf("PATH=/usr/sbin:/usr/bin:/sbin:/bin\n"));
  for (const downloaded of [true, false]) {
    const f = fixture(), harness = f.at("reexec.sh"), recorded = f.at("argv.json"), recorder = f.at("record.ts");
    writeFileSync(recorder, 'await Bun.write(process.env.RECORDED!, JSON.stringify({argv:process.argv.slice(2)}));\n');
    writeFileSync(harness, `set -eu\ns14=false\ns15=true\ncomputer_slots=8\nsource_dir=${downloaded ? "" : source}\nuninstall=false\nrelease_url=https://release.example.test\nscratch=\nreported=false\nfailed() { exit 90; }\ntrusted_input() { :; }\nid() { printf '1001\\n'; }\ncurl() { for fetched in "$@"; do :; done; cp "$BOOTSTRAP" "$fetched"; }\nsudo() { "$TEST_BUN" "$RECORDER" "$@"; }\n${block}`);
    const env = { PATH: process.env.PATH, HOME: f.root, BOOTSTRAP: join(source, "install.sh"), TEST_BUN: process.execPath, RECORDER: recorder, RECORDED: recorded };
    const child = Bun.spawn(downloaded ? ["sh", "-s"] : ["sh", harness], { cwd: f.root, env, stdin: downloaded ? new TextEncoder().encode(readFileSync(harness, "utf8")) : "ignore", stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(readFileSync(recorded, "utf8")).argv).toEqual(["sh", "-s", "--", "--yes", "--s15", ...(!downloaded ? ["--source", source] : [])]);
  }
});

test("the generated config initializes a fresh S15 runtime with the separate QEMU identity, and the progress helper reads it", async () => {
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "js15-"))); roots.push(root);
  const vmm = { user: "jit-s15-vmm", uid: 4242, directory: join(root, "vm"), launcher: "/opt/jit-s15/libexec/jit-s15-vmm" };
  for (const [path, mode] of [[vmm.directory, 0o750], [join(vmm.directory, "control"), 0o2750], [join(vmm.directory, "control/images"), 0o2750], [join(vmm.directory, "machines"), 0o2750]] as const) {
    mkdirSync(path); chownSync(path, process.getuid!(), process.getgid!()); chmodSync(path, mode);
  }
  const config = { ...s15InstallerConfig({ installationId: "s15_0123456789abcdef", vmm }), directory: join(root, "state") }, path = join(root, "s15-runtime.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  expect(readS15RuntimeConfig(path).vm.vmm).toEqual(vmm);
  const child = Bun.spawn([process.execPath, "src/main.ts", "init", "--s15", "--config", path], { cwd: source, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(JSON.parse(stdout)).toMatchObject({ state: "s15_initialized", policy: "not_installed" });
  expect(existsSync(join(root, "state/runtime/composition.json"))).toBe(true);
  // No job yet: the helper reports this host's readiness for the separate identity (never "ready" without it).
  const progress = readS15ComputerProgress(path);
  expect(progress.state).toBe("none"); expect(progress.state === "none" && progress.host).not.toBe("ready");
}, 30_000);

/** The owner setup link's lifetime in `src/ops/owner-setup.ts`. */
const ownerLinkLifetimeMs = 15 * 60 * 1000;
function ownerLinkFixture(f: ReturnType<typeof fixture>) {
  const clock = { now: 0 }, delivered: { at: number; valid: boolean }[] = [];
  let issuedAt = -1;
  const ownerLink = async () => {
    issuedAt = clock.now;
    return { deliver() { delivered.push({ at: clock.now, valid: clock.now < issuedAt + ownerLinkLifetimeMs }); f.lines.push("Open http://127.0.0.1:3002/owner/setup?token=<fixture> to finish setup"); }, close() {} };
  };
  return { clock, delivered, options: { ownerLink, sleep: async (ms: number) => { clock.now += ms; } } };
}
const slowComputer = (minutes: number): S15ComputerProgress[] => Array.from({ length: minutes * 30 }, (_, i) => i < minutes * 20
  ? { state: "running" as const, step: "download", history: ["host", "download"] } : { state: "running" as const, step: "boot", history: ["host", "download", "checksum", "disk", "boot"] });

test("the first-owner link is shown right after health, so a slow working computer never delivers an expired link", async () => {
  const f = fixture(), link = ownerLinkFixture(f);
  // 30 minutes of image download and first boot, polled every 2 s, then ready.
  const result = await runS15Installer({ ...f.options, ...link.options, simulation: { release: "release-a", computer: [...slowComputer(30), { state: "enrolled" }] } });
  expect(result.computer).toEqual({ state: "enrolled" });
  expect(link.clock.now).toBeGreaterThanOrEqual(30 * 60_000);
  expect(link.delivered).toEqual([{ at: 0, valid: true }]);
  const shown = f.lines.findIndex(line => line.startsWith("Open ")), progress = f.lines.findIndex(line => line.startsWith("Working computer: "));
  expect(shown).toBeGreaterThan(-1); expect(shown).toBeLessThan(progress);
  expect(result.events.indexOf("owner-link")).toBe(result.events.indexOf("health") + 1);
  // A working computer that fails after a long wait still leaves the owner with the link delivered in time.
  const g = fixture(), late = ownerLinkFixture(g);
  await expect(runS15Installer({ ...g.options, ...late.options, simulation: { release: "release-a", computer: [...slowComputer(20), { state: "failed", step: "boot", code: "vm_prerequisite_missing" }] } })).rejects.toThrow("Failed at working-computer.");
  expect(late.delivered).toEqual([{ at: 0, valid: true }]);
});

test("a host without a kvm group installs the controller alone, reports the owner-supplied VM fallback and adds the VM later", async () => {
  const f = fixture(), result = await install(f, { release: "release-a", kvmGroup: false });
  expect(result.events).toEqual(["preflight", "disk-reserve", "identity", "directories", "keyring", "vm-identity", "artifact", "configuration", "owner-terminal", "state-initialize", "owner-link-prepare", "service-install", "service-start", "health", "owner-link", "working-computer"]);
  expect(result.computer).toEqual({ state: "none", host: "vm_kvm_unavailable" });
  expect(f.lines.some(line => line.includes("no kvm group") && line.includes("Enroll your own VM in Resources → Computer"))).toBe(true);
  const config = JSON.parse(readFileSync(f.at(s15Installation.config), "utf8"));
  expect(config.vm).toMatchObject({ id: "working", limaInstance: null, local: false }); expect(config.vm.vmm).toBeUndefined();
  expect(() => parseS15RuntimeConfig(config)).not.toThrow();
  // No QEMU identity, launcher, sudoers rule, proxy socket or shared VM tree exists; the controller runs alone.
  for (const path of [s15Installation.sudoers, s15Installation.launcher, s15Installation.proxySocketUnit, "var/lib/jit-s15-vm", "var/lib/jit-s15-vmm"]) expect({ path, exists: existsSync(f.at(path)) }).toEqual({ path, exists: false });
  const unit = readFileSync(f.at(s15Installation.unit), "utf8");
  expect(unit).toBe(renderS15Unit({ uid: 1001, vmmUid: null, memoryMaxBytes: Math.floor(facts.ramMb / 3) * 1024 ** 2 }));
  expect(unit).toContain("NoNewPrivileges=true\n"); expect(unit).toContain("ReadWritePaths=/var/lib/jit-s15\n");
  for (const absent of ["jit-s15-vm", "1002", "Sockets=", "Requires="]) expect(unit).not.toContain(absent);
  expect(readlinkSync(f.at("opt/jit-s15/current"))).toBe(f.at("opt/jit-s15/releases/release-a")); expect(existsSync(stateMarker(f))).toBe(true);
  // A re-run without kvm is idempotent; once QEMU/KVM is installed, a re-run adds the Jit-managed VM in place.
  const bytes = readFileSync(f.at(s15Installation.config));
  await install(f, { release: "release-a", kvmGroup: false }); expect(readFileSync(f.at(s15Installation.config))).toEqual(bytes);
  await install(f, { release: "release-a" });
  const upgraded = JSON.parse(readFileSync(f.at(s15Installation.config), "utf8"));
  expect(upgraded.installationId).toBe(config.installationId);
  expect(upgraded.vm).toMatchObject({ local: true, vmm: { user: "jit-s15-vmm", directory: "/var/lib/jit-s15-vm" } });
  for (const path of [s15Installation.sudoers, s15Installation.launcher, s15Installation.proxySocketUnit]) expect(existsSync(f.at(path))).toBe(true);
  expect(readFileSync(f.at(s15Installation.unit), "utf8")).not.toContain("NoNewPrivileges");
  // Local VM support is never removed by a later host change.
  await install(f, { release: "release-a", kvmGroup: false });
  expect(JSON.parse(readFileSync(f.at(s15Installation.config), "utf8")).vm.local).toBe(true);
});

test.each([
  ["the VM stop command fails", { exitCode: 1, listed: "", processes: [] }],
  ["a working-VM unit is still active", { exitCode: 0, listed: "jit-work-0123456789ab.service loaded active running jit-work-0123456789ab\n", processes: [] }],
  ["a QEMU process of the identity remains", { exitCode: 0, listed: "jit-work-0123456789ab.service loaded inactive dead jit-work-0123456789ab\n", processes: [4321] }],
])("uninstall reports failure with the exact next step and removes nothing when %s", async (_name, vmStop) => {
  const f = fixture(); await install(f, { release: "release-a" });
  const before = tree(f, s15Trees);
  await expect(runS15Installer({ ...f.options, uninstall: true, simulation: { vmStop } }))
    .rejects.toThrow(/^Failed at uninstall\. Next: jit-s15\.service is stopped and disabled, but a working VM of jit-s15-vmm is still running \(.+\)\. Stop it with: sudo runuser -u jit-s15-vmm -- env XDG_RUNTIME_DIR=\/run\/user\/1002 systemctl --user stop 'jit-work-\*\.service'; .*re-run install\.sh --s15 --uninstall\. No unit file was removed$/);
  expect(tree(f, s15Trees)).toEqual(before);
  expect(f.lines.some(line => line.startsWith("Uninstalled"))).toBe(false);
  // Once the VM is proven stopped, the same uninstall completes.
  await runS15Installer({ ...f.options, uninstall: true, simulation: { vmStop: { exitCode: 0, listed: "jit-work-0123456789ab.service loaded inactive dead jit-work-0123456789ab\n", processes: [] } } });
  expect(existsSync(f.at(s15Installation.unit))).toBe(false);
});

test("the VM stop proof runs as the QEMU identity and reads the kernel's process table", async () => {
  const calls: string[][] = [];
  const call = (manager: string, listed: string, exitCode = 0) => async (argv: string[]) => { calls.push(argv); return { exitCode: argv.includes("stop") ? exitCode : 0, timedOut: false, stdout: argv[1] === "is-active" ? `${manager}\n` : argv.includes("list-units") ? listed : "" }; };
  expect(await stopS15WorkingVms({ vmmUid: 1002, call: call("active", ""), qemuProcesses: () => [] })).toEqual({ stopped: true, remaining: [] });
  const asVmm = ["runuser", "-u", "jit-s15-vmm", "--", "env", "XDG_RUNTIME_DIR=/run/user/1002"];
  expect(calls).toEqual([["systemctl", "is-active", "user@1002.service"], [...asVmm, "systemctl", "--user", "stop", "jit-work-*.service"],
    [...asVmm, "systemctl", "--user", "list-units", "--type=service", "--all", "--plain", "--no-legend", "jit-work-*.service"]]);
  // A user manager that is not running has no units, but a surviving QEMU process still fails the proof.
  calls.length = 0;
  expect(await stopS15WorkingVms({ vmmUid: 1002, call: call("inactive", ""), qemuProcesses: () => [77] })).toEqual({ stopped: false, remaining: ["QEMU pid 77"] });
  expect(calls).toEqual([["systemctl", "is-active", "user@1002.service"]]);
  expect(await stopS15WorkingVms({ vmmUid: 1002, call: call("active", "jit-work-0123456789ab.service loaded deactivating stop-sigterm x\n"), qemuProcesses: () => [] })).toEqual({ stopped: false, remaining: ["jit-work-0123456789ab.service"] });
  expect((await stopS15WorkingVms({ vmmUid: 1002, call: call("active", "", 1), qemuProcesses: () => [] })).stopped).toBe(false);
  // The default reader matches only QEMU binaries whose real uid is the QEMU identity's.
  const proc = realpathSync(mkdtempSync(join(tmpdir(), "jit-s15-proc-"))); roots.push(proc);
  const entry = (pid: number, uid: number, argv0: string) => { mkdirSync(join(proc, String(pid))); writeFileSync(join(proc, String(pid), "status"), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`); writeFileSync(join(proc, String(pid), "cmdline"), `${argv0}\0-name\0jit-work-0123456789ab\0`); };
  entry(100, 1002, "/usr/bin/qemu-system-x86_64"); entry(101, 1002, "/bin/bash"); entry(102, 1003, "/usr/bin/qemu-system-aarch64"); mkdirSync(join(proc, "self"));
  expect(s15QemuProcesses(1002, proc)).toEqual([100]);
});

test("the installer's S15 owner-link command is the spelling the CLI accepts (private fd 3 pipe)", () => {
  const argv = s15OwnerLinkArguments(s15Installation.config);
  expect(selectRuntime(argv, {})).toEqual({ runtime: "s15", args: ["owner-link", "--s15", "--config", s15Installation.config, "--output-fd", "3"] });
  // Without the pipe flag the CLI refuses, which a real install reports as owner-link-prepare.
  expect(() => selectRuntime(argv.slice(0, 4), {})).toThrow("explicit_s15_config_required");
});

test("install.sh never gives a package manager the operator terminal as stdin", () => {
  // `timeout` puts apt/dnf in their own process group; apt reconfiguring the terminal from there is stopped by SIGTTOU.
  const calls = readFileSync(join(source, "install.sh"), "utf8").split("\n").filter(line => /\b(apt-get|apt-cache|dnf) (update|install|show)\b/.test(line) && !/^\s*#/.test(line));
  expect(calls.length).toBeGreaterThanOrEqual(7);
  for (const line of calls) expect(line).toMatch(/(apt-get|apt-cache|dnf) [^<]*<\/dev\/null /);
});

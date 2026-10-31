import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { buildPackage, validateArtifact } from "../bun-build";
import { assertRootPath, assertRootTree, freezeInstallerArtifact, giveInstallerStaging } from "./trusted-paths";
import { parseServiceConfig, renderJournaldConfig, renderServiceUnit, serviceEnvironment, serviceUnit, serviceOrigin, serviceLoginPath, type ServiceConfig } from "../service-config";
import { spawnRunner, SystemdSupervisor, type CommandRunner } from "../../../src/ops/supervisor";
import { disableService, installService } from "../../../src/ops/service-package";
import { TransactionStore } from "../../../src/store";
import { openReadOnlyStore } from "../../../src/ops/readonly-store";
import { issueOwnerSetupLink } from "../../../src/ops/owner-setup";
import { builtInModels } from "../../../src/team/route-options";
import { en } from "../../../src/i18n/en";
import { th } from "../../../src/i18n/th";
import { s14SchemaVersion, inspectS14Store, S14Store } from "../../../src/s14/store";
import { acquireS14RuntimeLock } from "../../../src/s14/runtime-lock";
import { deliverS14OwnerLink } from "./owner-link";
import { provisionS14Images } from "./s14-images";
import pins from "./pinned-images.json";

const MiB = 1024 ** 2, GiB = 1024 ** 3;

/**
 * Restarts the service identity's Podman pause process when it is stuck in a one-ID namespace. That happens when it
 * started while the identity could not read its subordinate ids, and images owned by other ids then fail to unpack.
 * A failed repair is reported with its next step; container features stay optional and never block installation.
 */
export async function repairPodmanNamespace(
  call: (argv: string[]) => Promise<{ exitCode: number; stdout: string; timedOut?: boolean }>,
  asUser: (args: string[]) => string[], out?: (line: string) => void,
): Promise<"healthy" | "repaired" | "failed" | "unknown"> {
  const map = await call(asUser(["podman", "unshare", "cat", "/proc/self/uid_map"]));
  if (map.exitCode !== 0 || map.timedOut) return "unknown";
  if (map.stdout.trim().split("\n").filter(Boolean).length !== 1) return "healthy";
  const migrated = await call(asUser(["podman", "system", "migrate"]));
  if (migrated.exitCode === 0 && !migrated.timedOut) return "repaired";
  out?.("Podman namespace repair failed; container features stay unavailable. As jit: podman system migrate; then restart jit.service.");
  return "failed";
}

function homeDirectories(home: string, s14 = false): string[] {
  return ["state", "state.connections", "backups", "work", "ledger", "state/attachments", ".config", ".config/systemd", ".config/systemd/user", ".local", ".local/share", ".local/share/keyrings", ".schway", ...(s14 ? ["vault", "computers"] : [])].map(path => join(home, path));
}

function keyringUnit(home: string): string {
  return `[Unit]\nDescription=Jit service Secret Service (boot unlock)\nRequires=dbus.socket\nAfter=dbus.socket\n[Service]\nType=dbus\nBusName=org.freedesktop.secrets\nExecStart=/usr/bin/gnome-keyring-daemon --foreground --components=secrets --unlock\nStandardInput=file:${join(home, "keyring-unlock")}\nStandardOutput=null\nStandardError=null\nRestart=on-failure\nUMask=0077\n[Install]\nWantedBy=default.target\n`;
}

/** Runs only as the service identity: all writes below its mutable home, including boot unlock and ledger seed. */
export function prepareInstallerHome(home: string, s14 = false): void {
  if (process.getuid?.() === 0) throw new Error("service-identity-required");
  for (const path of homeDirectories(home, s14)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new Error("unsafe_home_path");
    chmodSync(path, 0o700);
  }
  const unlock = join(home, "keyring-unlock");
  try { writeFileSync(unlock, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stats = lstatSync(unlock);
  if (!stats.isFile() || stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o600) throw new Error("unsafe_unlock_file");
  const unit = join(home, ".config/systemd/user/gnome-keyring-daemon.service");
  const temp = `${unit}.${randomBytes(8).toString("hex")}`;
  try { writeFileSync(temp, keyringUnit(home), { flag: "wx", mode: 0o644 }); renameSync(temp, unit); }
  finally { rmSync(temp, { force: true }); }
  if (s14) return;
  try { writeFileSync(join(home, "ledger/checkpoint.json"), JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** Reads mutable installation state only under the service uid; the privileged bootstrap receives a schema number. */
export function installerSchemaVersion(home: string): number | null {
  if (process.getuid?.() === 0) throw new Error("service-identity-required");
  const store = openReadOnlyStore(join(home, "state/app.sqlite"));
  return store?.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version) ?? null;
}

/** Probes HTTP on the local/private listener with the configured origin's Host, independently of ingress reachability. */
export async function installerHealth(config: ServiceConfig, request: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  const bind = config.network.bindHost.includes(":") ? `[${config.network.bindHost}]` : config.network.bindHost;
  const origin = config.network.origin ?? `http://${bind}:${config.network.port}`;
  return (await request(`http://${bind}:${config.network.port}${serviceLoginPath(config)}`, {
    headers: { host: new URL(origin).host }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
  })).status === 200;
}

/** Hardware detection supplied by the POSIX bootstrap; dry runs read this shape only from their fake root. */
export interface HostFacts { family: string; arch: string; ramMb: number; cpus: number; diskBytes: number; freeBytes: number }
/** Hardware-derived initial ceilings. They are recommendations only when an existing config is preserved. */
export interface InstallerDefaults { memoryMaxBytes: number; logBytes: number; diskReserveBytes: number; boxMemoryMb: number; boxCpus: number; maxBoxes: number }
/** Digest-pinned optional release image. WEB02/ATT02 add entries here only after publishing real images. */
export interface PinnedImage { feature: "execution-base" | "execution-browser" | "search" | "sanitizer"; ref: string }

/** Scales from the host, with a 2 GiB reserve on ordinary disks; small/large disks use 10%/2% within safe bounds. */
export function installerDefaults(facts: HostFacts): InstallerDefaults {
  if (!["x64", "arm64"].includes(facts.arch) || !/^[a-z][a-z0-9-]*$/.test(facts.family) ||
      ![facts.ramMb, facts.cpus, facts.diskBytes, facts.freeBytes].every(n => Number.isSafeInteger(n) && n > 0) || facts.freeBytes > facts.diskBytes) throw new Error("unsupported-host-facts");
  return {
    memoryMaxBytes: Math.min(8192, Math.max(256, Math.floor(facts.ramMb / 3))) * MiB,
    logBytes: Math.min(256 * MiB, Math.max(16 * MiB, Math.floor(facts.diskBytes / 1000))),
    diskReserveBytes: Math.floor(facts.diskBytes < 20 * GiB ? Math.max(256 * MiB, facts.diskBytes / 10) : Math.min(16 * GiB, Math.max(2 * GiB, facts.diskBytes / 50))),
    boxMemoryMb: Math.min(8192, Math.max(256, Math.floor(facts.ramMb / 4))),
    boxCpus: Math.min(4, Math.max(0.5, facts.cpus / 2)),
    maxBoxes: Math.min(8, Math.max(1, Math.floor(facts.ramMb / 4096))),
  };
}

/** Rejects unpinned/duplicate entries before any optional pull; an empty list is a valid release. */
export function pinnedImages(raw: unknown = pins): PinnedImage[] {
  if (!Array.isArray(raw)) throw new Error("invalid-image-list");
  const features = new Set<string>();
  return raw.map(item => {
    if (!item || Object.keys(item).sort().join(",") !== "feature,ref" || !["execution-base", "execution-browser", "search", "sanitizer"].includes(item.feature) ||
        features.has(item.feature) || typeof item.ref !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f0-9]{64}$/.test(item.ref)) throw new Error("invalid-image-list");
    features.add(item.feature); return item as PinnedImage;
  });
}

/**
 * Allocates 65536 non-overlapping IDs across both files only when reachable in the caller's namespace.
 * Map coordinates use the first (inside) column. Existing entries are never replaced; unavailable
 * results preserve both files and require an operator to expand the parent UID and GID mappings.
 */
export function subordinateIds(uidText: string, gidText: string, user: string,
  maps = { uid: "0 0 4294967295", gid: "0 0 4294967295" },
): { subuid: string; subgid: string; unavailable?: string } {
  const parse = (text: string) => text.split("\n").filter(line => line && !line.startsWith("#")).map(line => {
    const [name, start, count, extra] = line.split(":");
    if (!name || !/^\d+$/.test(start ?? "") || !/^\d+$/.test(count ?? "") || extra !== undefined || Number(count) < 1 || Number(start) + Number(count) > 4294967295) throw new Error("invalid-subordinate-ids");
    return { name, start: Number(start), count: Number(count) };
  });
  const uids = parse(uidText), gids = parse(gidText);
  const first = Math.max(100000, ...[...uids, ...gids].map(r => r.start + r.count));
  if (first + 65536 > 4294967295) throw new Error("subordinate-ids-exhausted");
  const reachable = (text: string, start: number, count: number): boolean => {
    const spans = text.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    if (spans.some(row => row.length !== 3 || row.some(n => !Number.isSafeInteger(n) || n < 0) ||
        row[2]! < 1 || row[0]! + row[2]! > 4294967295 || row[1]! + row[2]! > 4294967295)) return false;
    let end = start;
    for (const [inside, , size] of spans.sort((a, b) => a[0]! - b[0]!)) {
      if (inside! > end) break;
      if (inside! + size! > end) end = inside! + size!;
      if (end >= start + count) return true;
    }
    return false;
  };
  const required = (rows: typeof uids) => {
    const existing = rows.filter(r => r.name === user);
    return existing.some(r => r.count >= 65536) ? existing : [...existing, { name: user, start: first, count: 65536 }];
  };
  if (required(uids).some(r => !reachable(maps.uid, r.start, r.count)) ||
      required(gids).some(r => !reachable(maps.gid, r.start, r.count))) {
    return { subuid: uidText, subgid: gidText,
      unavailable: `Subordinate IDs are outside or cannot be verified against /proc/self/uid_map or /proc/self/gid_map. On the parent host, expand the container's UID and GID mappings to cover jit entries in /etc/subuid and /etc/subgid with these required ranges (start:count): UID ${required(uids).map(r => `${r.start}:${r.count}`).join(", ")}; GID ${required(gids).map(r => `${r.start}:${r.count}`).join(", ")}. Restart the container, then re-run the installer. No ranges were changed.` };
  }
  const add = (text: string, rows: ReturnType<typeof parse>) => rows.some(r => r.name === user && r.count >= 65536) ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${user}:${first}:65536\n`;
  return { subuid: add(uidText, uids), subgid: add(gidText, gids) };
}

/** All installer file writes are confined to root; fake roots reject symlink parents and never call host tools. */
export interface InstallerOptions {
  root: string; s14?: boolean; facts: HostFacts; source: string; bunPath: string; uninstall?: boolean; dryRun?: boolean;
  run?: CommandRunner; out?: (line: string) => void;
  /** Fake-root scenarios only; production ignores all simulated failures/capabilities. */
  simulation?: { failStep?: string; podman?: boolean; health?: boolean; images?: unknown };
}
/** Safe, actionable step failure; never includes raw command output, paths carrying credentials or exception text. */
export class InstallerFailure extends Error {
  constructor(readonly step: string, readonly nextAction: string) { super(`Failed at ${step}. Next: ${nextAction}`); }
}

/**
 * Applies a single already-approved installer plan. Root administrative commands use only protected code;
 * dependency/state/keyring helpers run as the dedicated identity. Dry runs simulate every external command.
 * Re-runs preserve config/data, repair units and replace compatible artifacts; schema changes retain OPS06 gates.
 */
export async function runInstaller(options: InstallerOptions): Promise<{ events: string[]; config: ServiceConfig; defaults: InstallerDefaults }> {
  const s14 = options.s14 === true, name = s14 ? "jit-s14" : "jit";
  const dry = options.dryRun === true, root = dry ? realpathSync(resolve(options.root)) : resolve(options.root), events: string[] = [], defaults = installerDefaults(options.facts);
  if (dry ? root === "/" || !isAbsolute(options.root) : root !== "/" || process.platform !== "linux" || process.getuid?.() !== 0) throw new InstallerFailure("host", "use Linux root, or --dry-run with a disposable absolute --root");
  const at = (path: string) => root === "/" ? path : join(root, path);
  const safe = (path: string) => {
    if (root !== "/" && !path.startsWith(root + "/")) throw new InstallerFailure("paths", "use a path inside the fake root");
    for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) throw new InstallerFailure("paths", "replace the unexpected symlink before re-running"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dry && parent === root) break;
    }
  };
  const dir = (path: string, mode = 0o700) => { safe(path); mkdirSync(path, { recursive: true, mode }); chmodSync(path, mode); };
  const write = (path: string, text: string, mode = 0o600) => {
    safe(path); safe(dirname(path)); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(8).toString("hex")}`;
    // install.sh runs under umask 077, which would narrow `mode`; /etc/subuid and /etc/subgid must stay world-readable.
    try { writeFileSync(temp, text, { flag: "wx", mode }); chmodSync(temp, mode); renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
  };
  const runner = options.run ?? spawnRunner;
  const run: CommandRunner = (argv, settings) => runner(argv, {
    ...settings, cwd: settings.cwd ?? "/", env: settings.env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  const call = async (argv: string[], timeoutMs = 120_000) => {
    if (dry) return { exitCode: (options.simulation?.failStep === "optional-images" && argv.includes("pull")) || (options.simulation?.failStep === "optional-podman-socket" && argv.includes("podman.socket")) ? 1 : 0, stdout: "", timedOut: false };
    try { return await run(argv, { timeoutMs }); }
    catch { return { exitCode: 127, stdout: "", timedOut: false }; }
  };
  let currentStep = "configuration", next = "inspect /etc/jit/service-config.json and re-run";
  const step = (name: string, action: string) => {
    currentStep = name; next = action; events.push(name); options.out?.(`Step: ${name}`);
    if (dry && options.simulation?.failStep === name && !name.startsWith("optional-")) throw new InstallerFailure(name, action);
  };
  const must = async (argv: string[], timeoutMs?: number) => {
    const result = await call(argv, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut) throw new InstallerFailure(currentStep, next);
    return result.stdout;
  };
  const configDir = at(`/etc/${name}`), prefix = at(`/opt/${name}`), configPath = join(configDir, "service-config.json"), home = at(`/var/lib/${name}`);
  const unitPath = at(`/etc/systemd/system/${name}.service`), journalPath = at(`/etc/systemd/journald@${name}.conf`);
  safe(configPath);
  if (!dry) {
    try {
      for (const path of [configPath, options.bunPath, join(prefix, "releases"), unitPath, journalPath, at("/etc/subuid"), at("/etc/subgid"), at("/var/lib/cni")]) assertRootPath(path);
      assertRootTree(resolve(options.source));
    } catch { throw new InstallerFailure("trusted-paths", "use root-owned executable/config/system parents without symlinks or group/other write, then re-run from a trusted release"); }
  }
  const desired = parseServiceConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {
    ...(s14 ? { runtime: "s14", s14: { vaultDirectory: join(home, "vault"), computerRoot: join(home, "computers"), gitScratch: at("/run/jit-s14-git") } } : {}),
    serviceUser: name, executablePath: join(prefix, "current"), workingDirectory: join(home, "work"), stateDirectory: join(home, "state"),
    ledgerPath: join(home, "ledger/checkpoint.json"), backupDirectory: join(home, "backups"), secretRefs: [],
    routes: [{ route: "codex", model: builtInModels.codex, configured: true }, { route: "grok", model: builtInModels.grok, configured: true }],
    network: { bindHost: "127.0.0.1", port: s14 ? 3001 : 3000, vpnInterface: null }, resources: { memoryMaxBytes: defaults.memoryMaxBytes,
      logBytes: defaults.logBytes, retentionDays: 14, maxRestarts: 5, restartWindowSeconds: 300 }, runPort: "schway", channels: { telegram: "disabled" },
  });
  if (desired.serviceUser !== name || (desired.runtime === "s14") !== s14 || desired.stateDirectory !== join(home, "state") || desired.executablePath !== join(prefix, "current") ||
      desired.workingDirectory !== join(home, "work") || desired.backupDirectory !== join(home, "backups") || desired.ledgerPath !== join(home, "ledger/checkpoint.json")) throw new InstallerFailure("configuration", "operate this custom installation with ops.service_package/v1 instead");
  if (s14 && (desired.s14!.vaultDirectory !== join(home, "vault") || desired.s14!.computerRoot !== join(home, "computers") || desired.s14!.gitScratch !== at("/run/jit-s14-git"))) throw new InstallerFailure("configuration", "use the separate managed S14 paths");
  let uid = 1001, gid = 1001;
  let commandArtifact = resolve(options.source);
  const asUser = (args: string[]) => ["runuser", "-u", desired.serviceUser, "--", "env", `HOME=${home}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...args];
  const service = async (args: string[]) => {
    if (dry) {
      if (args[0] === "install") {
        write(unitPath, await renderServiceUnit(desired, { bunPath: join(prefix, "bin/bun"), configPath, uid, gid, home }), 0o644);
        write(journalPath, await renderJournaldConfig(desired), 0o644);
      } else if (args[0] === "uninstall") {
        safe(unitPath); safe(journalPath); rmSync(unitPath, { force: true }); rmSync(journalPath, { force: true });
        const userUnit = join(home, ".config/systemd/user/gnome-keyring-daemon.service"); safe(userUnit); rmSync(userUnit, { force: true });
      }
      return;
    }
    // Privileged lifecycle uses this trusted bootstrap's dependency-free public API. Never import code or
    // dependencies produced by the service identity, even if it forges a new dependency seal before the copy.
    assertRootTree(resolve(options.source)); assertRootPath(options.bunPath); assertRootPath(configPath);
    const host = { run, bunPath: options.bunPath, unitDir: at("/etc/systemd/system"), journaldDir: at("/etc/systemd"), configDir, skipLedgerSeed: true };
    const supervisor = new SystemdSupervisor(run, { unit: serviceUnit(desired) });
    const command = args[0];
    const accepted = command === "install" ? (await installService({ service: desired, artifactDir: args[args.indexOf("--artifact") + 1]!, host })).ok
      : command === "stop" ? await supervisor.stop() : command === "start" ? await supervisor.start()
      : command === "uninstall" ? (await disableService({ service: desired, host, remove: true })).disabled : false;
    if (!accepted) throw new InstallerFailure(currentStep, next);
  };
  let ownedStaging: string | null = null;
  let frozenContainer: string | null = null;
  try {
    if (options.uninstall) {
      step("uninstall", "stop the installed unit with the service package, then re-run --uninstall");
      if (existsSync(unitPath)) await service(["uninstall", "--config", configPath]);
      if (!dry) {
        const passwd = (await must(["getent", "passwd", name])).trim().split(":"); uid = Number(passwd[2]);
        if (!Number.isSafeInteger(uid) || uid < 1) throw new InstallerFailure(currentStep, next);
        const userUnit = join(home, ".config/systemd/user/gnome-keyring-daemon.service");
        if (existsSync(userUnit)) await must(asUser(["systemctl", "--user", "disable", "--now", "gnome-keyring-daemon.service"]));
        await must(asUser(["rm", "-f", "--", userUnit]));
        await must(asUser(["systemctl", "--user", "daemon-reload"]));
      }
      options.out?.("Uninstalled service units. Data, identity, Bun, releases, config, keyring and unlock file are retained.");
      return { events, config: desired, defaults };
    }
    step("disk-reserve", "free disk space above the displayed reserve plus 512 MiB staging space, then re-run");
    const disk = dry ? null : statfsSync(existsSync(desired.stateDirectory) ? desired.stateDirectory : "/var/lib");
    const free = disk ? disk.bavail * disk.bsize : options.facts.freeBytes;
    if (free < defaults.diskReserveBytes + 512 * MiB) throw new InstallerFailure(currentStep, next);
    step("identity", `provide a dedicated non-root ${name} identity with home ${home} and a non-login shell, then re-run`);
    if (!dry) {
      let passwd = await call(["getent", "passwd", name]);
      if (passwd.exitCode !== 0) {
        await must(["useradd", "--system", "--create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", "--user-group", name]);
        passwd = await call(["getent", "passwd", name]);
      }
      const fields = passwd.stdout.trim().split(":"); uid = Number(fields[2]); gid = Number(fields[3]);
      if (passwd.exitCode !== 0 || fields[0] !== name || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1 || fields[5] !== home || !/\/(nologin|false)$/.test(fields[6] ?? "")) throw new InstallerFailure(currentStep, next);
    }
    dir(home);
    step("directories", "remove unexpected symlinks or repair directory ownership, then re-run");
    if (dry) for (const path of homeDirectories(home, s14)) dir(path);
    if (!dry) chownSync(home, uid, gid);
    dir(prefix, 0o755); dir(join(prefix, "bin"), 0o755); dir(join(prefix, "releases"), 0o755); dir(at("/var/lib/cni"), 0o755);
    let available = dry ? options.simulation?.podman !== false : (await call(["podman", "--version"])).exitCode === 0;
    let subordinateUnavailable = false;
    step("subordinate-ids", "repair /etc/subuid and /etc/subgid ranges, then re-run");
    if (available) {
      const subuid = at("/etc/subuid"), subgid = at("/etc/subgid"); safe(subuid); safe(subgid);
      const readMap = (name: string) => {
        const path = at(`/proc/self/${name}`);
        // Linux /proc/self is a kernel-owned symlink, not an installer output path.
        if (dry) safe(path);
        try { return readFileSync(path, "utf8"); } catch { return ""; }
      };
      const ranges = subordinateIds(existsSync(subuid) ? readFileSync(subuid, "utf8") : "", existsSync(subgid) ? readFileSync(subgid, "utf8") : "", name, { uid: readMap("uid_map"), gid: readMap("gid_map") });
      if (ranges.unavailable) {
        available = false;
        subordinateUnavailable = true;
        options.out?.(`Chat-only: container features unavailable. ${ranges.unavailable}`);
      } else {
        write(subuid, ranges.subuid, 0o644); write(subgid, ranges.subgid, 0o644);
      }
    }
    step("keyring", `repair the ${name} user manager/Secret Service; preserve its existing unlock file and keyring, then re-run`);
    if (!dry) await must(asUser([options.bunPath, join(commandArtifact, "ops/package/installer/main.ts"), "prepare-home", "--home", home, ...(s14 ? ["--s14", "true"] : [])]));
    const unlock = join(home, "keyring-unlock"); if (dry) safe(unlock);
    if (dry && !existsSync(unlock)) write(unlock, randomBytes(32).toString("hex"));
    if (dry && (!lstatSync(unlock).isFile() || (lstatSync(unlock).mode & 0o777) !== 0o600)) throw new InstallerFailure(currentStep, next);
    const userUnit = join(home, ".config/systemd/user/gnome-keyring-daemon.service");
    if (dry) write(userUnit, keyringUnit(home), 0o644);
    await must(["loginctl", "enable-linger", name]);
    await must(["systemctl", "start", `user@${uid}.service`]);
    await must(asUser(["systemctl", "--user", "daemon-reload"]));
    await must(asUser(["systemctl", "--user", "enable", "--now", "gnome-keyring-daemon.service"]));
    step("optional-podman-socket", `enable the ${name} identity's user podman.socket and restart ${name}.service (docs/runbooks/execution-box.md)`);
    if (available) await repairPodmanNamespace(call, asUser, options.out);
    if (!subordinateUnavailable && (!available || (await call(asUser(["systemctl", "--user", "enable", "--now", "podman.socket"]))).exitCode !== 0)) {
      const key = available ? "podman.reason_socket" : "podman.reason_podman";
      options.out?.(`Chat-only: ${en[key]} / ${th[key]}${available ? ` As ${name}: systemctl --user enable --now podman.socket; then restart ${name}.service.` : ""}`);
    }
    if (!dry) {
      const locked = await must(asUser(["busctl", "--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/collection/login", "org.freedesktop.Secret.Collection", "Locked"]));
      if (locked.trim() !== "b false") throw new InstallerFailure(currentStep, next);
    }
    step("artifact", "verify the release archive/Bun pins and registry access, then re-run");
    let artifact = resolve(options.source);
    if (!dry) {
      const staging = join(prefix, `staging-${randomBytes(8).toString("hex")}`); ownedStaging = staging;
      if (existsSync(join(artifact, "manifest.json"))) cpSync(artifact, staging, { recursive: true });
      else buildPackage({ srcDir: artifact, outDir: staging, engineContract: "jit.schway.bridge/v1", engineRevision: null });
      artifact = staging;
      // No package scripts, root credentials or host environment reach dependency installation.
      const expected = validateArtifact(artifact);
      if (!expected.ok || !expected.manifest) throw new InstallerFailure(currentStep, next);
      const dependenciesReady = validateArtifact(artifact, { runtime: true }).ok;
      giveInstallerStaging(artifact, uid, gid);
      if (!dependenciesReady) await must(asUser([options.bunPath, join(commandArtifact, "ops/package/bun-build.ts"), "install-deps", artifact]), 600_000);
      const frozen = freezeInstallerArtifact(artifact, join(prefix, "releases"), expected.manifest);
      frozenContainer = frozen.container; artifact = frozen.artifact;
      const checked = validateArtifact(artifact, { runtime: true });
      if (!checked.ok || !checked.manifest || s14 && !checked.manifest.s14SchemaVersion) throw new InstallerFailure(currentStep, next);
      commandArtifact = artifact;
      const schemaText = await must(asUser([options.bunPath, join(commandArtifact, "ops/package/installer/main.ts"), "schema-version", "--home", home, ...(s14 ? ["--s14", "true"] : [])]));
      const schema = schemaText.trim() === "none" ? null : Number(schemaText.trim());
      if (schema !== null && (!Number.isSafeInteger(schema) || schema < 1)) throw new InstallerFailure(currentStep, next);
      if (schema !== null && schema !== (s14 ? checked.manifest.s14SchemaVersion : checked.manifest.schemaVersion)) throw new InstallerFailure("schema-upgrade", "complete the owner-authorized OPS06/OPS07 staged upgrade before re-running; no in-place migration is allowed");
      const remaining = statfsSync(desired.stateDirectory);
      if (remaining.bavail * remaining.bsize < defaults.diskReserveBytes) throw new InstallerFailure("disk-reserve", "free disk space above the displayed reserve and re-run");
    }
    step("configuration", "repair the trusted service config; existing config is preserved on re-run");
    dir(configDir, 0o750);
    if (!existsSync(configPath)) write(configPath, JSON.stringify(desired, null, 2), 0o640);
    if (!dry) chownSync(configDir, 0, gid);
    if (s14) {
      step("optional-s14-images", "restore rootless Podman image build access and re-run --s14; chat remains available");
      const images = dry ? options.simulation?.podman === false || options.simulation?.failStep === "optional-s14-images" ? undefined
        : { base: `localhost/jit-s14-base@sha256:${"a".repeat(64)}`, browser: `localhost/jit-s14-browser@sha256:${"b".repeat(64)}` }
        : available ? await provisionS14Images(artifact, uid, run, asUser, desired.s14!.images) : undefined;
      if (images) desired.s14!.images = images;
      else {
        delete desired.s14!.images;
        options.out?.("Feature-off: computer_image_digest_required; Bot images could not be built. Re-run --s14 after repairing rootless Podman/build access.");
      }
      write(configPath, JSON.stringify(desired, null, 2), 0o640);
      options.out?.("Feature-off: computer_local_podman_required; S14 cannot verify persistent disk bounds through the hardened service's remote API. Dedicated ext4 mounts/cgroup proof remain required; no local or host-shell fallback.");
    }
    let configuredImages: PinnedImage[] = [];
    try { configuredImages = pinnedImages(dry ? options.simulation?.images ?? pins : pins); }
    catch { options.out?.("Optional image list unavailable: skipping pre-pull."); }
    write(join(configDir, "installer-state.json"), JSON.stringify({ contract: "ops.installer/v1", hardware: options.facts, defaults,
      containers: available ? s14 ? "feature-off-computer_local_podman_required" : "runtime-present-images-require-configuration" : "unavailable", images: s14 ? desired.s14!.images ?? null : configuredImages }, null, 2));
    step("service-install", "inspect service plan and the bounded journald namespace, then re-run");
    if (existsSync(unitPath)) await service(["stop", "--config", configPath]);
    if (!dry) {
      const checked = validateArtifact(artifact, { runtime: true });
      if (!checked.ok || !checked.manifest) throw new InstallerFailure(currentStep, next);
      const target = join(join(prefix, "releases"), checked.manifest.artifactId);
      assertRootPath(target); if (existsSync(target)) assertRootTree(target);
    }
    await service(["install", "--config", configPath, "--artifact", artifact, "--bun", options.bunPath]);
    step("state-initialize", "repair the service-owned state directory and re-run; existing state is never migrated at boot");
    if (!dry && !s14) {
      await must(asUser([options.bunPath, join(realpathSync(desired.executablePath), "ops/package/installer/main.ts"), "initialize-state", "--config", configPath]));
    }
    step("service-start", `inspect journalctl --namespace=${name} -u ${name}.service, fix the named gate and re-run`);
    await service(["start", "--config", configPath]);
    step("health", "inspect service preflight/journald, fix the named gate and re-run");
    const origin = serviceOrigin(desired);
    if (dry && options.simulation?.health === false) throw new InstallerFailure(currentStep, next);
    if (!dry) {
      // systemd Type=simple can return before the listener exists. Retry locally within one wall-clock bound.
      const deadline = Date.now() + 20_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try { healthy = await installerHealth(desired, fetch, Math.max(1, deadline - Date.now())); } catch { /* Not listening yet. */ }
        if (healthy) break;
        await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      }
      if (!healthy) throw new InstallerFailure(currentStep, next);
    }
    // These two steps are optional by contract, including malformed/future image lists and missing Podman.
    step("optional-images", "add published digest-pinned images to the release image list");
    for (const image of s14 ? [] : configuredImages) {
      if (!available || (await call(asUser(["podman", "--remote", "--url", `unix:///run/user/${uid}/podman/podman.sock`, "pull", image.ref]), 120_000)).exitCode !== 0) options.out?.(`Optional image unavailable: ${image.feature}`);
    }
    if (!available) options.out?.(subordinateUnavailable
      ? "Container features unavailable: subordinate IDs are outside the parent mapping. Chat-only installation is ready."
      : "Container features unavailable: Podman is absent. Chat-only installation is ready.");
    else if (!configuredImages.length && !desired.execution) options.out?.("Container features unavailable: no published image pins in this release (WEB02/ATT02 follow-ups).");
    step("optional-box-doctor", "configure an execution image and re-run box-doctor when container features are needed");
    if (!dry && !s14) {
      const env = Object.fromEntries([...serviceEnvironment(desired), ["JIT_PODMAN_MODE", "remote"], ["JIT_SERVICE_USER", desired.serviceUser]]);
      const result = await call(asUser(["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), options.bunPath, join(desired.executablePath, "src/ops-cli.ts"), "box-doctor"]));
      if (result.exitCode !== 0) options.out?.("Optional box-doctor: container features unavailable; core setup is ready.");
    }
    step("owner-link", s14 ? "re-run --s14 from the operator terminal; verify service state and private fd 3 delivery; an existing owner is never reset" : "repair the service-owned state directory and re-run; an existing owner is never reset");
    let link: string | null = null;
    if (!dry && s14) {
      await deliverS14OwnerLink(asUser([options.bunPath, join(realpathSync(desired.executablePath), "src/main.ts"), "owner-link", "--s14", "--output-fd", "3"]),
        { ...Object.fromEntries(serviceEnvironment(desired)), PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, origin);
    }
    if (!dry && !s14) {
      const result = await must(asUser([options.bunPath, join(realpathSync(desired.executablePath), "ops/package/installer/main.ts"), "owner-link", "--config", configPath]));
      link = result.trim() || null;
      if (link && !new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/owner/setup\\?token=[a-f0-9]{64}$`).test(link)) throw new InstallerFailure(currentStep, next);
    }
    options.out?.(dry ? "Dry run complete. No host commands ran; no setup credential was created." : s14 ? "S14 service ready; owner access was delivered on the operator terminal." : `Open ${link ?? `${origin}/login`} to finish setup`);
    return { events, config: desired, defaults };
  } catch (error) {
    if (error instanceof InstallerFailure) throw error;
    throw new InstallerFailure(currentStep, next);
  } finally {
    if (ownedStaging) rmSync(ownedStaging, { recursive: true, force: true });
    if (frozenContainer) rmSync(frozenContainer, { recursive: true, force: true });
  }
}

/** Service-identity helper: initialize only a new database, optionally issue a link; never migrate existing state. */
export function installerOwnerLink(config: ServiceConfig, issue = true): string | null {
  if (process.getuid?.() === 0) throw new Error("service-identity-required");
  if (config.runtime === "s14") throw new Error("s14_private_owner_link_required");
  const store = new TransactionStore(join(config.stateDirectory, "app.sqlite"), { migrateExisting: false });
  try { return issue ? issueOwnerSetupLink(store, config.network.origin ?? `http://${config.network.bindHost === "::1" ? "[::1]" : config.network.bindHost}:${config.network.port}`) : null; }
  finally { store.close(); }
}

/** Checks an S14 store under its service identity, refusing foreign schemas and active/fenced writers before activation. */
export function installerS14Schema(home: string, exclusive = false): number | null {
  return inspectInstallerS14Database(join(home, "state/application.sqlite"), exclusive);
}

/** Inspects only the selected S14 database as the service identity, optionally excluding every active runtime. */
export function inspectInstallerS14Database(path: string, exclusive = false): number | null {
  if (process.getuid?.() === 0) throw new Error("service-identity-required");
  if (inspectS14Store(path) === "missing") return null;
  if (exclusive) {
    const release = acquireS14RuntimeLock(path);
    try { const store = new S14Store(path); store.close(); } finally { release(); }
  }
  return s14SchemaVersion;
}

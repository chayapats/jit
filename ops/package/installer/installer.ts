import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { buildPackage, installArtifactDependencies, validateArtifact } from "../bun-build";
import { parseServiceConfig, renderJournaldConfig, renderServiceUnit, serviceEnvironment, type ServiceConfig } from "../service-config";
import { spawnRunner, type CommandRunner } from "../../../src/ops/supervisor";
import { TransactionStore } from "../../../src/store";
import { openReadOnlyStore } from "../../../src/ops/readonly-store";
import { issueOwnerSetupLink } from "../../../src/ops/owner-setup";
import { builtInModels } from "../../../src/team/route-options";
import pins from "./pinned-images.json";

const MiB = 1024 ** 2, GiB = 1024 ** 3;

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

/** Allocates a non-overlapping subordinate-ID range across both files; existing entries are never replaced. */
export function subordinateIds(uidText: string, gidText: string, user: string): { subuid: string; subgid: string } {
  const parse = (text: string) => text.split("\n").filter(line => line && !line.startsWith("#")).map(line => {
    const [name, start, count, extra] = line.split(":");
    if (!name || !/^\d+$/.test(start ?? "") || !/^\d+$/.test(count ?? "") || extra !== undefined || Number(count) < 1 || Number(start) + Number(count) > 4294967295) throw new Error("invalid-subordinate-ids");
    return { name, start: Number(start), count: Number(count) };
  });
  const uids = parse(uidText), gids = parse(gidText);
  const first = Math.max(100000, ...[...uids, ...gids].map(r => r.start + r.count));
  if (first + 65536 > 4294967295) throw new Error("subordinate-ids-exhausted");
  const add = (text: string, rows: ReturnType<typeof parse>) => rows.some(r => r.name === user && r.count >= 65536) ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${user}:${first}:65536\n`;
  return { subuid: add(uidText, uids), subgid: add(gidText, gids) };
}

/** All installer file writes are confined to root; fake roots reject symlink parents and never call host tools. */
export interface InstallerOptions {
  root: string; facts: HostFacts; source: string; bunPath: string; uninstall?: boolean; dryRun?: boolean;
  run?: CommandRunner; out?: (line: string) => void;
  /** Fake-root scenarios only; production ignores all simulated failures/capabilities. */
  simulation?: { failStep?: string; podman?: boolean; health?: boolean; images?: unknown };
}
/** Safe, actionable step failure; never includes raw command output, paths carrying credentials or exception text. */
export class InstallerFailure extends Error {
  constructor(readonly step: string, readonly nextAction: string) { super(`Failed at ${step}. Next: ${nextAction}`); }
}

/**
 * Applies a single already-approved installer plan. Production requires Linux root but all Jit commands run as
 * the dedicated identity. Dry runs only write a disposable fake root and simulate every external command.
 * Re-runs preserve config/data, repair units and replace compatible artifacts; schema changes retain OPS06 gates.
 */
export async function runInstaller(options: InstallerOptions): Promise<{ events: string[]; config: ServiceConfig; defaults: InstallerDefaults }> {
  const dry = options.dryRun === true, root = dry ? realpathSync(resolve(options.root)) : resolve(options.root), events: string[] = [], defaults = installerDefaults(options.facts);
  if (dry ? root === "/" || !isAbsolute(options.root) : root !== "/" || process.platform !== "linux" || process.getuid?.() !== 0) throw new InstallerFailure("host", "use Linux root, or --dry-run with a disposable absolute --root");
  const at = (path: string) => root === "/" ? path : join(root, path);
  const safe = (path: string) => {
    if (root !== "/" && !path.startsWith(root + "/")) throw new InstallerFailure("paths", "use a path inside the fake root");
    for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new InstallerFailure("paths", "replace the unexpected symlink before re-running");
      if (dry && parent === root) break;
    }
  };
  const dir = (path: string, mode = 0o700) => { safe(path); mkdirSync(path, { recursive: true, mode }); chmodSync(path, mode); };
  const write = (path: string, text: string, mode = 0o600) => {
    safe(path); safe(dirname(path)); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(8).toString("hex")}`;
    try { writeFileSync(temp, text, { flag: "wx", mode }); renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
  };
  const run = options.run ?? spawnRunner;
  const call = async (argv: string[], timeoutMs = 120_000) => {
    if (dry) return { exitCode: options.simulation?.failStep === "optional-images" && argv.includes("pull") ? 1 : 0, stdout: "", timedOut: false };
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
  const configPath = at("/etc/jit/service-config.json"), home = at("/var/lib/jit");
  safe(configPath);
  const desired = parseServiceConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {
    serviceUser: "jit", executablePath: at("/opt/jit/current"), workingDirectory: join(home, "work"), stateDirectory: join(home, "state"),
    ledgerPath: join(home, "ledger/checkpoint.json"), backupDirectory: join(home, "backups"), secretRefs: [],
    routes: [{ route: "codex", model: builtInModels.codex, configured: true }, { route: "grok", model: builtInModels.grok, configured: true }],
    network: { bindHost: "127.0.0.1", port: 3000, vpnInterface: null }, resources: { memoryMaxBytes: defaults.memoryMaxBytes,
      logBytes: defaults.logBytes, retentionDays: 14, maxRestarts: 5, restartWindowSeconds: 300 }, runPort: "schway", channels: { telegram: "disabled" },
  });
  if (desired.serviceUser !== "jit" || desired.stateDirectory !== join(home, "state") || desired.executablePath !== at("/opt/jit/current") ||
      desired.workingDirectory !== join(home, "work") || desired.backupDirectory !== join(home, "backups") || desired.ledgerPath !== join(home, "ledger/checkpoint.json")) throw new InstallerFailure("configuration", "operate this custom installation with ops.service_package/v1 instead");
  let uid = 1001, gid = 1001;
  let commandArtifact = resolve(options.source);
  const asUser = (args: string[]) => ["runuser", "-u", desired.serviceUser, "--", "env", `HOME=${home}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...args];
  const service = async (args: string[]) => {
    if (dry) {
      const unitPath = at("/etc/systemd/system/jit.service"), journalPath = at("/etc/systemd/journald@jit.conf");
      if (args[0] === "install") {
        write(unitPath, await renderServiceUnit(desired, { bunPath: at("/opt/jit/bin/bun"), configPath, uid, gid }), 0o644);
        write(journalPath, await renderJournaldConfig(desired), 0o644);
      } else if (args[0] === "uninstall") {
        safe(unitPath); safe(journalPath); rmSync(unitPath, { force: true }); rmSync(journalPath, { force: true });
        const userUnit = join(home, ".config/systemd/user/gnome-keyring-daemon.service"); safe(userUnit); rmSync(userUnit, { force: true });
      }
      return;
    }
    // Use the staged build's installed dependencies, never import the unsealed source into a service process.
    await must([options.bunPath, join(commandArtifact, "src/main.ts"), "service", ...args,
      ...args.includes("--bun") ? [] : ["--bun", options.bunPath]]);
  };
  let ownedStaging: string | null = null;
  try {
    if (options.uninstall) {
      step("uninstall", "stop the installed unit with the service package, then re-run --uninstall");
      if (existsSync(at("/etc/systemd/system/jit.service"))) await service(["uninstall", "--config", configPath]);
      if (!dry) {
        const passwd = (await must(["getent", "passwd", "jit"])).trim().split(":"); uid = Number(passwd[2]);
        if (!Number.isSafeInteger(uid) || uid < 1) throw new InstallerFailure(currentStep, next);
        const userUnit = join(home, ".config/systemd/user/gnome-keyring-daemon.service");
        if (existsSync(userUnit)) await must(asUser(["systemctl", "--user", "disable", "--now", "gnome-keyring-daemon.service"]));
        rmSync(userUnit, { force: true });
        await must(asUser(["systemctl", "--user", "daemon-reload"]));
      }
      options.out?.("Uninstalled service units. Data, identity, Bun, releases, config, keyring and unlock file are retained.");
      return { events, config: desired, defaults };
    }
    step("disk-reserve", "free disk space above the displayed reserve plus 512 MiB staging space, then re-run");
    const disk = dry ? null : statfsSync(existsSync(desired.stateDirectory) ? desired.stateDirectory : "/var/lib");
    const free = disk ? disk.bavail * disk.bsize : options.facts.freeBytes;
    if (free < defaults.diskReserveBytes + 512 * MiB) throw new InstallerFailure(currentStep, next);
    step("identity", "provide a dedicated non-root jit identity with home /var/lib/jit and a non-login shell, then re-run");
    if (!dry) {
      let passwd = await call(["getent", "passwd", "jit"]);
      if (passwd.exitCode !== 0) {
        await must(["useradd", "--system", "--create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", "--user-group", "jit"]);
        passwd = await call(["getent", "passwd", "jit"]);
      }
      const fields = passwd.stdout.trim().split(":"); uid = Number(fields[2]); gid = Number(fields[3]);
      if (passwd.exitCode !== 0 || fields[0] !== "jit" || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1 || fields[5] !== home || !/\/(nologin|false)$/.test(fields[6] ?? "")) throw new InstallerFailure(currentStep, next);
    }
    dir(home);
    step("directories", "remove unexpected symlinks or repair directory ownership, then re-run");
    for (const path of [desired.stateDirectory, desired.backupDirectory, desired.workingDirectory, dirname(desired.ledgerPath), join(desired.stateDirectory, "attachments"),
      join(home, ".config"), join(home, ".config/systemd"), join(home, ".config/systemd/user"), join(home, ".local"), join(home, ".local/share"), join(home, ".local/share/keyrings")]) {
      dir(path); if (!dry) chownSync(path, uid, gid);
    }
    if (!dry) chownSync(home, uid, gid);
    dir(at("/opt/jit"), 0o755); dir(at("/opt/jit/bin"), 0o755); dir(at("/opt/jit/releases"), 0o755); dir(at("/var/lib/cni"), 0o755);
    const available = dry ? options.simulation?.podman !== false : (await call(["podman", "--version"])).exitCode === 0;
    step("subordinate-ids", "repair /etc/subuid and /etc/subgid ranges, then re-run");
    if (available) {
      const subuid = at("/etc/subuid"), subgid = at("/etc/subgid"); safe(subuid); safe(subgid);
      const ranges = subordinateIds(existsSync(subuid) ? readFileSync(subuid, "utf8") : "", existsSync(subgid) ? readFileSync(subgid, "utf8") : "", "jit");
      write(subuid, ranges.subuid, 0o644); write(subgid, ranges.subgid, 0o644);
    }
    step("keyring", "repair the jit user manager/Secret Service; preserve its existing unlock file and keyring, then re-run");
    const unlock = join(home, "keyring-unlock"); safe(unlock);
    if (!existsSync(unlock)) write(unlock, randomBytes(32).toString("hex"));
    if (!lstatSync(unlock).isFile() || (lstatSync(unlock).mode & 0o777) !== 0o600) throw new InstallerFailure(currentStep, next);
    const userUnit = join(home, ".config/systemd/user/gnome-keyring-daemon.service");
    write(userUnit, `[Unit]\nDescription=Jit service Secret Service (boot unlock)\nRequires=dbus.socket\nAfter=dbus.socket\n[Service]\nType=dbus\nBusName=org.freedesktop.secrets\nExecStart=/usr/bin/gnome-keyring-daemon --foreground --components=secrets --unlock\nStandardInput=file:${unlock}\nStandardOutput=null\nStandardError=null\nRestart=on-failure\nUMask=0077\n[Install]\nWantedBy=default.target\n`, 0o644);
    if (!dry) { chownSync(unlock, uid, gid); chownSync(userUnit, uid, gid); }
    await must(["loginctl", "enable-linger", "jit"]);
    await must(["systemctl", "start", `user@${uid}.service`]);
    await must(asUser(["systemctl", "--user", "daemon-reload"]));
    await must(asUser(["systemctl", "--user", "enable", "--now", "gnome-keyring-daemon.service"]));
    if (!dry) {
      const locked = await must(asUser(["busctl", "--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/collection/login", "org.freedesktop.Secret.Collection", "Locked"]));
      if (locked.trim() !== "b false") throw new InstallerFailure(currentStep, next);
    }
    step("artifact", "verify the release archive/Bun pins and registry access, then re-run");
    let artifact = resolve(options.source);
    if (!dry) {
      const staging = at(`/opt/jit/staging-${randomBytes(8).toString("hex")}`); ownedStaging = staging;
      if (existsSync(join(artifact, "manifest.json"))) cpSync(artifact, staging, { recursive: true });
      else buildPackage({ srcDir: artifact, outDir: staging, engineContract: "jit.schway.bridge/v1", engineRevision: null });
      artifact = staging;
      // No package scripts, root credentials or host environment reach dependency installation.
      const dependencyRunner: CommandRunner = async (argv, opts) => run(asUser(argv), { ...opts, env: { ...opts.env, PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: home } });
      await must(["chown", "-R", `${uid}:${gid}`, artifact]);
      if (!validateArtifact(artifact, { runtime: true }).ok) await installArtifactDependencies(artifact, { bunPath: options.bunPath, run: dependencyRunner, env: { HOME: home, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
      const checked = validateArtifact(artifact, { runtime: true });
      if (!checked.ok || !checked.manifest) throw new InstallerFailure(currentStep, next);
      commandArtifact = artifact;
      const db = join(desired.stateDirectory, "app.sqlite"), schema = openReadOnlyStore(db)?.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version) ?? null;
      if (schema !== null && schema !== checked.manifest.schemaVersion) throw new InstallerFailure("schema-upgrade", "complete the owner-authorized OPS06/OPS07 staged upgrade before re-running; no in-place migration is allowed");
      const remaining = statfsSync(desired.stateDirectory);
      if (remaining.bavail * remaining.bsize < defaults.diskReserveBytes) throw new InstallerFailure("disk-reserve", "free disk space above the displayed reserve and re-run");
    }
    step("configuration", "repair the trusted service config; existing config is preserved on re-run");
    dir(at("/etc/jit"), 0o750);
    if (!existsSync(configPath)) write(configPath, JSON.stringify(desired, null, 2), 0o640);
    if (!dry) chownSync(at("/etc/jit"), 0, gid);
    let configuredImages: PinnedImage[] = [];
    try { configuredImages = pinnedImages(dry ? options.simulation?.images ?? pins : pins); }
    catch { options.out?.("Optional image list unavailable: skipping pre-pull."); }
    write(at("/etc/jit/installer-state.json"), JSON.stringify({ contract: "ops.installer/v1", hardware: options.facts, defaults,
      containers: available ? "runtime-present-images-require-configuration" : "unavailable", images: configuredImages }, null, 2));
    step("service-install", "inspect service plan and the bounded journald namespace, then re-run");
    if (existsSync(at("/etc/systemd/system/jit.service"))) await service(["stop", "--config", configPath]);
    await service(["install", "--config", configPath, "--artifact", artifact, "--bun", options.bunPath]);
    step("state-initialize", "repair the service-owned state directory and re-run; existing state is never migrated at boot");
    if (!dry) {
      await must(asUser([options.bunPath, join(realpathSync(desired.executablePath), "ops/package/installer/main.ts"), "initialize-state", "--config", configPath]));
    }
    step("service-start", "inspect journalctl --namespace=jit -u jit.service, fix the named gate and re-run");
    await service(["start", "--config", configPath]);
    step("health", "inspect service preflight/journald, fix the named gate and re-run");
    const origin = desired.network.origin ?? `http://${desired.network.bindHost === "::1" ? "[::1]" : desired.network.bindHost}:${desired.network.port}`;
    if (dry && options.simulation?.health === false) throw new InstallerFailure(currentStep, next);
    if (!dry) {
      // systemd Type=simple can return before the listener exists. Retry locally within one wall-clock bound.
      const deadline = Date.now() + 20_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try { healthy = (await fetch(`${origin}/login`, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })).status === 200; } catch { /* Not listening yet. */ }
        if (healthy) break;
        await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      }
      if (!healthy) throw new InstallerFailure(currentStep, next);
    }
    // These two steps are optional by contract, including malformed/future image lists and missing Podman.
    step("optional-images", "add published digest-pinned images to the release image list");
    for (const image of configuredImages) {
      if (!available || (await call(asUser(["podman", "pull", image.ref]), 120_000)).exitCode !== 0) options.out?.(`Optional image unavailable: ${image.feature}`);
    }
    if (!available) options.out?.("Container features unavailable: Podman is absent. Chat-only installation is ready.");
    else if (!configuredImages.length && !desired.execution) options.out?.("Container features unavailable: no published image pins in this release (WEB02/ATT02 follow-ups).");
    step("optional-box-doctor", "configure an execution image and re-run box-doctor when container features are needed");
    if (!dry) {
      const env = Object.fromEntries(serviceEnvironment(desired));
      const result = await call(asUser(["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), options.bunPath, join(desired.executablePath, "src/ops-cli.ts"), "box-doctor"]));
      if (result.exitCode !== 0) options.out?.("Optional box-doctor: container features unavailable; core setup is ready.");
    }
    step("owner-link", "repair the service-owned state directory and re-run; an existing owner is never reset");
    let link: string | null = null;
    if (!dry) {
      const result = await must(asUser([options.bunPath, join(realpathSync(desired.executablePath), "ops/package/installer/main.ts"), "owner-link", "--config", configPath]));
      link = result.trim() || null;
      if (link && !new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/owner/setup\\?token=[a-f0-9]{64}$`).test(link)) throw new InstallerFailure(currentStep, next);
    }
    options.out?.(dry ? "Dry run complete. No host commands ran; no setup credential was created." : `Open ${link ?? `${origin}/login`} to finish setup`);
    return { events, config: desired, defaults };
  } catch (error) {
    if (error instanceof InstallerFailure) throw error;
    throw new InstallerFailure(currentStep, next);
  } finally {
    if (ownedStaging) rmSync(ownedStaging, { recursive: true, force: true });
  }
}

/** Service-identity helper: initialize only a new database, optionally issue a link; never migrate existing state. */
export function installerOwnerLink(config: ServiceConfig, issue = true): string | null {
  if (process.getuid?.() === 0) throw new Error("service-identity-required");
  const store = new TransactionStore(join(config.stateDirectory, "app.sqlite"), { migrateExisting: false });
  try { return issue ? issueOwnerSetupLink(store, config.network.origin ?? `http://${config.network.bindHost === "::1" ? "[::1]" : config.network.bindHost}:${config.network.port}`) : null; }
  finally { store.close(); }
}

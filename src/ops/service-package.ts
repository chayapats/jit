import { createHash } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inspectStoreSchema, TransactionStore } from "../store";
import { backupDirectoryProblem } from "./backup";
import { defaultLedgerGate, type LedgerGate } from "./lifecycle";
import { SystemdSupervisor, type CommandRunner, type SupervisorState } from "./supervisor";
import { writeFileAtomic } from "./upgrade-fence";
import { readManifest, validateArtifact, type BuildManifest } from "../../ops/package/bun-build";
import {
  assertNoSecretValues, parseServiceConfig, planServiceConfig, renderJournaldConfig, renderServiceUnit, serviceDatabasePath,
  serviceEnvironment, serviceLogNamespace, serviceOrigin, serviceReleasesDirectory, serviceUnitName,
  type ServiceConfig, type ServicePlanChange,
} from "../../ops/package/service-config";

/**
 * ops.service_package/v1 operator operations: plan, install, start, stop,
 * status, upgrade, disable and uninstall for the one supervised unit.
 *
 * Every external effect goes through the injected `CommandRunner` (systemctl,
 * `getent`, `bun --version`, the new build's `upgrade`) and explicit,
 * caller-supplied host directories, so tests use disposable paths and a fake
 * supervisor. Nothing here downloads packages, requests accounts, creates
 * users, changes VPN state or reboots.
 */
export interface OperatorHost {
  run: CommandRunner;
  /** systemd unit directory (default `/etc/systemd/system`). */
  unitDir: string;
  /** journald namespace configuration directory (default `/etc/systemd`). */
  journaldDir: string;
  /** Installed, operator-owned service configuration directory (default `/etc/jit`). */
  configDir: string;
  /** Absolute Bun runtime the unit executes. */
  bunPath: string;
  now?: () => number;
  ledgerGate?: LedgerGate;
  /**
   * Ownership operation for installed files (default `fs.chownSync` followed
   * by a stat verification). Tests inject a recorder; any failure fails install.
   */
  chown?: (path: string, uid: number, gid: number) => void;
}

/** Default ownership change: chown, then verify the result instead of trusting it. */
export function chownVerified(path: string, uid: number, gid: number): void {
  chownSync(path, uid, gid);
  const stats = lstatSync(path);
  if (stats.uid !== uid || stats.gid !== gid) throw new Error("ownership_not_applied");
}

export const defaultHostPaths = { unitDir: "/etc/systemd/system", journaldDir: "/etc/systemd", configDir: "/etc/jit" } as const;

/** One check with its safe next action. Detail never contains secret values or raw command output. */
export interface OperatorCheck { check: string; ok: boolean; nextAction: string; detail: string }

/** A file the install writes, shown in the plan with its exact mode and content digest. */
export interface PlannedFile { path: string; mode: string; sha256: string; content: string | null; owner: { uid: number; gid: number } | null }

export interface InstallPlan {
  schema: "jit.ops.service-plan/v1";
  ok: boolean;
  unit: string;
  artifactId: string | null;
  checks: OperatorCheck[];
  /** Resolved service identity (numeric UID and primary GID), or null when unresolved. */
  identity: { uid: number; gid: number } | null;
  changes: ServicePlanChange[];
  files: PlannedFile[];
  releaseDirectory: string | null;
  activeRelease: string;
  /** Fixed command vectors install runs after writing files. */
  commands: string[][];
  /** Managed data the plan never touches. */
  preserved: string[];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ok = (check: string, detail: string): OperatorCheck => ({ check, ok: true, nextAction: "none", detail });
const blocked = (check: string, nextAction: string, detail: string): OperatorCheck => ({ check, ok: false, nextAction, detail });
const nologinShells = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false"];

/** Installed configuration path for a host layout. */
export function installedConfigPath(host: Pick<OperatorHost, "configDir">): string {
  return join(host.configDir, "service-config.json");
}

/** Reads a bounded JSON configuration file that must not be writable by group/other. */
export function readServiceConfigFile(path: string): ServiceConfig {
  const file = resolve(path);
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0 || stats.size > 16384) throw new Error("unsafe_service_config_file");
  return parseServiceConfig(JSON.parse(readFileSync(file, "utf8")));
}

async function identity(run: CommandRunner, user: string): Promise<{ check: OperatorCheck; uid: number | null; gid: number | null }> {
  const none = (check: OperatorCheck) => ({ check, uid: null, gid: null });
  const result = await run(["getent", "passwd", user], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return none(blocked("identity", "create-dedicated-service-user", "service identity not found"));
  const fields = result.stdout.trim().split("\n")[0]?.split(":") ?? [];
  const uid = /^\d{1,10}$/.test(fields[2] ?? "") ? Number(fields[2]) : NaN, gid = /^\d{1,10}$/.test(fields[3] ?? "") ? Number(fields[3]) : NaN;
  const home = fields[5] ?? "", shell = fields[6] ?? "";
  if (fields[0] !== user || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) return none(blocked("identity", "create-dedicated-service-user", "service identity unreadable"));
  if (uid === 0) return none(blocked("identity", "use-non-root-service-user", "service identity is root"));
  if (gid === 0) return none(blocked("identity", "use-dedicated-service-group", "service identity's primary group is root"));
  // The unit runs with the identity's real primary group; it must resolve.
  const group = await run(["getent", "group", String(gid)], { timeoutMs: 10_000 });
  const groupFields = group.stdout.trim().split("\n")[0]?.split(":") ?? [];
  if (group.exitCode !== 0 || groupFields[2] !== String(gid)) return none(blocked("identity", "create-dedicated-service-group", "service identity's primary group not found"));
  if (!nologinShells.includes(shell) || home.startsWith("/home/")) {
    return { check: blocked("identity", "use-dedicated-non-login-identity", "service identity is an interactive login user"), uid, gid };
  }
  return { check: ok("identity", "dedicated non-login service identity and primary group present"), uid, gid };
}

async function runtime(run: CommandRunner, bunPath: string, manifest: BuildManifest | null): Promise<OperatorCheck> {
  if (!bunPath.startsWith("/")) return blocked("runtime", "use-absolute-bun-path", "bun path not absolute");
  try { if (!statSync(bunPath).isFile()) return blocked("runtime", "install-pinned-bun", "bun runtime missing"); }
  catch { return blocked("runtime", "install-pinned-bun", "bun runtime missing"); }
  const result = await run([bunPath, "--version"], { timeoutMs: 10_000 });
  const version = result.stdout.trim();
  if (result.exitCode !== 0) return blocked("runtime", "install-pinned-bun", "bun runtime not executable");
  if (!manifest || version !== manifest.bunVersion) return blocked("runtime", "install-pinned-bun", "bun version differs from the artifact pin");
  return ok("runtime", `bun ${version} matches artifact pin`);
}

function directory(check: string, path: string, uid: number | null, strict: boolean): OperatorCheck {
  if (strict) {
    const problem = backupDirectoryProblem(path, uid ?? undefined);
    return problem === null ? ok(check, "owned by the service identity, mode 0700-class")
      : blocked(check, problem === "backup_directory_missing" ? "prepare-service-directories" : "restrict-service-directory", problem.replace("backup_", ""));
  }
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return blocked(check, "prepare-service-directories", "not a directory");
    if ((stats.mode & 0o022) !== 0) return blocked(check, "restrict-service-directory", "writable by group/other");
    return ok(check, "present");
  } catch { return blocked(check, "prepare-service-directories", "missing"); }
}

type AccessFlag = "-r" | "-w" | "-x";

/**
 * Asks whether the resolved service identity itself can access `path`, as
 * the kernel decides it: fixed argv `runuser -u <user> -- test <flag> <path>`
 * through the injectable runner (no shell). Mode bits alone cannot answer
 * this (ACLs, supplementary groups, parent traversal).
 */
async function serviceCan(run: CommandRunner, user: string, path: string, flags: AccessFlag[]): Promise<AccessFlag[]> {
  const missing: AccessFlag[] = [];
  for (const flag of flags) {
    const result = await run(["runuser", "-u", user, "--", "test", flag, path], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) missing.push(flag);
  }
  return missing;
}

const flagNames: Record<AccessFlag, string> = { "-r": "read", "-w": "write", "-x": "traverse" };

/** Access checks for every path the unit needs, evaluated as the service identity. */
async function accessChecks(run: CommandRunner, service: ServiceConfig, host: OperatorHost, resolved: boolean): Promise<OperatorCheck[]> {
  const required: [string, string, AccessFlag[]][] = [
    ["access:state-directory", service.stateDirectory, ["-r", "-w", "-x"]],
    ["access:backup-directory", service.backupDirectory, ["-r", "-w", "-x"]],
    ["access:ledger-directory", dirname(service.ledgerPath), ["-w", "-x"]],
    ["access:working-directory", service.workingDirectory, ["-r", "-x"]],
    ["access:release-parent", dirname(service.executablePath), ["-x"]],
  ];
  if (existsSync(host.configDir)) required.push(["access:config-directory", host.configDir, ["-x"]]);
  if (existsSync(service.ledgerPath)) required.push(["access:ledger", service.ledgerPath, ["-r", "-w"]]);
  for (const ref of service.secretRefs) if (ref.store === "credential-file" && existsSync(ref.key)) required.push([`access:secret:${ref.name}`, ref.key, ["-r"]]);
  const checks: OperatorCheck[] = [];
  for (const [check, path, flags] of required) {
    // An unresolved identity is already a blocked `identity` check; access cannot be evaluated for it.
    if (!resolved) break;
    const missing = await serviceCan(run, service.serviceUser, path, flags);
    checks.push(missing.length === 0 ? ok(check, `service identity can ${flags.map(f => flagNames[f]).join("/")}`)
      : blocked(check, "grant-service-identity-access", `service identity cannot ${missing.map(f => flagNames[f]).join("/")}`));
  }
  return checks;
}

/** An existing ledger checkpoint must be a regular, non-symlink, service-owned 0600 file. */
function ledgerFileCheck(service: ServiceConfig, uid: number | null): OperatorCheck | null {
  let stats;
  try { stats = lstatSync(service.ledgerPath); } catch { return null; }
  if (stats.isSymbolicLink() || !stats.isFile()) return blocked("ledger", "replace-ledger-with-regular-file", "ledger checkpoint is not a regular file");
  if (uid === null || stats.uid !== uid) return blocked("ledger", "chown-ledger-to-service-identity", "ledger checkpoint not owned by the service identity");
  if ((stats.mode & 0o777) !== 0o600) return blocked("ledger", "restrict-ledger-mode-0600", "ledger checkpoint mode is not 0600");
  return ok("ledger", "ledger checkpoint regular, service-owned, 0600");
}

/** An existing config directory must be a real directory, not writable by group/other. */
function configDirectoryCheck(host: OperatorHost): OperatorCheck {
  let stats;
  try { stats = lstatSync(host.configDir); } catch { return ok("config-directory", "created by install as root:<service gid> 0750"); }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return blocked("config-directory", "replace-config-directory", "config path is not a real directory");
  if ((stats.mode & 0o022) !== 0) return blocked("config-directory", "restrict-config-directory", "config directory writable by group/other");
  return ok("config-directory", "present; install sets root:<service gid> 0750");
}

function secretChecks(service: ServiceConfig, uid: number | null): OperatorCheck[] {
  return service.secretRefs.map(ref => {
    if (ref.store !== "credential-file") return blocked(`secret:${ref.name}`, "verify-secret-store", `${ref.store} access cannot be verified by the package`);
    try {
      const stats = statSync(ref.key);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) return blocked(`secret:${ref.name}`, "restrict-credential-file", "credential file mode allows group/other");
      if (uid !== null && stats.uid !== uid) return blocked(`secret:${ref.name}`, "chown-credential-file-to-service", "credential file not owned by the service identity");
      return ok(`secret:${ref.name}`, "credential file present with owner-only mode");
    } catch { return blocked(`secret:${ref.name}`, "provision-credential-file", "credential file missing"); }
  });
}

async function privateBind(run: CommandRunner, service: ServiceConfig): Promise<OperatorCheck> {
  if (service.network.vpnInterface === null) return ok("network", "loopback bind behind configured private ingress");
  const result = await run(["ip", "-o", "addr", "show", "dev", service.network.vpnInterface], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return blocked("network", "bring-up-private-interface", "private interface not present");
  const addresses = [...result.stdout.matchAll(/\sinet6?\s([0-9a-f.:]+)\//gi)].map(m => m[1]!.toLowerCase());
  return addresses.includes(service.network.bindHost.toLowerCase())
    ? ok("network", "bind address is assigned to the named private interface")
    : blocked("network", "assign-bind-address-to-private-interface", "bind address not on the named private interface");
}

function activeReleaseCheck(service: ServiceConfig): OperatorCheck {
  try {
    const stats = lstatSync(service.executablePath);
    if (!stats.isSymbolicLink()) return blocked("active-release", "move-unmanaged-release", "active release path is not a managed symlink");
    return ok("active-release", "managed release symlink");
  } catch { return ok("active-release", "first install"); }
}

function readCurrent(host: OperatorHost): ServiceConfig | null {
  try { return readServiceConfigFile(installedConfigPath(host)); } catch { return null; }
}

/**
 * Plan/validate mode. Performs read-only checks (identity, runtime, artifact,
 * directories, secrets, private bind, duplicate instance) and returns the
 * exact unit, journald and configuration files install would write, with
 * modes and digests. Prints no secret values: rendered texts pass
 * `assertNoSecretValues`, and secret references appear by name.
 */
export async function planInstall(input: { service: unknown; artifactDir: string; host: OperatorHost }): Promise<InstallPlan> {
  const service = parseServiceConfig(input.service);
  const host = input.host;
  const checks: OperatorCheck[] = [];
  const validation = validateArtifact(input.artifactDir, { runtime: true });
  const manifest = validation.manifest;
  checks.push(validation.ok && manifest?.engineContract === "jit.schway.bridge/v1"
    ? ok("artifact", `artifact ${manifest.artifactId} validated`)
    : blocked("artifact", "rebuild-or-reinstall-artifact-dependencies", `artifact failed: ${validation.checks.filter(c => !c.ok).map(c => c.check).join(",") || "engine-contract"}`));
  const who = await identity(host.run, service.serviceUser);
  checks.push(who.check);
  checks.push(await runtime(host.run, host.bunPath, manifest));
  checks.push(directory("state-directory", service.stateDirectory, who.uid, true));
  checks.push(directory("backup-directory", service.backupDirectory, who.uid, true));
  checks.push(directory("working-directory", service.workingDirectory, null, false));
  checks.push(directory("ledger-directory", dirname(service.ledgerPath), null, false));
  const ledgerCheck = ledgerFileCheck(service, who.uid);
  if (ledgerCheck) checks.push(ledgerCheck);
  checks.push(configDirectoryCheck(host));
  checks.push(...secretChecks(service, who.uid));
  checks.push(...await accessChecks(host.run, service, host, who.uid !== null && who.gid !== null));
  checks.push(await privateBind(host.run, service));
  checks.push(activeReleaseCheck(service));
  const supervisor = new SystemdSupervisor(host.run);
  const unitPath = join(host.unitDir, serviceUnitName);
  const state = existsSync(unitPath) ? await supervisor.state() : null;
  checks.push(state && state.active !== "inactive" && state.active !== "failed"
    ? blocked("instance", "stop-service-before-reinstall", `installed unit is ${state.active}`)
    : ok("instance", state ? "installed unit inactive" : "no installed unit"));
  const configPath = installedConfigPath(host);
  const unit = await renderServiceUnit(service, { bunPath: host.bunPath, configPath, ...(who.gid !== null ? { gid: who.gid } : {}) });
  const journald = await renderJournaldConfig(service);
  const configText = JSON.stringify(service, null, 2) + "\n";
  for (const text of [unit, journald, configText]) assertNoSecretValues(text);
  const releaseDirectory = manifest ? join(serviceReleasesDirectory(service), manifest.artifactId) : null;
  const files: PlannedFile[] = [
    { path: unitPath, mode: "0644", sha256: sha256(unit), content: unit, owner: null },
    { path: join(host.journaldDir, `journald@${serviceLogNamespace}.conf`), mode: "0644", sha256: sha256(journald), content: journald, owner: null },
    // The installed configuration is shown by digest only; its non-secret fields appear in `changes`.
    // root:<service gid> 0640: readable by the service, writable only by the operator.
    { path: configPath, mode: "0640", sha256: sha256(configText), content: null, owner: who.gid !== null ? { uid: 0, gid: who.gid } : null },
  ];
  if (!existsSync(service.ledgerPath)) {
    // Seed placeholder owned by the service identity, which must read and later replace it.
    const seed = JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n";
    files.push({ path: service.ledgerPath, mode: "0600", sha256: sha256(seed), content: seed,
      owner: who.uid !== null && who.gid !== null ? { uid: who.uid, gid: who.gid } : null });
  }
  return {
    schema: "jit.ops.service-plan/v1", ok: checks.every(c => c.ok), unit: serviceUnitName,
    artifactId: manifest?.artifactId ?? null, checks, identity: who.uid !== null && who.gid !== null ? { uid: who.uid, gid: who.gid } : null, changes: planServiceConfig(readCurrent(host), service), files,
    releaseDirectory, activeRelease: service.executablePath,
    commands: [["systemctl", "daemon-reload"], ["systemctl", "enable", serviceUnitName]],
    preserved: [service.stateDirectory, service.backupDirectory, service.ledgerPath, ...service.secretRefs.map(r => `secret-ref:${r.name}`)],
  };
}

/** Atomically points the active-release symlink at `target`. */
function switchRelease(activePath: string, target: string): void {
  const temp = join(dirname(activePath), `.${basename(activePath)}.next-${crypto.randomUUID()}`);
  symlinkSync(target, temp);
  try { renameSync(temp, activePath); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

function releaseTarget(activePath: string): string | null {
  try { return lstatSync(activePath).isSymbolicLink() ? resolve(dirname(activePath), readlinkSync(activePath)) : null; } catch { return null; }
}

/** Copies a validated artifact into the immutable releases directory (idempotent per artifact id). */
function stageRelease(service: ServiceConfig, artifactDir: string, manifest: BuildManifest): string {
  const releases = serviceReleasesDirectory(service);
  const target = join(releases, manifest.artifactId);
  mkdirSync(releases, { recursive: true, mode: 0o755 });
  chmodSync(releases, 0o755);
  if (!existsSync(target)) {
    const temp = join(releases, `.${manifest.artifactId}.staging-${crypto.randomUUID()}`);
    cpSync(resolve(artifactDir), temp, { recursive: true });
    renameSync(temp, target);
  }
  const copied = validateArtifact(target, { runtime: true });
  if (!copied.ok || copied.manifest?.artifactId !== manifest.artifactId) throw new Error("release_copy_invalid");
  return target;
}

/**
 * Proves, as the service identity, that every entry of a staged release is
 * readable and every directory traversable: one fixed-argv GNU `find` run
 * through the runner (`runuser -u <user> -- find <release> ( ! -readable -o
 * -type d ! -executable ) -print -quit`). Any output or failure means the
 * non-root unit could not boot this release.
 */
export async function releaseReadableByService(run: CommandRunner, user: string, release: string): Promise<boolean> {
  const parent = await run(["runuser", "-u", user, "--", "test", "-x", dirname(release)], { timeoutMs: 10_000 });
  if (parent.exitCode !== 0) return false;
  const result = await run(["runuser", "-u", user, "--", "find", release, "(", "!", "-readable", "-o", "-type", "d", "!", "-executable", ")", "-print", "-quit"],
    { timeoutMs: 120_000 });
  return result.exitCode === 0 && !result.timedOut && result.stdout.trim() === "";
}

export interface InstallResult { ok: boolean; plan: InstallPlan; release: string | null; supervisor: { reloaded: boolean; enabled: boolean } | null }

/**
 * Installs service descriptors after a passing plan: stages the release,
 * seeds the ledger checkpoint placeholder only when absent (never
 * overwrites), writes the configuration (0640), unit (0644) and journald
 * namespace (0644) files atomically, points the active-release symlink and
 * enables the unit for unattended boot. It does not start the service.
 */
export async function installService(input: { service: unknown; artifactDir: string; host: OperatorHost }): Promise<InstallResult> {
  const plan = await planInstall(input);
  if (!plan.ok || !plan.identity) return { ok: false, plan, release: null, supervisor: null };
  const service = parseServiceConfig(input.service);
  const { uid, gid } = plan.identity;
  const host = input.host;
  const chown = host.chown ?? chownVerified;
  const fail = (nextAction: string, detail: string, release: string | null = null): InstallResult =>
    ({ ok: false, plan: { ...plan, ok: false, checks: [...plan.checks, blocked("install", nextAction, detail)] }, release, supervisor: null });
  const manifest = readManifest(input.artifactDir);
  const release = stageRelease(service, input.artifactDir, manifest);
  // The service identity must traverse the config directory to read --service-config: root:<gid> 0750.
  try {
    mkdirSync(host.configDir, { recursive: true, mode: 0o750 });
    if (lstatSync(host.configDir).isSymbolicLink()) return fail("replace-config-directory", "config path is a symlink", release);
    chmodSync(host.configDir, 0o750);
    chown(host.configDir, 0, gid);
  } catch { return fail("run-install-as-root", "could not assign config directory ownership", release); }
  let seeded = false;
  for (const file of plan.files) {
    const content = file.content ?? JSON.stringify(service, null, 2) + "\n";
    const isLedger = file.path === service.ledgerPath;
    // The ledger seed is written only when absent; a real checkpoint is never replaced by packaging.
    if (isLedger && existsSync(file.path)) continue;
    writeFileAtomic(file.path, content);
    if (isLedger) seeded = true;
    chmodSync(file.path, Number.parseInt(file.mode, 8));
    if (file.owner) {
      // Any ownership failure fails the install before the release is activated or the unit enabled.
      try { chown(file.path, file.owner.uid, file.owner.gid); }
      catch {
        // Never leave an installer-owned seed behind for a retry to inherit.
        if (isLedger) rmSync(file.path, { force: true });
        return fail("run-install-as-root", `could not assign ${isLedger ? "ledger" : "configuration"} ownership`, release);
      }
    }
  }
  // Verify, as the service identity, everything the unit needs before activating anything.
  const verify: [string, AccessFlag[]][] = [[installedConfigPath(host), ["-r"]], [service.ledgerPath, ["-r", "-w"]],
    [release, ["-r", "-x"]], [join(release, "src", "main.ts"), ["-r"]]];
  for (const [path, flags] of verify) {
    const missing = await serviceCan(host.run, service.serviceUser, path, flags);
    if (missing.length) {
      if (seeded) rmSync(service.ledgerPath, { force: true });
      return fail("grant-service-identity-access", `service identity cannot ${missing.map(f => flagNames[f]).join("/")} an installed path`, release);
    }
  }
  void uid;
  if (!await releaseReadableByService(host.run, service.serviceUser, release)) {
    if (seeded) rmSync(service.ledgerPath, { force: true });
    return fail("grant-service-identity-access", "service identity cannot read or traverse the whole staged release", release);
  }
  switchRelease(service.executablePath, release);
  const supervisor = new SystemdSupervisor(host.run);
  const reloaded = await supervisor.daemonReload();
  const enabled = reloaded && await supervisor.enable();
  return { ok: reloaded && enabled, plan, release, supervisor: { reloaded, enabled } };
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

export type PackageUpgradeOutcome = "upgraded" | "blocked" | "upgrade-failed" | "rolled-back" | "activation-unhealthy";

export interface PackageUpgradeResult {
  schema: "jit.ops.package-upgrade/v1";
  outcome: PackageUpgradeOutcome;
  previousArtifactId: string | null;
  artifactId: string | null;
  activeArtifactId: string | null;
  fromSchema: number | null;
  toSchema: number | null;
  /** Recovery point recorded by ops.schema_migrations/v1 (`snapshotBackupId`); stays inspectable on failure. */
  recoveryBackupId: string | null;
  upgradeId: string | null;
  supervisor: SupervisorState["active"] | null;
  detail: string;
  nextAction: string;
}

export interface PackageUpgradeInput {
  service: ServiceConfig;
  /** Staged artifact built by the new release (dependencies installed for this host). */
  artifactDir: string;
  host: OperatorHost;
  /** Owner password, passed only to the new build's `upgrade` on stdin. */
  ownerPassword: string;
  /** Liveness check after start. Default polls the supervisor and GET /login on the private bind. */
  health?: () => Promise<boolean>;
  /** Total upgrade budget for the new build's `upgrade` command (default 30 min). */
  upgradeTimeoutMs?: number;
}

function schemaOf(service: ServiceConfig): number | null {
  try { return inspectStoreSchema(serviceDatabasePath(service)); } catch { return null; }
}

function liveOwner(service: ServiceConfig): boolean {
  if (!existsSync(serviceDatabasePath(service))) return false;
  let store: TransactionStore | null = null;
  try {
    store = new TransactionStore(serviceDatabasePath(service), { migrateExisting: false });
    const pids = store.read(tx => ["job_scheduler", "delivery_worker"].map(table => {
      try { return tx.get<{ pid: number }>(`SELECT pid FROM ${table} WHERE id = 1`)?.pid ?? null; } catch { return null; }
    }));
    return pids.some(pid => {
      if (pid === null) return false;
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
  } catch { return true; } finally { try { store?.close(); } catch { /* Read-only probe. */ } }
}

/** Default health probe: supervisor active and the private bind answers GET /login within finite timeouts. */
export function defaultHealth(service: ServiceConfig, supervisor: SystemdSupervisor, options: { deadlineMs?: number } = {}): () => Promise<boolean> {
  return async () => {
    const deadline = Date.now() + (options.deadlineMs ?? 60_000);
    const hostHeader = new URL(serviceOrigin(service)).host;
    const bind = service.network.bindHost.includes(":") ? `[${service.network.bindHost}]` : service.network.bindHost;
    while (Date.now() < deadline) {
      const state = await supervisor.state();
      if (state.active === "failed") return false;
      if (state.active === "active") {
        try {
          const response = await fetch(`http://${bind}:${service.network.port}/login`, { headers: { host: hostHeader }, signal: AbortSignal.timeout(5000) });
          if (response.status === 200) return true;
        } catch { /* Not listening yet. */ }
      }
      await Bun.sleep(1000);
    }
    return false;
  };
}

/**
 * Supported package upgrade: validated pinned artifact → stop (cooperative
 * drain under the supervisor) → the NEW build's owner-authorized
 * `upgrade` (ops.schema_migrations/v1: fence, verified recovery point, staged
 * migration, validation, atomic activation) → switch the active release →
 * start (boot reconciles before admitting work) → health.
 *
 * Failure handling never loses data and never rewrites native Schway format
 * or the ledger:
 * - Blocked before stopping (invalid/incompatible artifact, older-than-state
 *   schema, quarantined ledger): nothing changes.
 * - `upgrade` failed: the release is not switched; the prior release is
 *   started again when the state schema still matches it.
 * - Unhealthy after start: rollback to the prior release only when the state
 *   schema still matches the prior release (compatible pair). After a schema
 *   change the service stays stopped on the new release and the recovery
 *   point is reported for an OPS02 quarantined restore.
 */
export async function upgradePackage(input: PackageUpgradeInput): Promise<PackageUpgradeResult> {
  const service = parseServiceConfig(input.service);
  const host = input.host;
  const supervisor = new SystemdSupervisor(host.run);
  const fromSchema = schemaOf(service);
  const previousRelease = releaseTarget(service.executablePath);
  let previous: BuildManifest | null = null;
  try { previous = previousRelease ? readManifest(previousRelease) : null; } catch { previous = null; }
  const result = (outcome: PackageUpgradeOutcome, detail: string, nextAction: string, extra: Partial<PackageUpgradeResult> = {}): PackageUpgradeResult => ({
    schema: "jit.ops.package-upgrade/v1", outcome, previousArtifactId: previous?.artifactId ?? null, artifactId: null,
    activeArtifactId: (() => { try { const t = releaseTarget(service.executablePath); return t ? readManifest(t).artifactId : null; } catch { return null; } })(),
    fromSchema, toSchema: schemaOf(service), recoveryBackupId: null, upgradeId: null, supervisor: null, detail, nextAction, ...extra,
  });
  const validation = validateArtifact(input.artifactDir, { runtime: true });
  const manifest = validation.manifest;
  if (!validation.ok || !manifest || manifest.engineContract !== "jit.schway.bridge/v1") {
    return result("blocked", `staged artifact failed: ${validation.checks.filter(c => !c.ok).map(c => c.check).join(",") || "engine-contract"}`, "rebuild-or-reinstall-artifact-dependencies");
  }
  if (fromSchema === null) return result("blocked", "installation state unreadable", "inspect-installation-state", { artifactId: manifest.artifactId });
  if (manifest.schemaVersion < fromSchema) return result("blocked", "staged artifact is older than installation state; downgrade is unsupported", "use-compatible-app-artifact", { artifactId: manifest.artifactId });
  if (previous && previous.artifactId === manifest.artifactId) return result("blocked", "artifact already active", "none", { artifactId: manifest.artifactId });
  // Newer deletion/suppression ledger state is never ignored: a quarantined installation is not upgraded.
  const ledgerStore = new TransactionStore(serviceDatabasePath(service), { migrateExisting: false });
  let ledger;
  try { ledger = (host.ledgerGate ?? defaultLedgerGate)({ store: ledgerStore, ledgerPath: service.ledgerPath, now: (host.now ?? Date.now)(), mode: "inspect" }); }
  finally { ledgerStore.close(); }
  if (!ledger.trusted) return result("blocked", ledger.reason, ledger.nextAction, { artifactId: manifest.artifactId });
  let release: string;
  try { release = stageRelease(service, input.artifactDir, manifest); }
  catch { return result("blocked", "release copy failed validation", "rebuild-artifact", { artifactId: manifest.artifactId }); }
  if (!await releaseReadableByService(host.run, service.serviceUser, release)) {
    return result("blocked", "service identity cannot read or traverse the whole staged release", "grant-service-identity-access", { artifactId: manifest.artifactId });
  }
  // Stop: systemd delivers SIGTERM; serve drains within its budget and the unit's TimeoutStopSec bounds the wait.
  await supervisor.stop();
  const stopped = await supervisor.state();
  if (!["inactive", "failed"].includes(stopped.active) || liveOwner(service)) {
    return result("blocked", "service did not stop; another live writer still owns admission or delivery", "terminate-supervised-process-and-reconcile",
      { artifactId: manifest.artifactId, supervisor: stopped.active });
  }
  const runAs = typeof process.getuid === "function" && process.getuid() === 0 ? ["runuser", "-u", service.serviceUser, "--"] : [];
  const env = Object.fromEntries([...serviceEnvironment(service), ["PATH", process.env.PATH ?? "/usr/bin:/bin"]]);
  const upgraded = await host.run([...runAs, host.bunPath, join(release, "src", "main.ts"), "upgrade", "--service-config", installedConfigPath(host), "--password-stdin"],
    { cwd: service.workingDirectory, env, stdin: `${input.ownerPassword}\n`, timeoutMs: input.upgradeTimeoutMs ?? 1_800_000 });
  const evidence = parseUpgradeEvidence(upgraded.stdout);
  const ids = { artifactId: manifest.artifactId, recoveryBackupId: evidence.snapshotBackupId, upgradeId: evidence.id };
  if (upgraded.exitCode !== 0 || evidence.state !== "activated" && evidence.state !== "complete") {
    // Live state is untouched before activation, so the prior release still matches it.
    const compatible = previous !== null && schemaOf(service) === previous.schemaVersion;
    const restarted = compatible ? await supervisor.start() : false;
    return result("upgrade-failed", `owner upgrade did not activate (${evidence.error ?? evidence.state ?? (upgraded.timedOut ? "timeout" : "failed")})`,
      compatible ? "inspect-upgrade-journal" : "inspect-upgrade-journal-service-stopped", { ...ids, supervisor: restarted ? "active" : stopped.active });
  }
  switchRelease(service.executablePath, release);
  const started = await supervisor.start();
  const healthy = started && await (input.health ?? defaultHealth(service, supervisor))();
  if (healthy) return result("upgraded", `release ${manifest.artifactId} active and healthy`, "none", { ...ids, supervisor: "active" });
  await supervisor.stop();
  const toSchema = schemaOf(service);
  if (previous && previousRelease && toSchema === previous.schemaVersion) {
    switchRelease(service.executablePath, previousRelease);
    const restarted = await supervisor.start();
    return result("rolled-back", "health check failed; prior release restored against a compatible state", "inspect-upgrade-health-failure",
      { ...ids, supervisor: restarted ? "active" : "unknown" });
  }
  return result("activation-unhealthy", "health check failed after a schema change; rollback to the prior release is not compatible",
    "restore-recovery-point-through-quarantine", { ...ids, supervisor: (await supervisor.state()).active });
}

function parseUpgradeEvidence(stdout: string): { id: string | null; state: string | null; snapshotBackupId: string | null; error: string | null } {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const journal = (parsed.upgrade ?? parsed) as Record<string, unknown>;
    const text = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : null;
    return { id: text(journal.id, /^[a-f0-9-]{36}$/), state: text(journal.state, /^[a-z_]{1,32}$/),
      snapshotBackupId: text(journal.snapshotBackupId, /^[a-f0-9-]{36}$/), error: text(parsed.error, /^[a-z_]{1,64}$/) };
  } catch { return { id: null, state: null, snapshotBackupId: null, error: null }; }
}

// ---------------------------------------------------------------------------
// Disable / uninstall
// ---------------------------------------------------------------------------

export interface RemoveResult { disabled: boolean; removed: string[]; preserved: string[] }

/**
 * Disables boot start and stops the unit; with `remove`, deletes only the
 * unit and journald namespace files. Configuration, releases, state,
 * backups, the ledger and every secret reference are preserved: deleting
 * managed data is a distinct, separately authorized operation.
 */
export async function disableService(input: { service: ServiceConfig; host: OperatorHost; remove: boolean }): Promise<RemoveResult> {
  const supervisor = new SystemdSupervisor(input.host.run);
  const disabled = await supervisor.disable();
  const removed: string[] = [];
  if (input.remove && disabled) {
    for (const path of [join(input.host.unitDir, serviceUnitName), join(input.host.journaldDir, `journald@${serviceLogNamespace}.conf`)]) {
      if (existsSync(path)) { rmSync(path, { force: true }); removed.push(path); }
    }
    await supervisor.daemonReload();
  }
  return { disabled, removed, preserved: [installedConfigPath(input.host), serviceReleasesDirectory(input.service), input.service.stateDirectory,
    input.service.backupDirectory, input.service.ledgerPath, ...input.service.secretRefs.map(r => `secret-ref:${r.name}`)] };
}

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { buildPackage, validateArtifact } from "../bun-build";
import { assertRootPath, assertRootTree, freezeInstallerArtifact, giveInstallerStaging } from "./trusted-paths";
import { installerDefaults, InstallerFailure, type HostFacts, type InstallerDefaults } from "./installer";
import { captureOwnerPipe, operatorTerminal, prepareS14OwnerLink, type PendingOwnerLink } from "./owner-link";
import { spawnRunner, type CommandResult, type CommandRunner } from "../../../src/ops/supervisor";
import { releaseReadableByService } from "../../../src/ops/service-package";
import { parseS15RuntimeConfig, readS15RuntimeConfig, type S15RuntimeConfig } from "../../../src/s15/runtime-config";
import { renderVmmLauncher } from "../../../src/s15/vm/vmm-launcher";
import { vmmCommand, vmmHostProbe, vmmLayout, vmmProxySocketName, type QemuVmmOptions } from "../../../src/s15/vm/vmm";
import { probeLocalVmHost } from "../../../src/s15/vm/local";
import { personalServiceBinding } from "../../../src/s14/personal-origin";
import { zero } from "../../../src/s15/policy/validation";
import { en } from "../../../src/i18n/en";
import { th } from "../../../src/i18n/th";

const MiB = 1024 ** 2;

/**
 * The separate S15 installation (`install.sh --s15`). Every path, identity and unit differs from the legacy
 * (`jit`) and S14 (`jit-s14`) installations, so selecting S15 never reads, rewrites or removes their files.
 */
export const s15Installation = Object.freeze({
  user: "jit-s15", vmmUser: "jit-s15-vmm", group: "jit-s15-vm",
  home: "/var/lib/jit-s15", state: "/var/lib/jit-s15/state", vmmHome: "/var/lib/jit-s15-vmm", vmmRoot: "/var/lib/jit-s15-vm",
  prefix: "/opt/jit-s15", configDir: "/etc/jit-s15", config: "/etc/jit-s15/s15-runtime.json", installerState: "/etc/jit-s15/installer-state.json",
  launcher: "/opt/jit-s15/libexec/jit-s15-vmm", sudoers: "/etc/sudoers.d/jit-s15-vmm",
  unit: "/etc/systemd/system/jit-s15.service", journald: "/etc/systemd/journald@jit-s15.conf", service: "jit-s15.service", journal: "jit-s15",
  proxySocketUnit: "/etc/systemd/system/jit-s15-vm-proxy.socket", proxySocket: "jit-s15-vm-proxy.socket",
  origin: "http://127.0.0.1:3002",
});

const ref = (id: string) => ({ id, revision: 1, generation: 1 });
/**
 * The generated credential-free `s15-runtime/v1` configuration. No owner input: a random installation id, the
 * fixed S15 directories, a loopback origin (an existing HTTPS private-ingress origin is preserved on re-run),
 * the approved Codex subscription route for the owner's single device login (live availability follows that
 * login), no policy, budget or personal GitHub rule, and the Jit-managed local working computer whose QEMU runs
 * as the separate identity (`vmm: null` on a host without local VM support: the owner enrolls their own VM in
 * the Web instead). `browser: null` selects the provisioned protected browser (BROW15-02): pinned Chromium that
 * the controller verifies itself and the owner's approved-website list in the Web. GitHub and Google stay off.
 */
export function s15InstallerConfig(input: { installationId: string; vmm: QemuVmmOptions | null; origin?: string }): S15RuntimeConfig {
  const selection = { route: ref("codex_route"), model: ref("codex_model"), effort: "high" };
  // One model call is one attempt; a zero attempt bound would record an overrun on the first settled call.
  const bound = { ...zero(), attempts: 1, calls: 1, steps: 1, activeMs: 30000, outputBytes: 32768 };
  return parseS15RuntimeConfig({ contract: "s15-runtime/v1", installationId: input.installationId, directory: s15Installation.state, origin: input.origin ?? s15Installation.origin, policy: null,
    catalog: [{ kind: "bot", ref: ref("jit"), active: true }, { kind: "resource", ref: ref("computer"), active: true }, { kind: "route", ref: selection.route, active: true }, { kind: "model", ref: selection.model, active: true }], resourceBots: [],
    conversation: { ownerId: "owner", bot: ref("jit"), selection, route: { provider: "codex", model: "gpt-6.1-sol" }, limits: { modelCalls: 6, toolCalls: 16, outputBytes: 32768, activeMs: 300000 }, modelCallUpperBound: bound },
    models: [{ selection, provider: "codex", modelId: "gpt-6.1-sol", account: ref("codex_account"), billing: ref("codex_subscription"), recipient: ref("codex_provider"), charge: "subscription", availability: "available", efforts: ["high"], effortEvidence: "requested_only", upperBound: bound, rank: { ordinary: 0, difficult: 0 } }],
    modelLimits: { turns: 6, attempts: 1, activeMs: 300000, outputBytes: 32768, contextWindow: 32768, inputChars: 65536 },
    disclosure: { sources: [], approvals: [], githubRecipient: null, googleRecipient: null, browser: [], acquisitions: [], registries: [] },
    // Without local VM support (no kvm group) the pool's default member is an owner-supplied VM enrolled in the Web.
    vm: { id: "working", resource: ref("computer"), limaInstance: null, ...(input.vmm ? { local: true, vmm: input.vmm } : { local: false }), upperBound: { ...zero(), calls: 1, reads: 1, outputBytes: 1048576, activeMs: 120000 } },
    team: { maxConcurrentOperations: 2, memory: "off" }, browser: null, google: null, github: null });
}

/**
 * Hardened controller unit. QEMU never runs here: the working VM lives in the separate identity's lingering
 * user manager, so controller restarts and upgrades never kill it. The controller reaches that identity only
 * through sudo and the fixed launcher (VM15-03), so this unit keeps privilege transitions available
 * (no NoNewPrivileges) while the sudoers rule allows nothing but the launcher. `vmmUid: null` (no local VM
 * support) renders the controller alone, with NoNewPrivileges and no QEMU identity, proxy socket or sudo.
 */
export function renderS15Unit(input: { uid: number; vmmUid: number | null; memoryMaxBytes: number }): string {
  for (const id of [input.uid, ...(input.vmmUid === null ? [] : [input.vmmUid])]) if (!Number.isSafeInteger(id) || id < 1 || id > 4294967294) throw new Error("invalid_s15_unit");
  const p = s15Installation, memory = `${Math.max(256, Math.floor(input.memoryMaxBytes / MiB))}M`, vmm = input.vmmUid;
  // Without a Jit-managed VM there is no QEMU identity, no sudo and no proxy socket, so privileges stay closed.
  const ordering = vmm === null ? `After=network-online.target user@${input.uid}.service\nWants=network-online.target user@${input.uid}.service`
    : `After=network-online.target user@${input.uid}.service user@${vmm}.service ${p.proxySocket}\nWants=network-online.target user@${input.uid}.service user@${vmm}.service\nRequires=${p.proxySocket}`;
  return `# Rendered by install.sh --s15 (ops.installer/v1). Re-run the installer to repair; do not edit.
[Unit]
Description=Jit S15 controller
Documentation=https://github.com/chayapats/jit/blob/main/docs/runbooks/s15-install.md
After=systemd-journald@${p.journal}.service
${ordering}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${p.user}
Group=${p.user}
WorkingDirectory=${p.home}/work
ExecStart=${p.prefix}/bin/bun ${p.prefix}/current/src/main.ts serve --s15 --config ${p.config}
${vmm === null ? "" : `Sockets=${p.proxySocket}\n`}Environment=HOME=${p.home}
Environment=XDG_RUNTIME_DIR=/run/user/${input.uid}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${input.uid}/bus
Restart=on-failure
RestartSec=10
TimeoutStartSec=120
TimeoutStopSec=60
KillMode=mixed
KillSignal=SIGTERM
MemoryMax=${memory}
TasksMax=512
LimitNOFILE=8192
${vmm === null ? "NoNewPrivileges=true" : `# VM15-03: sudo to ${p.vmmUser} runs only ${p.launcher}; see docs/runbooks/s15-install.md.`}
PrivateTmp=true
ProtectSystem=strict
ProtectHome=tmpfs
BindPaths=/run/user/${input.uid}
${vmm === null ? "" : `BindPaths=/run/user/${vmm}\n`}ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=${p.home}${vmm === null ? "" : ` ${p.vmmRoot}`}
UMask=0077
LogNamespace=${p.journal}
LogRateLimitIntervalSec=30s
LogRateLimitBurst=1000

[Install]
WantedBy=multi-user.target
`;
}

/**
 * The working VM's registry-proxy socket, bound by systemd in the host's root mount namespace and passed to the
 * controller as `jit-s15-vm-proxy`. A socket the hardened controller bound itself would sit in the unit's private
 * mount namespace, where AppArmor's `nc.openbsd` profile refuses the guest-forward helper's connect
 * ("disconnected path"). Only the shared group (the QEMU identity) can connect besides the controller. It starts
 * with the controller and stops with it (PartOf), so guest traffic never starts a stopped controller.
 */
export function renderS15ProxySocket(): string {
  const p = s15Installation, layout = vmmLayout(p.vmmRoot);
  return `# Rendered by install.sh --s15 (VM15-03). Re-run the installer to repair; do not edit.
[Unit]
Description=Jit S15 working-VM registry proxy socket
PartOf=${p.service}

[Socket]
ListenStream=${layout.proxySocket}
FileDescriptorName=${vmmProxySocketName}
SocketUser=${p.user}
SocketGroup=${p.group}
SocketMode=0660
RemoveOnStop=yes
Service=${p.service}
`;
}

/** Bounded journald namespace for the controller (size from the host disk, 14 days). */
export function renderS15Journald(logBytes: number): string {
  return `# journald namespace for jit-s15.service (LogNamespace=${s15Installation.journal}), rendered by install.sh --s15.
[Journal]
Storage=persistent
SystemMaxUse=${logBytes}
SystemMaxFileSize=${Math.max(65536, Math.floor(logBytes / 8))}
MaxRetentionSec=14day
RateLimitIntervalSec=30s
RateLimitBurst=1000
`;
}

/** The sudoers drop-in: the controller may run exactly the launcher, as exactly the QEMU identity, nothing else. */
export function renderS15Sudoers(): string {
  const p = s15Installation;
  return `# Managed by install.sh --s15 (VM15-03). The S15 controller may run only the fixed working-VM launcher as its QEMU identity.\n${p.user} ALL=(${p.vmmUser}) NOPASSWD: ${p.launcher}\n`;
}

/**
 * CLI arguments (after `src/main.ts`) that issue the first-owner link over the private fd 3 pipe.
 * They must satisfy `selectRuntime`'s S15 `owner-link` spelling, which requires `--output-fd 3`.
 */
export function s15OwnerLinkArguments(configPath: string): string[] {
  return ["owner-link", "--s15", "--config", configPath, "--output-fd", "3"];
}

/** Durable-job projection the installer prints. `fallback` means this host cannot create the computer itself. */
export type S15ComputerProgress =
  | { state: "running"; step: string; history: string[] }
  | { state: "enrolled" }
  | { state: "failed"; step: string; code: string }
  | { state: "none"; host: string };

/**
 * Service-identity helper (`main.ts s15-computer`): reads the automatic working-computer job from the protected
 * VM journal read-only while the controller runs it, and the host readiness when no job exists. It never opens
 * the composition, so it cannot recover or take over anything the running controller owns.
 */
export function readS15ComputerProgress(configPath: string): S15ComputerProgress {
  if (process.getuid?.() === 0) throw new Error("service-identity-required");
  const config = readS15RuntimeConfig(configPath), runtime = join(config.directory, "runtime");
  let row: { state: string; step: string; failedStep: string | null; error: string | null; history?: { step: string }[] } | null = null;
  const path = join(runtime, "vm.sqlite");
  if (existsSync(path)) {
    const db = new Database(path, { readonly: true });
    try {
      const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='vm_provisioning'").get();
      const found = table ? db.query<{ data: string }, [string]>("SELECT data FROM vm_provisioning WHERE id=?").get(config.vm.id) : null;
      if (found) row = JSON.parse(found.data);
    } finally { db.close(); }
  }
  if (!row) {
    const probe = config.vm.vmm ? vmmHostProbe(config.vm.vmm) : undefined, host = probeLocalVmHost(join(runtime, "vm-local"), probe);
    return { state: "none", host: host.state === "ready" ? "ready" : host.code };
  }
  if (row.state === "enrolled") return { state: "enrolled" };
  if (row.state === "failed") return { state: "failed", step: row.failedStep ?? row.step, code: /^[a-z0-9_]{1,64}$/.test(row.error ?? "") ? row.error! : "vm_provisioning_failed" };
  return { state: "running", step: row.step, history: (row.history ?? []).map(entry => entry.step) };
}

/** PIDs of QEMU processes whose real uid is `uid`, read from the kernel's `/proc` (never from a user manager). */
export function s15QemuProcesses(uid: number, proc = "/proc"): number[] {
  const found: number[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(proc); } catch { return found; }
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const owner = /^Uid:\s+([0-9]+)/m.exec(readFileSync(join(proc, name, "status"), "utf8"))?.[1];
      const argv0 = readFileSync(join(proc, name, "cmdline"), "utf8").split("\0")[0] ?? "";
      if (Number(owner) === uid && /^\/usr\/bin\/qemu-system-[a-z0-9_]+$/.test(argv0)) found.push(Number(name));
    } catch { /* The process exited meanwhile. */ }
  }
  return found;
}

/**
 * Stops every working VM of the QEMU identity and proves it before uninstall may report success: the stop
 * command succeeded, its user manager lists no `jit-work-*` unit that is still active, and the kernel lists no
 * QEMU process owned by that identity. A manager that is not running cannot run a unit, but the process check
 * still applies. Returns what is left; an empty `remaining` with `stopped` is the only success.
 */
export async function stopS15WorkingVms(input: { vmmUid: number; call(argv: string[], timeoutMs?: number): Promise<CommandResult>; qemuProcesses?: (uid: number) => number[] }): Promise<{ stopped: boolean; remaining: string[] }> {
  const p = s15Installation, asVmm = (args: string[]) => ["runuser", "-u", p.vmmUser, "--", "env", `XDG_RUNTIME_DIR=/run/user/${input.vmmUid}`, ...args];
  const remaining: string[] = [];
  let commands = true;
  const manager = (await input.call(["systemctl", "is-active", `user@${input.vmmUid}.service`], 30_000)).stdout.trim();
  if (["active", "activating", "reloading", "deactivating"].includes(manager)) {
    const stop = await input.call(asVmm(["systemctl", "--user", "stop", "jit-work-*.service"]), 120_000);
    if (stop.exitCode !== 0 || stop.timedOut) commands = false;
    const listed = await input.call(asVmm(["systemctl", "--user", "list-units", "--type=service", "--all", "--plain", "--no-legend", "jit-work-*.service"]), 30_000);
    if (listed.exitCode !== 0 || listed.timedOut) commands = false;
    for (const line of listed.stdout.split("\n")) {
      const [unit, , active] = line.trim().split(/\s+/);
      if (unit && /^jit-work-[a-f0-9]{12}\.service$/.test(unit) && active && !["inactive", "failed"].includes(active)) remaining.push(unit);
    }
  }
  for (const pid of (input.qemuProcesses ?? s15QemuProcesses)(input.vmmUid)) remaining.push(`QEMU pid ${pid}`);
  return { stopped: commands && !remaining.length, remaining };
}

/** Installer options; all writes stay below `root`, and a dry run never runs a host command. */
export interface S15InstallerOptions {
  root: string; facts: HostFacts; source: string; bunPath: string; uninstall?: boolean; dryRun?: boolean;
  run?: CommandRunner; out?: (line: string) => void;
  /** Deterministic waits for health and working-computer polling. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Dry runs only: prepares the private first-owner link (deterministic tests). Real runs capture it through the
   * trusted `owner-link --s15` CLI on private fd 3 before the controller starts and show it on `/dev/tty`.
   */
  ownerLink?: () => Promise<PendingOwnerLink>;
  /** Fake-root scenarios only; production ignores them. */
  simulation?: {
    failStep?: string; release?: string; serviceActive?: boolean;
    /** `false`: the host has no `kvm` group, so the controller is installed without a Jit-managed VM. */
    kvmGroup?: boolean;
    /** Uninstall read-back: the VM stop's exit code, the identity's `list-units` output and live QEMU pids. */
    vmStop?: { exitCode: number; listed: string; processes: number[] };
    /** Health results consumed in order (new release first, then a rollback's re-check). */
    health?: boolean[];
    /** Runs where a real controller would start (after the release switch), e.g. to change state as a new release would. */
    started?: () => void;
    computer?: S15ComputerProgress[];
  };
}

/** Installer result: the steps taken, the configuration in force and the working-computer outcome. */
export interface S15InstallerResult { events: string[]; config: S15RuntimeConfig | null; computer: S15ComputerProgress | null; release: string | null; rolledBack: boolean }

const stepCopy = (step: string) => {
  const key = `s15.provision.step.${step}` as keyof typeof en;
  return en[key] ? `${en[key]} / ${th[key as keyof typeof th]}` : step;
};
const codeCopy = (code: string) => {
  const reason = `s15.code.${code}` as keyof typeof en, next = `s15.provision.next.${code}` as keyof typeof en;
  return [en[reason] ?? code, en[next] ?? "Open Resources → Computer in the Web UI and press Try again."].join(" ");
};

/**
 * Applies the approved S15 plan. Fresh install: dedicated controller and QEMU identities, protected directories,
 * the Secret Service user manager, the argv-fixed VM launcher with its sudoers rule, a frozen release, the generated
 * config, `init --s15`, the hardened unit and the release symlink, start and health, the private first-owner link
 * (at once, within its 15-minute lifetime), then the automatic working computer (progress printed). A host without
 * a `kvm` group gets the controller alone and the owner-supplied VM fallback. Re-runs repair idempotently and
 * preserve config and state; uninstall removes units only after a proven working-VM stop. Upgrades stop the controller (the VM keeps running), switch the release atomically and roll back to
 * the previous release and unit when the new one fails to start or answer health. A failed fresh install
 * removes the new unit and anything it initialized, leaving a cleanly re-runnable host. Other installations
 * (`jit`, `jit-s14`) are never read or changed.
 */
export async function runS15Installer(options: S15InstallerOptions): Promise<S15InstallerResult> {
  const p = s15Installation, dry = options.dryRun === true, events: string[] = [], out = options.out ?? (() => {});
  const root = dry ? realpathSync(resolve(options.root)) : resolve(options.root);
  if (dry ? root === "/" || !isAbsolute(options.root) : root !== "/" || process.platform !== "linux" || process.getuid?.() !== 0) throw new InstallerFailure("host", "use Linux root, or --dry-run with a disposable absolute --root");
  const defaults: InstallerDefaults = installerDefaults(options.facts);
  const at = (path: string) => root === "/" ? path : join(root, path);
  const safe = (path: string) => {
    if (root !== "/" && !path.startsWith(root + "/")) throw new InstallerFailure("paths", "use a path inside the fake root");
    for (let parent = path; parent !== dirname(parent); parent = dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) throw new InstallerFailure("paths", "replace the unexpected symlink before re-running"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dry && parent === root) break;
    }
  };
  const own = (path: string, mode: number, uid?: number, gid?: number) => {
    safe(path); mkdirSync(path, { recursive: true, mode: mode & 0o777 });
    if (!lstatSync(path).isDirectory()) throw new InstallerFailure(currentStep, next);
    if (!dry && uid !== undefined && gid !== undefined) chownSync(path, uid, gid);
    // chmod after chown: setgid must survive and the installer's umask must not narrow the mode.
    chmodSync(path, mode);
  };
  const write = (path: string, text: string, mode = 0o600, owner?: { uid: number; gid: number }) => {
    safe(path); safe(dirname(path)); mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    const temp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(temp, text, { flag: "wx", mode }); chmodSync(temp, mode);
      if (!dry && owner) chownSync(temp, owner.uid, owner.gid);
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
  };
  const read = (path: string) => { safe(path); return existsSync(path) ? readFileSync(path, "utf8") : null; };
  const runner = options.run ?? spawnRunner, sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const run: CommandRunner = (argv, settings) => runner(argv, { ...settings, cwd: settings.cwd ?? "/", env: settings.env ?? { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } });
  const call = async (argv: string[], timeoutMs = 120_000) => {
    if (dry) throw new Error("dry_run_host_command");
    try { return await run(argv, { timeoutMs }); }
    catch { return { exitCode: 127, stdout: "", timedOut: false }; }
  };
  let currentStep = "configuration", next = "inspect /etc/jit-s15 and re-run install.sh --s15";
  const step = (name: string, action: string) => {
    currentStep = name; next = action; events.push(name); out(`Step: ${name}`);
    if (dry && options.simulation?.failStep === name) throw new InstallerFailure(name, action);
  };
  const must = async (argv: string[], timeoutMs?: number) => {
    const result = await call(argv, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut) throw new InstallerFailure(currentStep, next);
    return result.stdout;
  };
  const health = [...(options.simulation?.health ?? [])], computers = [...(options.simulation?.computer ?? [])];
  const paths = { home: at(p.home), state: at(p.state), vmmHome: at(p.vmmHome), vmmRoot: at(p.vmmRoot), prefix: at(p.prefix), releases: at(join(p.prefix, "releases")), current: at(join(p.prefix, "current")),
    libexec: at(join(p.prefix, "libexec")), launcher: at(p.launcher), configDir: at(p.configDir), config: at(p.config), installerState: at(p.installerState), sudoers: at(p.sudoers), unit: at(p.unit), journald: at(p.journald), socket: at(p.proxySocketUnit) };
  const layout = vmmLayout(paths.vmmRoot);
  if (!dry) {
    try {
      for (const path of [paths.config, options.bunPath, paths.releases, paths.launcher, paths.sudoers, paths.unit, paths.journald, paths.socket, paths.vmmRoot]) assertRootPath(path);
      assertRootTree(resolve(options.source));
    } catch { throw new InstallerFailure("trusted-paths", "use root-owned executable/config/system parents without symlinks or group/other write, then re-run from a trusted release"); }
  }
  // Fake-root identities; real runs read them from the account database.
  let uid = 1001, gid = 1001, vmmUid = 1002, sharedGid = 1003, kvmGid = 992;
  const asUser = (args: string[]) => ["runuser", "-u", p.user, "--", "env", `HOME=${p.home}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...args];
  const vmmOptions = () => ({ user: p.vmmUser, uid: vmmUid, directory: p.vmmRoot, launcher: p.launcher });
  let ownedStaging: string | null = null, frozenContainer: string | null = null, ownerTerminal: ReturnType<typeof operatorTerminal> | undefined, pendingOwner: PendingOwnerLink | undefined;
  let release: string | null = null, config: S15RuntimeConfig | null = null, createdState = false, armed = false, committed = false;
  let previous: { release: string | null; unit: string | null; journald: string | null; socket: string | null; active: boolean; manifest: string | null } | null = null;
  const manifestPath = join(paths.state, "runtime/composition.json");
  const currentTarget = () => { try { return lstatSync(paths.current).isSymbolicLink() ? resolve(dirname(paths.current), readlinkSync(paths.current)) : null; } catch { return null; } };
  // The active-release link is the one symlink the installer manages; its parent must not be a link.
  const link = (path: string) => { safe(dirname(path)); const stat = lstatSync(path, { throwIfNoEntry: false }); if (stat && !stat.isSymbolicLink()) throw new InstallerFailure("paths", `move the non-link ${path.slice(root === "/" ? 0 : root.length)} aside, then re-run install.sh --s15`); };
  const switchCurrent = (target: string) => {
    link(paths.current); const temp = join(dirname(paths.current), `.current.next-${randomBytes(6).toString("hex")}`);
    symlinkSync(target, temp);
    try { renameSync(temp, paths.current); } catch (error) { rmSync(temp, { force: true }); throw error; }
  };
  const healthy = async (deadlineMs = 30_000): Promise<boolean> => {
    if (dry) return health.shift() ?? true;
    const origin = config!.origin, binding = personalServiceBinding(origin), host = binding.hostname.includes(":") ? `[${binding.hostname}]` : binding.hostname;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${host}:${binding.port}/s14/login`, { headers: { host: new URL(origin).host }, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
        if (response.status === 200) return true;
      } catch { /* Not listening yet. */ }
      await sleep(500);
    }
    return false;
  };
  try {
    if (options.uninstall) {
      step("uninstall", `stop ${p.service} with systemctl, then re-run install.sh --s15 --uninstall`);
      if (!dry && existsSync(paths.unit)) {
        await call(["systemctl", "disable", "--now", p.service]);
        const state = (await call(["systemctl", "is-active", p.service])).stdout.trim();
        if (state === "active" || state === "activating" || state === "deactivating") throw new InstallerFailure(currentStep, next);
      }
      // Working VMs stop cleanly and the stop is proven before anything is removed; their disks, snapshots and
      // keys are retained for a later re-install. A host without the QEMU identity has no Jit-managed VM.
      const simulated = options.simulation?.vmStop;
      let vmmId: number | null = dry && simulated ? 1002 : null;
      if (!dry) { const vmm = await call(["getent", "passwd", p.vmmUser]), id = Number(vmm.stdout.split(":")[2]); if (vmm.exitCode === 0 && Number.isSafeInteger(id) && id > 0) vmmId = id; }
      if (vmmId !== null) {
        const fake = async (argv: string[]): Promise<CommandResult> => ({ timedOut: false, exitCode: argv.includes("stop") ? simulated!.exitCode : 0,
          stdout: argv[1] === "is-active" ? "active\n" : argv.includes("list-units") ? simulated!.listed : "" });
        const vms = await stopS15WorkingVms({ vmmUid: vmmId, call: dry ? fake : call, ...(dry ? { qemuProcesses: () => simulated!.processes } : {}) });
        if (!vms.stopped) throw new InstallerFailure(currentStep, `${p.service} is stopped and disabled, but a working VM of ${p.vmmUser} is still running (${vms.remaining.join(", ") || "its stop did not finish"}). Stop it with: sudo runuser -u ${p.vmmUser} -- env XDG_RUNTIME_DIR=/run/user/${vmmId} systemctl --user stop 'jit-work-*.service'; confirm that systemctl --user list-units 'jit-work-*' shows none active and no qemu-system process of ${p.vmmUser} remains, then re-run install.sh --s15 --uninstall. No unit file was removed`);
      }
      if (!dry) {
        const ctl = await call(["getent", "passwd", p.user]), ctlId = Number(ctl.stdout.split(":")[2]);
        if (ctl.exitCode === 0 && Number.isSafeInteger(ctlId) && ctlId > 0) {
          uid = ctlId;
          await call(asUser(["systemctl", "--user", "disable", "--now", "gnome-keyring-daemon.service"]));
        }
      }
      for (const path of [paths.unit, paths.journald, paths.socket, join(paths.home, ".config/systemd/user/gnome-keyring-daemon.service")]) { safe(path); rmSync(path, { force: true }); }
      if (!dry) await call(["systemctl", "daemon-reload"]);
      out("Uninstalled jit-s15.service. Identities, linger, packages, Bun, releases, launcher, sudoers rule, config, state, working-VM disks and keyring are retained. Legacy and S14 installations were not touched.");
      return { events, config: null, computer: null, release: currentTarget(), rolledBack: false };
    }

    // A file at the S15 config path that is not this installer's S15 config is refused before any change.
    step("preflight", `move the file at ${p.config} aside (it is not an s15-runtime/v1 config for ${p.state}), then re-run install.sh --s15`);
    const existing = read(paths.config);
    let preserved: S15RuntimeConfig | null = null;
    if (existing !== null) {
      try { preserved = parseS15RuntimeConfig(JSON.parse(existing)); } catch { throw new InstallerFailure(currentStep, next); }
      if (preserved.directory !== p.state || preserved.vm.local === true && !preserved.vm.vmm) throw new InstallerFailure(currentStep, next);
    }
    // Local VM support: kept once installed; added when the host gains a kvm group (QEMU/KVM packages).
    let local = preserved?.vm.local === true;

    step("disk-reserve", "free disk space above the displayed reserve plus 512 MiB staging space, then re-run install.sh --s15");
    const disk = dry ? null : statfsSync(existsSync(paths.home) ? paths.home : "/var/lib");
    if ((disk ? disk.bavail * disk.bsize : options.facts.freeBytes) < defaults.diskReserveBytes + 512 * MiB) throw new InstallerFailure(currentStep, next);

    step("identity", `provide the non-login ${p.user} and ${p.vmmUser} identities, the ${p.group} group and the kvm group (install qemu-system-* if kvm is missing), then re-run install.sh --s15`);
    if (dry) local ||= options.simulation?.kvmGroup !== false;
    else {
      const passwd = async (name: string) => { const r = await call(["getent", "passwd", name]); if (r.exitCode !== 0) return null; const f = r.stdout.trim().split(":"); return { name: f[0], uid: Number(f[2]), gid: Number(f[3]), home: f[5], shell: f[6] ?? "" }; };
      const group = async (name: string) => { const r = await call(["getent", "group", name]); if (r.exitCode !== 0) return null; const f = r.stdout.trim().split(":"); return { name: f[0], gid: Number(f[2]) }; };
      const valid = (id: number) => Number.isSafeInteger(id) && id > 0 && id < 4294967295;
      const kvm = await group("kvm");
      if (kvm && !valid(kvm.gid)) throw new InstallerFailure(currentStep, next);
      // No kvm group (no QEMU/KVM packages or virtualization): install the controller alone; the owner enrolls a VM.
      local ||= !!kvm;
      if (!await passwd(p.user)) await must(["useradd", "--system", "--create-home", "--home-dir", p.home, "--shell", "/usr/sbin/nologin", "--user-group", p.user]);
      const ctl = await passwd(p.user);
      if (!ctl || ctl.name !== p.user || !valid(ctl.uid) || !valid(ctl.gid) || ctl.home !== p.home || !/\/(nologin|false)$/.test(ctl.shell)) throw new InstallerFailure(currentStep, next);
      uid = ctl.uid; gid = ctl.gid;
      const groupsOf = async (name: string) => (await must(["id", "-nG", name])).trim().split(/\s+/);
      const ctlGroups = await groupsOf(p.user);
      // The controller never needs KVM.
      if (ctlGroups.includes("kvm")) await must(["gpasswd", "-d", p.user, "kvm"]);
      if (local) {
        if (!await group(p.group)) await must(["groupadd", "--system", p.group]);
        const shared = await group(p.group);
        if (!shared || !valid(shared.gid)) throw new InstallerFailure(currentStep, next);
        if (!await passwd(p.vmmUser)) await must(["useradd", "--system", "--create-home", "--home-dir", p.vmmHome, "--shell", "/usr/sbin/nologin", "--gid", p.group, p.vmmUser]);
        const vmm = await passwd(p.vmmUser);
        if (!vmm || vmm.name !== p.vmmUser || !valid(vmm.uid) || vmm.gid !== shared.gid || vmm.home !== p.vmmHome || !/\/(nologin|false)$/.test(vmm.shell) || vmm.uid === ctl.uid) throw new InstallerFailure(currentStep, next);
        vmmUid = vmm.uid; sharedGid = shared.gid; kvmGid = kvm?.gid ?? -1;
        const vmmGroups = await groupsOf(p.vmmUser);
        if (kvm && !vmmGroups.includes("kvm")) await must(["usermod", "-a", "-G", "kvm", p.vmmUser]);
        if (!ctlGroups.includes(p.group)) await must(["usermod", "-a", "-G", p.group, p.user]);
        // The QEMU identity is never in the controller's own group.
        if (vmmGroups.includes(p.user)) await must(["gpasswd", "-d", p.vmmUser, p.user]);
        if (!kvm) out(`Working computer: this host no longer has a kvm group; ${p.vmmUser} keeps its VMs but cannot start them until the QEMU/KVM packages are reinstalled.`);
      }
    }

    step("directories", "remove unexpected symlinks or repair directory ownership under /var/lib/jit-s15, /var/lib/jit-s15-vm and /opt/jit-s15, then re-run install.sh --s15");
    own(paths.home, 0o700, uid, gid);
    if (local) {
      own(paths.vmmHome, 0o700, vmmUid, sharedGid);
      own(paths.vmmRoot, 0o750, 0, sharedGid); own(layout.control, 0o2750, uid, sharedGid); own(layout.images, 0o2750, uid, sharedGid); own(layout.machines, 0o2750, vmmUid, sharedGid);
    }
    for (const path of [paths.prefix, join(paths.prefix, "bin"), paths.releases, paths.libexec]) own(path, 0o755, 0, 0);
    own(paths.configDir, 0o750, 0, gid);

    step("keyring", `repair the ${p.user} user manager and Secret Service (its unlock file and keyring are preserved), then re-run install.sh --s15`);
    if (dry) {
      for (const path of ["work", ".config/systemd/user", ".local/share/keyrings", ".schway"]) own(join(paths.home, path), 0o700);
      const unlock = join(paths.home, "keyring-unlock"); if (!existsSync(unlock)) write(unlock, randomBytes(32).toString("hex"));
    } else {
      await must(asUser([options.bunPath, join(resolve(options.source), "ops/package/installer/main.ts"), "prepare-home", "--home", p.home, "--s15", "true"]));
      await must(["loginctl", "enable-linger", p.user]);
      await must(["systemctl", "start", `user@${uid}.service`]);
      await must(asUser(["systemctl", "--user", "daemon-reload"]));
      await must(asUser(["systemctl", "--user", "enable", "--now", "gnome-keyring-daemon.service"]));
      const locked = await must(asUser(["busctl", "--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/collection/login", "org.freedesktop.Secret.Collection", "Locked"]));
      if (locked.trim() !== "b false") throw new InstallerFailure(currentStep, next);
    }

    step("vm-identity", `repair ${p.vmmUser}'s lingering user manager, ${p.launcher} and ${p.sudoers} (sudo and visudo are required), then re-run install.sh --s15`);
    if (!dry && local) {
      await must(["loginctl", "enable-linger", p.vmmUser]);
      await must(["systemctl", "start", `user@${vmmUid}.service`]);
      // A running user manager keeps the groups it started with. Restart it only when it lacks kvm or the shared
      // group: no working VM can be running under it then, so nothing is interrupted.
      const managerPid = Number((await must(["systemctl", "show", "--property=MainPID", "--value", `user@${vmmUid}.service`])).trim());
      if (Number.isSafeInteger(managerPid) && managerPid > 0) {
        let status = ""; try { status = readFileSync(`/proc/${managerPid}/status`, "utf8"); } catch { /* Gone: restarted below. */ }
        const groups = (/^Groups:\s*(.*)$/m.exec(status)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
        const primary = Number(/^Gid:\s+([0-9]+)/m.exec(status)?.[1]);
        if (kvmGid >= 0 && !groups.includes(kvmGid) || primary !== sharedGid) await must(["systemctl", "restart", `user@${vmmUid}.service`]);
      }
    }
    if (local) {
      write(paths.launcher, renderVmmLauncher(vmmOptions()), 0o755, { uid: 0, gid: 0 });
      // A name containing a dot is ignored by sudo, so the rule is parsed only after visudo accepted it.
      // Never change an existing system directory's mode; only create a missing one.
      if (!existsSync(dirname(paths.sudoers))) own(dirname(paths.sudoers), 0o750, 0, 0);
      if (!dry) { try { assertRootPath(dirname(paths.sudoers)); } catch { throw new InstallerFailure(currentStep, next); } }
      const sudoersTemp = join(dirname(paths.sudoers), `.jit-s15-vmm.${randomBytes(6).toString("hex")}`);
      try {
        safe(sudoersTemp); writeFileSync(sudoersTemp, renderS15Sudoers(), { flag: "wx", mode: 0o440 }); chmodSync(sudoersTemp, 0o440);
        if (!dry) { chownSync(sudoersTemp, 0, 0); await must(["visudo", "-c", "-q", "-f", sudoersTemp]); }
        renameSync(sudoersTemp, paths.sudoers);
      } finally { rmSync(sudoersTemp, { force: true }); }
    }
    if (!dry && local) {
      const ready = await must(["runuser", "-u", p.user, "--", ...vmmCommand(vmmOptions(), ["check"])]);
      if (ready.trim() !== "jit-vmm-ready-v1") throw new InstallerFailure(currentStep, `make /etc/sudoers include /etc/sudoers.d so ${p.user} can run ${p.launcher} as ${p.vmmUser}, then re-run install.sh --s15`);
      if ((await call(["runuser", "-u", p.user, "--", ...vmmCommand(vmmOptions(), ["kvm"])])).exitCode !== 0)
        out(`Working computer: ${codeCopy(existsSync("/dev/kvm") ? "vm_kvm_denied" : "vm_kvm_unavailable")}`);
    }

    step("artifact", "verify the release archive, Bun pins and registry access, then re-run install.sh --s15");
    if (dry) {
      release = join(paths.releases, options.simulation?.release ?? "dry-run-release");
      own(release, 0o755); write(join(release, "release.json"), JSON.stringify({ release: options.simulation?.release ?? "dry-run-release" }), 0o644);
    } else {
      let artifact = resolve(options.source);
      const staging = join(paths.prefix, `staging-${randomBytes(8).toString("hex")}`); ownedStaging = staging;
      if (existsSync(join(artifact, "manifest.json"))) cpSync(artifact, staging, { recursive: true });
      else buildPackage({ srcDir: artifact, outDir: staging, engineContract: "jit.schway.bridge/v1", engineRevision: null });
      artifact = staging;
      const expected = validateArtifact(artifact);
      if (!expected.ok || !expected.manifest) throw new InstallerFailure(currentStep, next);
      const dependenciesReady = validateArtifact(artifact, { runtime: true }).ok;
      giveInstallerStaging(artifact, uid, gid);
      if (!dependenciesReady) await must(asUser([options.bunPath, join(resolve(options.source), "ops/package/bun-build.ts"), "install-deps", artifact]), 600_000);
      const frozen = freezeInstallerArtifact(artifact, paths.releases, expected.manifest); frozenContainer = frozen.container;
      const checked = validateArtifact(frozen.artifact, { runtime: true });
      if (!checked.ok || !checked.manifest) throw new InstallerFailure(currentStep, next);
      const target = join(paths.releases, checked.manifest.artifactId);
      assertRootPath(target);
      if (existsSync(target)) {
        // An identical earlier release is reused; a different tree under the same id is refused.
        assertRootTree(target); const existing = validateArtifact(target, { runtime: true });
        if (!existing.ok || existing.manifest?.contentHash !== checked.manifest.contentHash) throw new InstallerFailure(currentStep, next);
      } else renameSync(frozen.artifact, target);
      if (!await releaseReadableByService(run, p.user, target)) throw new InstallerFailure(currentStep, `make ${target} readable by ${p.user}, then re-run install.sh --s15`);
      release = target;
    }

    step("configuration", `repair ${p.config} (root:${p.user} 0640), then re-run install.sh --s15`);
    if (read(paths.config) !== existing) throw new InstallerFailure(currentStep, "another process changed the S15 config during installation; re-run install.sh --s15");
    // The QEMU identity's uid is installer-owned; it is refreshed if the identity was recreated. Everything else is preserved.
    if (preserved) {
      // Only the installer-owned `local`/`vmm` change, in place, so an unchanged config stays byte-identical.
      const vm: Record<string, unknown> = {}, placeLocal = () => { vm.local = local; if (local) vm.vmm = vmmOptions(); };
      for (const [key, value] of Object.entries(preserved.vm)) { if (key === "local") placeLocal(); else if (key !== "vmm") vm[key] = value; }
      if (!("local" in vm)) placeLocal();
      config = parseS15RuntimeConfig({ ...preserved, vm });
    } else config = s15InstallerConfig({ installationId: `s15_${randomBytes(8).toString("hex")}`, vmm: local ? vmmOptions() : null });
    const configText = JSON.stringify(config, null, 2) + "\n";
    if (configText !== existing) write(paths.config, configText, 0o640, { uid: 0, gid });
    else if (!dry) { chownSync(paths.config, 0, gid); chmodSync(paths.config, 0o640); }

    step("owner-terminal", "re-run install.sh --s15 from an operator terminal (for SSH use ssh -t); nothing has been stopped or changed in the running service");
    if (!dry) { try { ownerTerminal = operatorTerminal(); } catch { throw new InstallerFailure(currentStep, next); } }

    // An upgrade or repair stops the controller (and, through PartOf, its proxy socket) before anything else changes.
    if (existsSync(paths.unit)) {
      step("service-stop", `inspect journalctl --namespace=${p.journal} -u ${p.service}, then re-run install.sh --s15; the working VM keeps running`);
      const active = dry ? options.simulation?.serviceActive !== false : ["active", "activating", "reloading"].includes((await call(["systemctl", "is-active", p.service])).stdout.trim());
      previous = { release: currentTarget(), unit: read(paths.unit), journald: read(paths.journald), socket: read(paths.socket), active, manifest: null };
      armed = true;
      if (!dry && active) {
        await must(["systemctl", "stop", p.service], 120_000);
        if (["active", "activating", "deactivating"].includes((await call(["systemctl", "is-active", p.service])).stdout.trim())) throw new InstallerFailure(currentStep, next);
      }
      // A newer release may add a store to the runtime's composition manifest (BROW15-02 `browser.sqlite`), and an
      // earlier release refuses a manifest it does not know. Keep the stopped release's manifest so a rollback here
      // restores it, and a copy per release for the documented rollback by hand (s15-install.md).
      previous.manifest = read(manifestPath);
      const releaseId = previous.release ? basename(previous.release) : null;
      if (previous.manifest !== null && releaseId && /^[A-Za-z0-9._-]{1,128}$/.test(releaseId)) write(join(paths.configDir, `composition.${releaseId}.json`), previous.manifest, 0o640, { uid: 0, gid });
    }

    step("state-initialize", `repair ${p.state} ownership and re-run install.sh --s15; existing state is never re-initialized`);
    const marker = manifestPath;
    if (existsSync(paths.state) && !existsSync(marker)) {
      // An initialization interrupted before it finished has no owner and no work; keep it aside, never delete it.
      const aside = `${paths.state}.interrupted-${Date.now()}`; safe(aside); renameSync(paths.state, aside);
      out(`Moved an unfinished, owner-less initialization aside to ${aside.slice(root === "/" ? 0 : root.length)}.`);
    }
    if (!existsSync(paths.state)) {
      createdState = true;
      if (dry) { own(join(paths.state, "runtime"), 0o700); write(marker, JSON.stringify({ contract: "s15-composition/v1" })); }
      else {
        const initialized = await must(asUser([options.bunPath, join(release!, "src/main.ts"), "init", "--s15", "--config", p.config]), 300_000);
        if (!initialized.includes('"state":"s15_initialized"')) throw new InstallerFailure(currentStep, next);
      }
    }

    step("owner-link-prepare", "repair the S15 owner store and the private fd 3 delivery, then re-run install.sh --s15 from the operator terminal; no link is printed before health");
    if (dry && options.ownerLink) pendingOwner = await options.ownerLink();
    if (!dry) {
      const terminal = ownerTerminal!; ownerTerminal = undefined;
      pendingOwner = await prepareS14OwnerLink(asUser([options.bunPath, join(release!, "src/main.ts"), ...s15OwnerLinkArguments(p.config)]),
        { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, config.origin, { capture: captureOwnerPipe, terminal: () => terminal });
    }

    armed = true;
    step("service-install", `inspect ${p.unit} and the journald namespace, then re-run install.sh --s15`);
    write(paths.unit, renderS15Unit({ uid, vmmUid: local ? vmmUid : null, memoryMaxBytes: defaults.memoryMaxBytes }), 0o644, { uid: 0, gid: 0 });
    write(paths.journald, renderS15Journald(defaults.logBytes), 0o644, { uid: 0, gid: 0 });
    if (local) {
      write(paths.socket, renderS15ProxySocket(), 0o644, { uid: 0, gid: 0 });
      // The socket unit binds the path itself; a socket file left by `init --s15` (or a crash) is removed first.
      const stale = lstatSync(layout.proxySocket, { throwIfNoEntry: false });
      if (stale?.isSocket() && (dry || (await call(["systemctl", "is-active", p.proxySocket])).stdout.trim() !== "active")) rmSync(layout.proxySocket, { force: true });
    }
    switchCurrent(release!);
    if (!dry) { await must(["systemctl", "daemon-reload"]); await must(["systemctl", "enable", p.service]); }

    step("service-start", `inspect journalctl --namespace=${p.journal} -u ${p.service}, fix the named gate and re-run install.sh --s15`);
    if (!dry) await must(["systemctl", "start", p.service], 180_000);
    else options.simulation?.started?.();

    step("health", `inspect journalctl --namespace=${p.journal} -u ${p.service}; the login page did not answer on ${config.origin}`);
    if (!await healthy()) throw new InstallerFailure(currentStep, next);
    committed = true;
    write(paths.installerState, JSON.stringify({ contract: "ops.installer/v1", runtime: "s15", release: release!.slice(root === "/" ? 0 : root.length), hardware: options.facts, defaults }, null, 2) + "\n", 0o640, { uid: 0, gid });

    // The single-use link lives 15 minutes from preparation, so it is shown as soon as the controller is healthy,
    // never after the working computer's setup, which can take much longer (image download, first boot, Docker).
    step("owner-link", "re-run install.sh --s15 from the operator terminal; an existing owner is never reset");
    pendingOwner?.deliver();

    // The controller owns the automatic job (SETUP15-01); the installer only reads its durable progress.
    step("working-computer", "open Resources → Computer in the Web UI for the stated reason; the controller stays installed");
    let computer: S15ComputerProgress | null = local ? null : { state: "none", host: "vm_kvm_unavailable" };
    // Polls every 2 s: up to 90 s for the controller's boot pass to start the job, then up to 90 minutes overall.
    const printed = new Set<string>();
    for (let poll = 0; local; poll++) {
      if (dry) computer = computers.shift() ?? { state: "enrolled" };
      else {
        const result = await call(asUser([options.bunPath, join(release!, "ops/package/installer/main.ts"), "s15-computer", "--config", p.config]), 30_000);
        try { computer = JSON.parse(result.stdout.trim()) as S15ComputerProgress; } catch { computer = null; }
      }
      if (computer?.state === "running") for (const entry of [...computer.history, computer.step]) if (!printed.has(entry)) { printed.add(entry); out(`Working computer: ${stepCopy(entry)}`); }
      if (computer?.state === "enrolled" || computer?.state === "failed") break;
      if (computer?.state === "none" && (computer.host !== "ready" || poll >= 45)) break;
      if (poll >= 2700) break;
      await sleep(2000);
    }
    if (computer?.state === "enrolled") out(`Working computer: ${stepCopy("enrolled")}`);
    else if (computer?.state === "failed") out(`Working computer failed at ${computer.step} (${computer.code}). ${codeCopy(computer.code)} The controller is installed and healthy.`);
    else if (computer?.state === "none" && !local) out("Working computer: this host has no kvm group (no QEMU/KVM packages or virtualization), so S15 was installed without a Jit-managed VM and without its QEMU identity. Enroll your own VM in Resources → Computer in the Web UI. After installing the QEMU/KVM packages, re-run install.sh --s15 to add the Jit-managed VM.");
    else if (computer?.state === "none") out(computer.host === "ready" ? "Working computer: not started yet. Open Resources → Computer in the Web UI and press Start." : `Working computer unavailable on this host (${computer.host}). ${codeCopy(computer.host)}`);
    else out("Working computer: setup continues in the background. Follow it in Resources → Computer in the Web UI.");

    const port = new URL(config.origin).port || "80";
    out(dry ? "Dry run complete. No host commands ran; no setup credential was created." : `S15 controller ready: ${p.service}, release ${release!}.`);
    for (const line of [
      "Owner steps (Web UI only; no file edits):",
      `  1. Open the link shown above (single-use, valid for 15 minutes; re-run install.sh --s15 for a new one) on this host, or from your computer through: ssh -L ${port}:127.0.0.1:${port} <this host>. Set the owner password. An existing owner signs in at ${config.origin}/s14/login.`,
      `  2. Settings → Provider (${config.origin}/settings/provider): sign in to Codex with the device code. It is stored for the ${p.user} identity only; the approved Codex route becomes available after this sign-in.`,
      `  3. Manage → Telegram (${config.origin}/resources/telegram): paste the new BotFather token, press Check and save, then bind your account with the one-time code.`,
      "  4. Install your standing rules in the Web UI when you are ready. No policy, budget or personal GitHub rule was installed for you.",
    ]) out(line);
    if (computer?.state === "failed") throw new InstallerFailure("working-computer", `${codeCopy(computer.code)} The controller is installed and healthy; retry from Resources → Computer.`);
    return { events, config, computer, release, rolledBack: false };
  } catch (error) {
    if (!committed && armed) {
      events.push("rollback"); out("Step: rollback");
      let restored = false;
      try {
        if (!dry) await call(["systemctl", "stop", p.service], 120_000);
        if (previous?.release) {
          switchCurrent(previous.release);
          // The stopped release's own manifest, byte for byte; stores a newer release added stay on disk unlisted.
          if (previous.manifest !== null && read(manifestPath) !== previous.manifest) write(manifestPath, previous.manifest, 0o600, { uid, gid });
          if (previous.unit !== null) write(paths.unit, previous.unit, 0o644, { uid: 0, gid: 0 });
          if (previous.journald !== null) write(paths.journald, previous.journald, 0o644, { uid: 0, gid: 0 });
          if (previous.socket !== null) write(paths.socket, previous.socket, 0o644, { uid: 0, gid: 0 });
          if (!dry) await must(["systemctl", "daemon-reload"]);
          if (previous.active) { if (!dry) await must(["systemctl", "start", p.service], 180_000); restored = await healthy(); }
          else restored = true;
        } else {
          if (!dry) await call(["systemctl", "disable", p.service]);
          for (const path of [paths.unit, paths.journald, paths.socket]) { safe(path); rmSync(path, { force: true }); }
          link(paths.current); rmSync(paths.current, { force: true });
          if (!dry) await call(["systemctl", "daemon-reload"]);
          restored = true;
        }
      } catch { restored = false; }
      if (!previous?.release && createdState) { safe(paths.state); rmSync(paths.state, { recursive: true, force: true }); }
      const failure = error instanceof InstallerFailure ? error : new InstallerFailure(currentStep, next);
      const state = previous?.release ? restored ? `The previous release ${previous.release.slice(root === "/" ? 0 : root.length)} is active again${previous.active ? " and healthy" : ""}.`
        : `Restoring the previous release did not finish: point ${p.prefix}/current at ${previous.release.slice(root === "/" ? 0 : root.length)}, run systemctl daemon-reload and start ${p.service}.`
        : restored ? "No S15 service was left installed and nothing this run initialized was kept; the host is ready for a clean re-run." : `Remove ${p.unit} and run systemctl daemon-reload before re-running.`;
      throw new InstallerFailure(failure.step, `${failure.nextAction}. ${state}`);
    }
    if (!committed && createdState && !armed) { safe(paths.state); rmSync(paths.state, { recursive: true, force: true }); }
    if (error instanceof InstallerFailure) throw error;
    throw new InstallerFailure(currentStep, next);
  } finally {
    pendingOwner?.close(); ownerTerminal?.close();
    if (ownedStaging) rmSync(ownedStaging, { recursive: true, force: true });
    if (frozenContainer) rmSync(frozenContainer, { recursive: true, force: true });
  }
}

import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../../src/errors";
import { inspectS14Store } from "../../src/s14/store";
import { assertS14BackupUnfenced, assertS14OpsUnfenced } from "../../src/s14/ops-state";
import { spawnRunner } from "../../src/ops/supervisor";
import { parseServiceConfig, renderServiceUnit, serviceDatabasePath, serviceEnvironment } from "../package/service-config";
import { assertRootPath, assertRootTree } from "../package/trusted-paths";
import { readManifest, validateArtifact } from "../package/bun-build";
import type { CommandRunner } from "../../src/exec/podman-runtime";

const configPath = "/etc/jit-s14/service-config.json";
const unitPath = "/etc/systemd/system/jit-s14.service";
/** The only permitted temporary installed-unit override; no sandbox or namespace directive changes. */
export const inputEvidenceOverridePath = "/run/systemd/system/jit-s14.service.d/90-input-evidence.conf";
const check = (value: unknown, reason: string) => { if (!value) throw new AppError(reason); };

/** Exact override text for review/provisioning later; this function never writes or reloads a unit. */
export function inputEvidenceOverride(bun: string, release: string, cleanupOnly = false): string {
  return `[Service]\nExecStart=\nExecStart=${bun} --no-env-file ${release}/ops/box/s14-input-evidence.ts${cleanupOnly ? " --cleanup-only" : ""}\nEnvironment=JIT_S14_INPUT_EVIDENCE=unused-disposable-installation\nRestart=no\n`;
}

/** Read-only equivalent of the old harness's mandatory unused-pool guard; never opens its installed ledger. */
export function requireUnusedInputEvidencePool(path: string): void {
  check(inspectS14Store(path) === "s14", "input_evidence_installed_store_required");
  assertS14OpsUnfenced(path); assertS14BackupUnfenced(path);
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    check(!db.query("SELECT 1 FROM bot_computers WHERE coalesce(json_extract(record_json,'$.state'),'')<>'deleted' OR json_extract(record_json,'$.diskSlot.id') IS NOT NULL OR (json_type(record_json,'$.diskSlot') IS NOT NULL AND json_type(record_json,'$.diskSlot')<>'null') LIMIT 1").get(), "evidence_requires_unused_disposable_pool");
  } finally { db.close(); }
}

/** Refuses all live execution outside the exact installed, hardened service identity/config/release and main PID. */
export async function requireInputEvidenceInstallation(cleanupOnly: boolean) {
  check(process.platform === "linux" && ["x64", "arm64"].includes(process.arch), "input_evidence_linux_required");
  check(process.env.JIT_S14_INPUT_EVIDENCE === "unused-disposable-installation", "input_evidence_explicit_dedication_required");
  check(process.getuid?.() && process.getuid() === process.geteuid?.(), "input_evidence_service_identity_required");
  assertRootPath(configPath); assertRootPath(unitPath); assertRootPath(inputEvidenceOverridePath);
  const config = parseServiceConfig(JSON.parse(readFileSync(configPath, "utf8")));
  check(config.runtime === "s14" && config.serviceUser === "jit-s14" && config.s14?.images && config.executablePath === "/opt/jit-s14/current", "input_evidence_standard_installation_required");
  const release = realpathSync(config.executablePath), bun = realpathSync(process.execPath);
  assertRootPath(dirname(config.executablePath)); assertRootTree(release); assertRootPath(bun);
  check(validateArtifact(release, { runtime: true }).ok, "input_evidence_installed_artifact_required");
  check(realpathSync(join(release, "ops/box/s14-input-evidence.ts")) === realpathSync(join(import.meta.dir, "s14-input-evidence.ts")), "input_evidence_installed_entry_required");
  const call = async (argv: string[]) => {
    const result = await spawnRunner(argv, { timeoutMs: 5000, cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } });
    check(result.exitCode === 0 && !result.timedOut, "input_evidence_service_inspection_failed"); return result.stdout;
  };
  const passwd = (await call(["getent", "passwd", config.serviceUser])).trim().split(":");
  const uid = Number(passwd[2]), gid = Number(passwd[3]), home = passwd[5]!;
  check(passwd[0] === config.serviceUser && uid > 0 && gid > 0 && uid === process.getuid?.() && gid === process.getgid?.() && ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"].includes(passwd[6]!), "input_evidence_service_identity_required");
  check(readFileSync(unitPath, "utf8") === await renderServiceUnit(config, { bunPath: bun, configPath, uid, gid, home }), "input_evidence_installed_descriptor_changed");
  check(readFileSync(inputEvidenceOverridePath, "utf8") === inputEvidenceOverride(bun, config.executablePath, cleanupOnly), "input_evidence_override_changed");
  const properties = new Map((await call(["systemctl", "show", "jit-s14.service", "--property=MainPID,User,Group,FragmentPath,DropInPaths,Restart,NoNewPrivileges,PrivateTmp,ProtectSystem,ProtectHome,ProtectControlGroups,ProtectKernelTunables,RestrictSUIDSGID,LogNamespace,UMask,MemoryMax,TasksMax,KillMode"]))
    .trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)] as const; }));
  check(properties.get("MainPID") === String(process.pid) && properties.get("User") === config.serviceUser && properties.get("Group") === String(gid) && properties.get("FragmentPath") === unitPath && properties.get("DropInPaths") === inputEvidenceOverridePath && properties.get("Restart") === "no", "input_evidence_not_exclusive_installed_main");
  check(["NoNewPrivileges", "PrivateTmp", "ProtectControlGroups", "ProtectKernelTunables", "RestrictSUIDSGID"].every(key => properties.get(key) === "yes") && properties.get("ProtectSystem") === "strict" && properties.get("ProtectHome") === "tmpfs" && properties.get("LogNamespace") === "jit-s14" && properties.get("UMask") === "0077" && properties.get("MemoryMax") === String(config.resources.memoryMaxBytes) && properties.get("TasksMax") === "256" && properties.get("KillMode") === "mixed", "input_evidence_hardened_unit_required");
  for (const [key, value] of serviceEnvironment(config)) check(process.env[key] === value, "input_evidence_installed_environment_changed");
  check(process.env.JIT_PODMAN_MODE === "remote" && process.env.XDG_RUNTIME_DIR === `/run/user/${uid}` && process.cwd() === config.workingDirectory, "input_evidence_installed_environment_changed");
  const state = lstatSync(config.stateDirectory), scratch = lstatSync(config.s14!.gitScratch), fs = statfsSync(config.s14!.gitScratch);
  check(state.isDirectory() && !state.isSymbolicLink() && state.uid === uid && (state.mode & 0o077) === 0, "input_evidence_private_state_required");
  check(scratch.isDirectory() && !scratch.isSymbolicLink() && scratch.uid === uid && (scratch.mode & 0o077) === 0 && fs.type === 0x01021994 && fs.blocks * fs.bsize > 0 && fs.blocks * fs.bsize <= 128 * 1024 ** 2, "input_evidence_installed_scratch_required");
  const database = serviceDatabasePath(config);
  check(!existsSync(`${database}.computer-evidence.sqlite`) && !existsSync(`${database}.computer-evidence.sqlite.private.json`), "input_evidence_other_harness_state_present");
  const manifest = readManifest(release);
  return { config, database, build: { artifactId: manifest.artifactId, contentHash: manifest.contentHash, schema: manifest.s14SchemaVersion, bun: Bun.version, images: config.s14!.images! } };
}

function processStart(pid: number): string | null {
  let fd: number;
  try { fd = openSync(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const bytes = Buffer.alloc(8193), count = readSync(fd, bytes, 0, bytes.length, 0);
    check(count > 0 && count <= 8192, "input_evidence_process_stat_unverified");
    const value = bytes.subarray(0, count).toString("utf8"), fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    check(/^\d+$/.test(fields[19] ?? ""), "input_evidence_process_stat_unverified");
    return fields[19]!; // Linux stat field 22; a reused PID has a different start time.
  } finally { closeSync(fd); }
}

/** Ephemeral kernel PID/start-time witnesses; neither process IDs nor raw proc/inspect output enters evidence records. */
export class InputEvidenceProcesses {
  readonly #observed = new Map<string, { witnesses: { pid: number; start: string }[]; complete: boolean }>();
  constructor(readonly run: CommandRunner, readonly startTime: (pid: number) => string | null = processStart) {}
  /** Captures both actual component processes before live input, or only present components during cleanup-only. */
  async remember(id: string, requireRunning = true): Promise<void> {
    check(/^[a-f0-9]{32}$/.test(id), "input_evidence_process_scope_refused");
    // Persist each witness before another inspect can fail. A failed refresh cannot erase an earlier PID.
    const observation = this.#observed.get(id) ?? { witnesses: [], complete: false };
    observation.complete = false; this.#observed.set(id, observation);
    const observed: { pid: number; start: string }[] = [];
    for (const role of ["workspace", "browser"]) {
      const name = `jit-s14-${id}-${role}`;
      const exists = await this.run(["container", "exists", name], { timeoutMs: 5000 });
      if (!requireRunning && exists.exitCode === 1) continue;
      check(exists.exitCode === 0, "input_evidence_process_unobserved");
      const result = await this.run(["inspect", "--format", "{{.State.Pid}} {{.State.Running}}", name], { timeoutMs: 5000 });
      check(result.exitCode === 0 && result.stdout.length <= 128, "input_evidence_process_unobserved");
      const fields = new TextDecoder().decode(result.stdout).trim().split(" "), pid = Number(fields[0]);
      if (!requireRunning && pid === 0 && fields[1] === "false") continue;
      check(fields.length === 2 && fields[1] === "true" && Number.isSafeInteger(pid) && pid > 0, "input_evidence_process_unobserved");
      const start = this.startTime(pid); check(start, "input_evidence_process_unobserved");
      const witness = { pid, start: start! }; observed.push(witness);
      if (!observation.witnesses.some(prior => prior.pid === pid && prior.start === start)) observation.witnesses.push(witness);
    }
    check(!requireRunning || observed.length === 2 && observed[0]!.pid !== observed[1]!.pid, "input_evidence_process_unobserved");
    observation.complete = true;
  }
  /** Requires exact container removal and absence of the original kernel processes before capacity reuse. */
  async absent(id: string): Promise<void> {
    check(/^[a-f0-9]{32}$/.test(id), "input_evidence_process_scope_refused");
    for (const role of ["workspace", "browser", "registry", "registry-proxy"]) {
      const result = await this.run(["container", "exists", `jit-s14-${id}-${role}`], { timeoutMs: 5000 });
      check(result.exitCode === 1 && result.stdout.length === 0, "input_evidence_process_removal_unconfirmed");
    }
    const observation = this.#observed.get(id);
    for (const process of observation?.witnesses ?? []) check(this.startTime(process.pid) !== process.start, "input_evidence_kernel_process_still_present");
    check(!observation || observation.complete, "input_evidence_process_observation_unconfirmed");
    this.#observed.delete(id);
  }
}

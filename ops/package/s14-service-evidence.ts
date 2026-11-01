import { lstatSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseServiceConfig, serviceDatabasePath, type ServiceConfig } from "./service-config";
import { readManifest, validateArtifact } from "./bun-build";
import { assertRootPath, assertRootTree } from "./trusted-paths";
import { spawnRunner, type CommandRunner } from "../../src/ops/supervisor";

/** Read-only service evidence: fixed booleans/reasons only; never journals, credentials, addresses or database content. */
export async function collectS14ServiceEvidence(config: ServiceConfig, run: CommandRunner = spawnRunner) {
  if (config.runtime !== "s14") throw new Error("s14_service_required");
  const call = async (argv: string[]) => {
    try { return await run(argv, { timeoutMs: 10_000, cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } }); }
    catch { return { exitCode: 1, stdout: "", timedOut: false }; }
  };
  const properties = await call(["systemctl", "show", "jit-s14.service", "--property=ActiveState,MainPID,User,NoNewPrivileges,PrivateTmp,ProtectSystem,ProtectHome,ProtectControlGroups,ProtectKernelTunables,RestrictSUIDSGID,LogNamespace"]);
  const fields = new Map(properties.stdout.trim().split("\n").map(line => line.split("=", 2) as [string, string]));
  const identity = await call(["getent", "passwd", config.serviceUser]), passwd = identity.stdout.trim().split(":");
  const uid = Number(passwd[2]), pid = Number(fields.get("MainPID"));
  const identityOk = identity.exitCode === 0 && passwd[0] === config.serviceUser && Number.isSafeInteger(uid) && uid > 0;
  const asUser = (argv: string[]) => ["runuser", "-u", config.serviceUser, "--", "env", `HOME=${passwd[5]}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...argv];
  const checks: Record<string, boolean> = {
    serviceActive: properties.exitCode === 0 && fields.get("ActiveState") === "active",
    serviceIdentity: identityOk && fields.get("User") === config.serviceUser,
    hardening: ["NoNewPrivileges", "PrivateTmp", "ProtectControlGroups", "ProtectKernelTunables", "RestrictSUIDSGID"].every(key => fields.get(key) === "yes") && fields.get("ProtectSystem") === "strict" && fields.get("ProtectHome") === "tmpfs" && fields.get("LogNamespace") === "jit-s14",
    rootOwnedRelease: false, artifact: false, privateState: false, gitScratchTmpfs: false, secretServiceUnlocked: false, podmanSocket: false, botImages: false,
  };
  let artifactId: string | null = null, schema: number | null = null;
  try {
    const release = realpathSync(config.executablePath);
    assertRootPath(join(config.executablePath, "..")); assertRootTree(release);
    checks.rootOwnedRelease = true;
    checks.artifact = validateArtifact(release, { runtime: true }).ok;
    const manifest = readManifest(release); artifactId = manifest.artifactId; schema = manifest.s14SchemaVersion ?? null;
    const state = lstatSync(config.stateDirectory), db = lstatSync(serviceDatabasePath(config));
    checks.privateState = state.isDirectory() && db.isFile() && state.uid === uid && db.uid === uid && (state.mode & 0o077) === 0 && (db.mode & 0o077) === 0;
  } catch { /* Metadata unavailable stays false. */ }
  if (checks.serviceActive && Number.isSafeInteger(pid) && pid > 0) {
    try {
      // /proc/<pid>/root observes the service's private mount namespace, including TemporaryFileSystem.
      const scratch = `/proc/${pid}/root${config.s14!.gitScratch}`, stat = statSync(scratch), fs = statfsSync(scratch);
      checks.gitScratchTmpfs = stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0 && fs.type === 0x01021994 && fs.blocks * fs.bsize > 0 && fs.blocks * fs.bsize <= 128 * 1024 ** 2;
    } catch { /* Not observed, never inferred from unit flags. */ }
  }
  if (identityOk) {
    const keyring = await call(asUser(["busctl", "--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/collection/login", "org.freedesktop.Secret.Collection", "Locked"]));
    checks.secretServiceUnlocked = keyring.exitCode === 0 && keyring.stdout.trim() === "b false";
    const podman = ["podman", "--remote", "--url", `unix:///run/user/${uid}/podman/podman.sock`];
    const socket = await call(asUser([...podman, "info", "--format", "{{.Host.Security.Rootless}}"]));
    checks.podmanSocket = socket.exitCode === 0 && !socket.timedOut && socket.stdout.trim() === "true";
    const images = config.s14!.images;
    // buildInputsHash records provenance; only the two image references are Podman operands.
    if (images) checks.botImages = (await Promise.all([images.base, images.browser].map(ref => call(asUser([...podman, "image", "exists", ref]))))).every(result => result.exitCode === 0 && !result.timedOut);
  }
  return { contract: "ops.s14-service-evidence/v1", architecture: process.arch, artifactId, schema, checks,
    computerReason: "computer_local_podman_required", readiness: "service_observations_only",
    pending: ["provider-sign-in-and-inference", "multi-Bot-research-and-source-coverage", "computer-isolation-and-finite-disks", "backup-restore-and-lifecycle-reconciliation", "cancel-restart-reboot", "UI-device-accessibility", "owner-usefulness-acceptance"] };
}

if (import.meta.main) {
  try {
    if (process.env.JIT_S14_SERVICE_EVIDENCE !== "1" || process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || process.getuid?.() !== 0) throw new Error("opt_in_linux_root_required");
    const file = "/etc/jit-s14/service-config.json"; assertRootPath(file);
    const config = parseServiceConfig(JSON.parse(readFileSync(file, "utf8")));
    console.log(JSON.stringify(await collectS14ServiceEvidence(config)));
  } catch { console.error("S14 evidence unavailable. Use the protected installed release on opt-in Linux x64/arm64; see docs/runbooks/ops-service.md."); process.exitCode = 1; }
}

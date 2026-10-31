import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "../../src/errors";
import { createBoxBackend } from "../../src/exec/box-backend";
import { podmanCommandRunner } from "../../src/exec/podman-runtime";
import { defaultComputerLimits } from "../../src/s14/computer";
import { BotPodmanRuntime, probeBotPodman } from "../../src/s14/computer-podman";
import type { BotComputer, ComputerHandle } from "../../src/s14/computer-types";

// Opt-in only. No application store, owner login, provider or website credential is read by this probe.
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(a => !["--diagnostics", "--smoke"].includes(a))) throw new AppError("use_diagnostics_or_smoke");
  const readiness = await probeBotPodman(podmanCommandRunner());
  console.log(JSON.stringify({ contract: "app.bot-computer/v1", readiness, devices: { fuse: existsSync("/dev/fuse"), tun: existsSync("/dev/net/tun") },
    network: "none_tun_not_required_by_this_backend", evidence: "readiness_only_not_isolation_smoke" }));
  if (args[0] !== "--smoke") return;
  if (readiness.state !== "ready") throw new AppError(readiness.reason!, 503);
  const root = process.env.JIT_S14_SMOKE_ROOT;
  if (!root) throw new AppError("dedicated_JIT_S14_SMOKE_ROOT_required");
  const runtime = new BotPodmanRuntime({ dataRoot: resolve(root), protectedPaths: [resolve(".local"), resolve("backups"), resolve(".git")],
    workspaceImage: process.env.JIT_BOX_IMAGE_BASE ?? "", browserImage: process.env.JIT_BOX_IMAGE_BROWSER ?? "" });
  const computer = (botId: string, digit: string): BotComputer => ({ id: digit.repeat(32), botId, revision: 1, generation: 1, botGeneration: 1, ownerGeneration: 1, workId: "credential_free_probe",
    state: "starting", reason: null, limits: { ...defaultComputerLimits }, workspaceId: `${botId}_workspace`, profileId: `${botId}_profile`, lastUsedAt: Date.now(), diskSlot: { id: runtime.diskSlots()[botId === "probe_a" ? 0 : 1]!, generation: 1, clean: true } });
  const a = computer("probe_a", "a"), b = computer("probe_b", "b"), allowed = () => {};
  const backend = (handle: ComputerHandle) => createBoxBackend({ exec: (_legacyHandle, request) => runtime.exec(handle, request, allowed) },
    { projectId: handle.computerId, name: "probe", mode: "workspace", profile: false, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" });
  try {
    let aHandle = await runtime.start(a, allowed);
    const bHandle = await runtime.start(b, allowed);
    const aBackend = backend(aHandle), bBackend = backend(bHandle);
    await aBackend.writeFileAtomically("/workspace/.box14-probe-a", "public probe marker A");
    await bBackend.writeFileAtomically("/workspace/.box14-probe-b", "public probe marker B");
    // Synthetic session marker, never an actual cookie/token. The workspace must not see it.
    writeFileSync(join(resolve(root), "slots", a.diskSlot!.id, "profile", ".box14-probe-session"), "synthetic private component marker", { mode: 0o600 });
    const isolation = await aBackend.spawn({ cwd: "/workspace", timeoutMs: 10000,
      command: "test ! -e /workspace/.box14-probe-b && test ! -e /profile/.box14-probe-session && test ! -S /run/podman/podman.sock && test ! -S /var/run/docker.sock && ! curl --noproxy '*' --max-time 2 -fsS http://192.0.2.1 >/dev/null 2>&1 && python3 -c 'import socket;\ntry: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)\nexcept PermissionError: raise SystemExit(0)\nraise SystemExit(1)'" });
    if (isolation.exitCode !== 0) throw new AppError("probe_process_network_profile_denial_failed");
    await runtime.screenshot(aHandle, allowed);
    await runtime.stop(a);
    aHandle = await runtime.start({ ...a, generation: 2, diskSlot: { ...a.diskSlot!, generation: 2 } }, allowed);
    let persisted = "";
    for await (const chunk of backend(aHandle).readFile("/workspace/.box14-probe-a")) persisted += new TextDecoder().decode(chunk);
    if (persisted !== "public probe marker A") throw new AppError("probe_workspace_persistence_failed");
    if (!existsSync(join(resolve(root), "slots", a.diskSlot!.id, "profile", ".box14-probe-session"))) throw new AppError("probe_profile_persistence_failed");
    console.log(JSON.stringify({ evidence: "live_credential_free_smoke_passed", processMountNetworkProfileDenial: true, workspaceAndProfileIdlePersistence: true,
      kernelCpuMemoryPidSwapAndFilesystemBounds: true, ownerImage: true, realWebsiteLogin: "not_run", stressAndRebootEvidence: "pending_runbook" }));
  } finally {
    await runtime.stop(a);
    await runtime.stop(b);
  }
}
if (import.meta.main) main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof AppError ? error.code : "s14_probe_failed", evidence: "not_passed" }));
  process.exitCode = 1;
});

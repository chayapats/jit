import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPackage, installArtifactDependencies, validateArtifact } from "./bun-build";
import { parseServiceConfig, renderServiceUnit, serviceEnvironment } from "./service-config";
import { spawnRunner } from "../../src/ops/supervisor";

/**
 * Opt-in Linux ARM64 package smoke for OPS05 (ops.service_package/v1).
 *
 * Not part of `bun test`. It refuses unless `JIT_OPS_SMOKE=1` and the host is
 * Linux arm64, then: builds the artifact into a disposable directory,
 * installs its pinned dependencies for this host (explicit registry/cache
 * access), validates it, renders the unit, launches the release's `serve
 * --service-config` with the unit environment against disposable state,
 * probes GET /login on loopback, sends SIGTERM and checks a clean drain.
 * It never touches systemd, VPN, credentials, the owner account or the real
 * installation; the printed summary is sanitized evidence for a human to
 * attach to OPS05, which still owns real restart/reboot evidence.
 */
export interface SmokeGuard { optIn: string | undefined; platform: string; arch: string }

export function smokeRefusal(guard: SmokeGuard): string | null {
  if (guard.optIn !== "1") return "set JIT_OPS_SMOKE=1 to run the opt-in package smoke";
  if (guard.platform !== "linux" || guard.arch !== "arm64") return "package smoke requires Linux arm64; desktop success is not Pi evidence";
  return null;
}

async function smoke(srcDir: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "jit-arm64-smoke-"));
  try {
    const artifact = join(root, "artifact");
    const manifest = buildPackage({ srcDir, outDir: artifact, engineContract: "jit.schway.bridge/v1", engineRevision: null });
    await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner });
    const validation = validateArtifact(artifact, { runtime: true });
    if (!validation.ok) return { ok: false, step: "validate", failed: validation.checks.filter(c => !c.ok).map(c => c.check) };
    for (const dir of ["work", "state", "backup"]) mkdirSync(join(root, dir), { mode: 0o700 });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    await probe.stop(true);
    const service = parseServiceConfig({ serviceUser: "jit-smoke", executablePath: artifact, workingDirectory: join(root, "work"),
      stateDirectory: join(root, "state"), ledgerPath: join(root, "state", "ledger.json"), backupDirectory: join(root, "backup"),
      routes: [], secretRefs: [], network: { bindHost: "127.0.0.1", port, vpnInterface: null },
      resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 7, stopTimeoutSeconds: 10 } });
    writeFileSync(service.ledgerPath, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
    const configPath = join(root, "service-config.json");
    writeFileSync(configPath, JSON.stringify(service), { mode: 0o600 });
    await renderServiceUnit(service, { bunPath: process.execPath, configPath });
    const env = { ...Object.fromEntries(serviceEnvironment(service)), PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const child = Bun.spawn([process.execPath, join(artifact, "src", "main.ts"), "serve", "--service-config", configPath],
      { cwd: join(root, "work"), env, stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let out = "";
    const deadline = Date.now() + 60_000;
    while (!out.includes("Jit workspace started") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    let login = 0;
    try { login = (await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(5000) })).status; } catch { login = 0; }
    child.kill("SIGTERM");
    const exit = await child.exited;
    return { ok: out.includes("Jit workspace started") && login === 200 && exit === 0, artifactId: manifest.artifactId, appVersion: manifest.appVersion,
      bunVersion: manifest.bunVersion, schemaVersion: manifest.schemaVersion, arch: process.arch, platform: process.platform,
      started: out.includes("Jit workspace started"), loginStatus: login, exitCode: exit,
      evidence: "simulated-disposable-state; systemd, reboot, credentials and VPN evidence remain OPS05 human gates" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const refusal = smokeRefusal({ optIn: process.env.JIT_OPS_SMOKE, platform: process.platform, arch: process.arch });
  if (refusal) { console.error(`Package smoke refused: ${refusal}`); process.exitCode = 2; }
  else {
    const src = resolve(process.argv[2] ?? join(import.meta.dir, "..", ".."));
    const summary = await smoke(src).catch(error => ({ ok: false, error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "smoke_failed" }));
    console.log(JSON.stringify(summary));
    process.exitCode = summary.ok ? 0 : 1;
  }
}

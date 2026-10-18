import { arch, platform, release } from "node:os";
import { constants } from "node:fs";
import { access, lstat, open, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedJson } from "./records";
import manifest from "../../package.json";
import { routeEvidence, safeAlias, safeKernel, safeVersion, validateEvidence, type HostEvidence, type Inventory } from "./contract";

/** Local configuration names only the current host context and explicit paths; no SSH target or credential fields exist. */
export interface InventoryConfig {
  installationLabel: string; context: Inventory["context"]; testedPath: string; workingDirectory: string; stateDirectory: string;
  deadlineMs: number; routes: { route: string; model: string | null; configured: boolean }[];
}
/** Scriptable boundary; production implementations perform only bounded local inventory and a disposable write check. */
export interface InventoryPorts {
  now(): number; id(): string;
  host(): { os: unknown; architecture: unknown; kernel: unknown; bun: unknown; uid: number | null; effectiveUid: number | null };
  bunOnPath(config: InventoryConfig, signal: AbortSignal): Promise<{ found: boolean | null; version: unknown }>;
  directories(config: InventoryConfig, signal: AbortSignal): Promise<{ workingDirectory: Inventory["workingDirectory"]; persistentState: Inventory["persistentState"] }>;
  dependencies(signal: AbortSignal): Promise<Inventory["dependencies"]>;
}
/** Validates finite local input without echoing values into diagnostics. */
export function parseConfig(raw: unknown, root: string): InventoryConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_configuration");
  const c = raw as Record<string, unknown>;
  if (Object.keys(c).some(k => !["installationLabel", "context", "testedPath", "workingDirectory", "stateDirectory", "deadlineMs", "routes"].includes(k))) throw new Error("invalid_configuration");
  const installationLabel = safeAlias(c.installationLabel);
  if (!["interactive", "service", "ci", "unspecified"].includes(c.context as string)) throw new Error("invalid_configuration");
  for (const key of ["testedPath", "workingDirectory", "stateDirectory"]) {
    if (typeof c[key] !== "string" || c[key].length > 4096 || /[\x00\r\n]/.test(c[key])) throw new Error("invalid_configuration");
  }
  if (!c.workingDirectory || !c.stateDirectory) throw new Error("invalid_configuration");
  const deadlineMs = c.deadlineMs ?? 2000;
  if (!Number.isSafeInteger(deadlineMs) || (deadlineMs as number) < 100 || (deadlineMs as number) > 10000) throw new Error("invalid_configuration");
  if (!Array.isArray(c.routes) || c.routes.length > 8) throw new Error("invalid_configuration");
  const seen = new Set<string>();
  const routes = c.routes.map(r => {
    if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "configured,model,route" || typeof r.configured !== "boolean") throw new Error("invalid_configuration");
    const route = safeAlias(r.route), model = r.model === null ? null : safeAlias(r.model);
    if (seen.has(route)) throw new Error("invalid_configuration"); seen.add(route);
    if (r.configured && model === null) throw new Error("invalid_configuration");
    return { route, model, configured: r.configured };
  });
  return { installationLabel, context: c.context as Inventory["context"], testedPath: c.testedPath as string,
    workingDirectory: resolve(root, c.workingDirectory as string), stateDirectory: resolve(root, c.stateDirectory as string), deadlineMs: deadlineMs as number, routes };
}

/** Produces a safe blocked readiness record; inventory alone never proves dependency compatibility or route readiness. */
export async function inventory(config: InventoryConfig, ports: InventoryPorts): Promise<HostEvidence> {
  // Revalidate direct callers, not only the CLI parser.
  config = parseConfig(config, process.cwd());
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("inventory_deadline")); }, config.deadlineMs); });
  const bounded = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await Promise.race([Promise.resolve().then(read), expired]); } catch { return fallback; }
  };
  try {
    let host: ReturnType<InventoryPorts["host"]>;
    try { host = ports.host(); } catch { host = { os: null, architecture: null, kernel: null, bun: null, uid: null, effectiveUid: null }; }
    const [bun, dirs, dependencies] = await Promise.all([
      bounded(() => ports.bunOnPath(config, controller.signal), { found: null, version: null }),
      bounded(() => ports.directories(config, controller.signal), { workingDirectory: "unverified" as const, persistentState: "unverified" as const }),
      bounded(() => ports.dependencies(controller.signal), []),
    ]);
    const version = safeVersion(bun?.version);
    const data: Inventory = {
      os: ["linux", "darwin", "win32"].includes(host.os as string) ? host.os as Inventory["os"] : "unverified",
      architecture: ["arm64", "x64", "arm"].includes(host.architecture as string) ? host.architecture as Inventory["architecture"] : "unverified",
      kernel: safeKernel(host.kernel), processBun: safeVersion(host.bun),
      testedPathBun: { state: bun?.found === false ? "absent-on-tested-PATH" : bun?.found === true && version ? "installed" : "unverified", version: bun?.found === true ? version : null },
      identity: { uid: Number.isSafeInteger(host.uid) && host.uid! >= 0 && host.uid! <= 4294967295 ? host.uid : null,
        effectiveUid: Number.isSafeInteger(host.effectiveUid) && host.effectiveUid! >= 0 && host.effectiveUid! <= 4294967295 ? host.effectiveUid : null }, context: config.context,
      workingDirectory: ["ready", "unavailable"].includes(dirs?.workingDirectory) ? dirs.workingDirectory : "unverified",
      testedPath: config.testedPath ? "nonempty" : "empty", persistentState: ["writable", "unavailable"].includes(dirs?.persistentState) ? dirs.persistentState : "unverified",
      dependencies: Array.isArray(dependencies) ? dependencies.slice(0, 16).filter(d => d && ["typescript", "@types/bun"].includes(d.name) && safeVersion(d.declared))
        .map(d => ({ name: d.name, declared: d.declared, installed: safeVersion(d.installed), compatibility: "unverified" })) : [],
    };
    const nextAction = data.testedPathBun.state !== "installed" ? "check-runtime-path" : data.persistentState !== "writable" || data.workingDirectory !== "ready" ? "provide-writable-state-directory" : "verify-dependencies-on-target";
    const evidence: HostEvidence = { schema: "jit.host.evidence/v1", id: ports.id(), observedAt: new Date(ports.now()).toISOString(),
      installationLabel: config.installationLabel, observation: "inventory", maxAttempts: 1, attempts: 1, deadlineMs: config.deadlineMs,
      inventory: data, routes: config.routes.map(r => routeEvidence({ ...r, observation: "inventory", probeClass: "inventory", maxAttempts: 1, attempts: 0,
        deadlineMs: config.deadlineMs, elapsedMs: 0, event: "unobserved" })), outcome: "blocked", nextAction };
    validateEvidence(evidence);
    return evidence;
  } finally { clearTimeout(timeout!); controller.abort(); }
}

async function readablePackage(path: string): Promise<string | null> {
  try {
    const parsed = await readBoundedJson(path, 8192) as { version?: unknown } | null;
    return safeVersion(parsed?.version);
  } catch { return null; }
}
/** Current-host inventory has no shell, network, login, installation or reboot path. */
export function localPorts(): InventoryPorts {
  return {
    now: Date.now, id: () => crypto.randomUUID(),
    host: () => ({ os: platform(), architecture: arch(), kernel: release(), bun: Bun.version, uid: process.getuid?.() ?? null, effectiveUid: process.geteuid?.() ?? null }),
    async bunOnPath(config, signal) {
      const executable = Bun.which("bun", { PATH: config.testedPath, cwd: config.workingDirectory });
      if (!executable) return { found: false, version: null };
      // PATH is explicit, no shell or inherited credentials, stderr is discarded and output is byte-bounded.
      const child = Bun.spawn([executable, "--version"], { cwd: config.workingDirectory, env: { PATH: config.testedPath }, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal });
      const kill = () => { child.kill(9); };
      signal.addEventListener("abort", kill, { once: true });
      const reader = child.stdout.getReader(); let output = "", size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 128) { child.kill(9); await reader.cancel(); return { found: true, version: null }; }
          output += Buffer.from(value).toString("utf8");
        }
        return { found: true, version: await child.exited === 0 ? safeVersion(output.trim()) : null };
      } finally { signal.removeEventListener("abort", kill); child.kill(9); reader.releaseLock(); await child.exited; }
    },
    async directories(config, signal) {
      let workingDirectory: Inventory["workingDirectory"] = "unavailable", persistentState: Inventory["persistentState"] = "unavailable";
      try { signal.throwIfAborted(); if ((await stat(config.workingDirectory)).isDirectory()) { await access(config.workingDirectory, constants.R_OK | constants.X_OK); workingDirectory = "ready"; } } catch { /* Fixed readiness only; never copy OS errors. */ }
      const target = resolve(config.stateDirectory, `.jit-inventory-${crypto.randomUUID()}`); let created = false;
      try {
        signal.throwIfAborted(); if (!(await lstat(config.stateDirectory)).isDirectory()) return { workingDirectory, persistentState };
        const file = await open(target, "wx", 0o600); created = true;
        try { await file.write("jit-inventory\n"); await file.sync(); persistentState = "writable"; } finally { await file.close(); }
      } catch { /* No raw error or path retention. */ }
      finally { if (created) await unlink(target); }
      return { workingDirectory, persistentState };
    },
    async dependencies(signal) {
      const result: Inventory["dependencies"] = [];
      for (const name of ["typescript", "@types/bun"] as const) {
        signal.throwIfAborted();
        result.push({ name, declared: manifest.devDependencies[name], installed: await readablePackage(fileURLToPath(new URL(`../../node_modules/${name}/package.json`, import.meta.url))), compatibility: "unverified" });
      }
      return result;
    },
  };
}

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { safeVersion } from "../../src/evidence/contract";
import { schemaVersion } from "../../src/store";

/** Engine contract identifiers allow path segments, e.g. jit.schway.bridge/v1. */
const contractPattern = /^[a-z][a-z0-9_./-]{0,119}$/;
export function isEngineContract(value: unknown): value is string {
  return typeof value === "string" && contractPattern.test(value);
}

/** Pinned build manifest. Desktop packaging never certifies ARM64 or live readiness. */
export interface BuildManifest {
  artifact: "jit.service.artifact/v1";
  artifactId: string;
  appVersion: string;
  bunVersion: string;
  lockHash: string;
  schemaVersion: number;
  engineContract: string;
  engineRevision: string;
  /** Actual build host architecture. Never a deployment claim. */
  arch: string;
  piValidation: { status: "pending"; detail: string };
  builtAt: string;
}

export interface BuildOptions {
  /** Exact source checkout. Must contain package.json, bun.lock and src/main.ts. */
  srcDir: string;
  /** Fresh output directory. Must not exist yet. */
  outDir: string;
  /** Declared engine contract, e.g. the supported Schway bridge contract. */
  engineContract: string;
  /** Declared engine revision, or null when the bridge revision is unverified here. */
  engineRevision: string | null;
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Packages a versioned service artifact from explicit directories. Every input is an
 * absolute path supplied by the caller; the build never inherits the developer cwd,
 * shell, network or global installs. Bun, lockfile, schema and engine pins land in
 * the manifest, and Pi validation stays pending until OPS05 collects it on the host.
 */
export function buildPackage(options: BuildOptions): BuildManifest {
  if (!options || typeof options !== "object") throw new Error("invalid_build_options");
  const srcDir = resolve(options.srcDir), outDir = resolve(options.outDir);
  if (!srcDir || !outDir || srcDir === outDir) throw new Error("invalid_build_options");
  if (typeof options.engineContract !== "string" || !isEngineContract(options.engineContract)) {
    throw new Error("invalid_build_options");
  }
  const engineRevision = options.engineRevision === null ? "unverified" : safeVersion(options.engineRevision);
  if (engineRevision === null) throw new Error("invalid_build_options");
  for (const entry of ["package.json", "bun.lock", "src/main.ts"]) {
    if (!existsSync(join(srcDir, entry))) throw new Error("invalid_package_source");
  }
  if (existsSync(outDir)) throw new Error("invalid_build_output");
  const manifest = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8")) as { version?: unknown };
  if (safeVersion(manifest.version) !== manifest.version) throw new Error("invalid_package_source");
  if (typeof Bun === "undefined" || safeVersion(Bun.version) !== Bun.version) throw new Error("invalid_build_runtime");
  mkdirSync(outDir, { recursive: true, mode: 0o755 });
  try {
    cpSync(join(srcDir, "package.json"), join(outDir, "package.json"));
    cpSync(join(srcDir, "bun.lock"), join(outDir, "bun.lock"));
    cpSync(join(srcDir, "src"), join(outDir, "src"), { recursive: true, filter: path => !/(^|\/)node_modules(\/|$)/.test(path) && !/(^|\/)\.local(\/|$)/.test(path) });
    const built: BuildManifest = { artifact: "jit.service.artifact/v1", artifactId: randomUUID(),
      appVersion: manifest.version as string, bunVersion: Bun.version, lockHash: sha256File(join(srcDir, "bun.lock")),
      schemaVersion, engineContract: options.engineContract, engineRevision, arch: process.arch,
      piValidation: { status: "pending", detail: "desktop packaging never certifies ARM64; Pi evidence belongs to OPS05" },
      builtAt: new Date().toISOString() };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(built, null, 2) + "\n", { mode: 0o644 });
    return built;
  } catch (error) {
    throw error instanceof Error && /^(invalid_|unsafe_)/.test(error.message) ? error : new Error("invalid_build_output");
  }
}

/** Reads and validates a packaged manifest without executing anything it describes. */
export function readManifest(outDir: string): BuildManifest {
  const raw = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const keys = ["artifact", "artifactId", "appVersion", "bunVersion", "lockHash", "schemaVersion", "engineContract", "engineRevision", "arch", "piValidation", "builtAt"];
  if (Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) throw new Error("invalid_artifact");
  if (raw.artifact !== "jit.service.artifact/v1" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(raw.artifactId as string) ||
      safeVersion(raw.appVersion) !== raw.appVersion || safeVersion(raw.bunVersion) !== raw.bunVersion ||
      typeof raw.lockHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.lockHash) ||
      raw.schemaVersion !== schemaVersion || !isEngineContract(raw.engineContract) ||
      (raw.engineRevision !== "unverified" && safeVersion(raw.engineRevision) !== raw.engineRevision) ||
      typeof raw.arch !== "string" || !raw.arch.length ||
      (raw.piValidation as { status?: unknown })?.status !== "pending" || typeof raw.builtAt !== "string" || !Number.isFinite(Date.parse(raw.builtAt as string))) {
    throw new Error("invalid_artifact");
  }
  return raw as unknown as BuildManifest;
}

/** Pi evidence status for an artifact. Only an arm64 build with collected host evidence leaves `not-run`. */
export function artifactPiStatus(manifest: Pick<BuildManifest, "arch" | "piValidation">): "not-run" | "pending" {
  if (manifest.arch !== "arm64" || manifest.piValidation?.status !== "pending") return "not-run";
  return "pending";
}

/**
 * Validates a pinned artifact: manifest shape, required files, lockfile pin match
 * and schema pin match. Returns check-level detail; never executes the artifact.
 */
export function validateArtifact(outDir: string): { ok: boolean; checks: { check: string; ok: boolean }[] } {
  const dir = resolve(outDir);
  const checks: { check: string; ok: boolean }[] = [];
  let manifest: BuildManifest | null = null;
  try { manifest = readManifest(dir); checks.push({ check: "manifest", ok: true }); }
  catch { checks.push({ check: "manifest", ok: false }); return { ok: false, checks }; }
  for (const entry of ["package.json", "bun.lock", "src/main.ts", "manifest.json"]) {
    checks.push({ check: `file:${entry}`, ok: existsSync(join(dir, entry)) && statSync(join(dir, entry)).isFile() });
  }
  try { checks.push({ check: "lock-pin", ok: sha256File(join(dir, "bun.lock")) === manifest!.lockHash }); }
  catch { checks.push({ check: "lock-pin", ok: false }); }
  checks.push({ check: "schema-pin", ok: manifest!.schemaVersion === schemaVersion });
  checks.push({ check: "pi-pending", ok: artifactPiStatus(manifest!) === "pending" || manifest!.arch !== "arm64" });
  return { ok: checks.every(c => c.ok), checks };
}

if (import.meta.main) {
  const [, , srcDir, outDir, engineContract, engineRevision] = process.argv;
  if (!srcDir || !outDir || !engineContract) {
    console.error("Use: bun ops/package/bun-build.ts <srcDir> <outDir> <engineContract> [engineRevision]");
    process.exitCode = 2;
  } else {
    try {
      const built = buildPackage({ srcDir, outDir, engineContract, engineRevision: engineRevision ?? null });
      console.log(JSON.stringify({ artifactId: built.artifactId, appVersion: built.appVersion, arch: built.arch, piValidation: built.piValidation.status }));
    } catch {
      console.error("Build failed: invalid source, output or engine pin.");
      process.exitCode = 2;
    }
  }
}

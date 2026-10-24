import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { safeVersion } from "../../src/evidence/contract";
import { schemaVersion } from "../../src/store";
import type { CommandRunner } from "../../src/ops/supervisor";

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
  /** SHA-256 over every packaged file (path + content), excluding the manifest and installed dependencies. */
  contentHash: string;
  piValidation: { status: "pending"; detail: string };
  builtAt: string;
}

/**
 * Dependency installation record written by `installArtifactDependencies` on
 * the host that will run the artifact. Native dependencies are platform
 * specific, so a record only proves installation for its own platform/arch.
 */
export interface DependencyRecord {
  schema: "jit.service.dependencies/v1";
  artifactId: string;
  lockHash: string;
  /** Manifest content pin the dependencies were installed against. */
  contentHash: string;
  platform: string;
  arch: string;
  bunVersion: string;
  /** SHA-256 over every path and file of the symlink-free `node_modules` tree. */
  dependencyHash: string;
  dependencyFiles: number;
  installedAt: string;
}

export interface BuildOptions {
  /** Exact source checkout. Must contain package.json, bun.lock, src/main.ts, ops/package and vendor/. */
  srcDir: string;
  /** Fresh output directory. Must not exist yet. */
  outDir: string;
  /** Declared engine contract, e.g. the supported Schway bridge contract. */
  engineContract: string;
  /** Declared engine revision, or null when the bridge revision is unverified here. */
  engineRevision: string | null;
}

/** Packaged entries. `ops/package` is imported by the service lifecycle; `vendor/` holds the pinned engine tarball. */
const packagedEntries = ["package.json", "bun.lock", "src", "ops/package", "vendor"] as const;
const requiredFiles = ["package.json", "bun.lock", "src/main.ts", "ops/package/service-config.ts", "ops/package/systemd/jit.service"] as const;
const excluded = (path: string) => /(^|\/)(node_modules|\.local|\.git)(\/|$)/.test(path) || /(^|\/)\.DS_Store$/.test(path);

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Ignored subtrees of a source checkout that may hold build output (for
 * example a worktree-local TMPDIR). Output may never overlap a packaged entry.
 */
export const buildOutputSubtrees = [".tmp", ".local", "dist"] as const;

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

/** Upper bound on files in a sealed dependency tree; above it sealing fails closed. */
const dependencyFileLimit = 50_000;

/**
 * Seals an installed dependency tree: every entry must be a regular file or
 * directory (no symlinks, devices or sockets), and the digest covers every
 * relative path and file content in sorted order.
 */
export function dependencyTreeHash(dir: string): { hash: string; files: number } {
  const root = resolve(dir, "node_modules");
  const hash = createHash("sha256");
  let files = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name), rel = relative(root, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new Error("invalid_dependency_symlink");
      if (stats.isDirectory()) { hash.update(`d\0${rel}\n`); walk(path); }
      else if (stats.isFile()) {
        if (++files > dependencyFileLimit) throw new Error("invalid_dependency_tree");
        hash.update(`f\0${rel}\0${sha256File(path)}\n`);
      } else throw new Error("invalid_dependency_tree");
    }
  };
  if (!lstatSync(root).isDirectory()) throw new Error("invalid_dependency_tree");
  walk(root);
  return { hash: hash.digest("hex"), files };
}

function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), rel = relative(root, path);
    if (excluded(rel) || rel === "manifest.json" || rel === "dependencies.json") continue;
    const stats = lstatSync(path);
    // Symlinks would let a release point outside itself; a packaged artifact holds regular files only.
    if (stats.isSymbolicLink()) throw new Error("invalid_artifact_symlink");
    if (stats.isDirectory()) listFiles(root, path, out);
    else if (stats.isFile()) out.push(rel);
  }
  return out;
}

/** Content digest of a packaged tree: sorted relative paths with per-file SHA-256. */
export function artifactContentHash(dir: string): string {
  const root = resolve(dir);
  const hash = createHash("sha256");
  for (const rel of listFiles(root)) hash.update(`${rel}\0${sha256File(join(root, rel))}\n`);
  return hash.digest("hex");
}

/**
 * Packages a versioned service artifact from explicit directories. Every input is an
 * absolute path supplied by the caller; the build never inherits the developer cwd,
 * shell, network or global installs. Bun, lockfile, schema, engine and content pins
 * land in the manifest, and Pi validation stays pending until OPS05 collects it on
 * the host. Dependencies are not installed here (see `installArtifactDependencies`).
 */
export function buildPackage(options: BuildOptions): BuildManifest {
  if (!options || typeof options !== "object") throw new Error("invalid_build_options");
  const srcDir = resolve(options.srcDir), outDir = resolve(options.outDir);
  // Output outside the checkout, or inside a designated ignored subtree of it; never overlapping packaged entries.
  if (!srcDir || !outDir || inside(srcDir, outDir) ||
      (inside(outDir, srcDir) && !buildOutputSubtrees.some(sub => inside(outDir, join(srcDir, sub)) && outDir !== join(srcDir, sub))) ||
      packagedEntries.some(entry => inside(outDir, join(srcDir, entry)))) throw new Error("invalid_build_options");
  if (typeof options.engineContract !== "string" || !isEngineContract(options.engineContract)) {
    throw new Error("invalid_build_options");
  }
  const engineRevision = options.engineRevision === null ? "unverified" : safeVersion(options.engineRevision);
  if (engineRevision === null) throw new Error("invalid_build_options");
  for (const entry of [...requiredFiles, "vendor"]) {
    if (!existsSync(join(srcDir, entry))) throw new Error("invalid_package_source");
  }
  if (existsSync(outDir)) throw new Error("invalid_build_output");
  const manifest = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8")) as { version?: unknown };
  if (safeVersion(manifest.version) !== manifest.version) throw new Error("invalid_package_source");
  if (typeof Bun === "undefined" || safeVersion(Bun.version) !== Bun.version) throw new Error("invalid_build_runtime");
  mkdirSync(outDir, { recursive: true, mode: 0o755 });
  try {
    for (const entry of packagedEntries) {
      cpSync(join(srcDir, entry), join(outDir, entry), { recursive: true, filter: path => !excluded(relative(srcDir, path)) });
    }
    const built: BuildManifest = { artifact: "jit.service.artifact/v1", artifactId: randomUUID(),
      appVersion: manifest.version as string, bunVersion: Bun.version, lockHash: sha256File(join(srcDir, "bun.lock")),
      schemaVersion, engineContract: options.engineContract, engineRevision, arch: process.arch,
      contentHash: artifactContentHash(outDir),
      piValidation: { status: "pending", detail: "desktop packaging never certifies ARM64; Pi evidence belongs to OPS05" },
      builtAt: new Date().toISOString() };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(built, null, 2) + "\n", { mode: 0o644 });
    return built;
  } catch (error) {
    throw error instanceof Error && /^(invalid_|unsafe_)/.test(error.message) ? error : new Error("invalid_build_output");
  }
}

const manifestKeys = ["artifact", "artifactId", "appVersion", "bunVersion", "lockHash", "schemaVersion", "engineContract", "engineRevision",
  "arch", "contentHash", "piValidation", "builtAt"];

/**
 * Reads and validates a packaged manifest without executing anything it describes.
 * `schemaVersion` must be a positive integer; compatibility with a particular
 * installation is checked by the caller (preflight / upgrade), not here.
 */
export function readManifest(outDir: string): BuildManifest {
  const raw = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (Object.keys(raw).length !== manifestKeys.length || manifestKeys.some(k => !Object.hasOwn(raw, k))) throw new Error("invalid_artifact");
  if (raw.artifact !== "jit.service.artifact/v1" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(raw.artifactId as string) ||
      safeVersion(raw.appVersion) !== raw.appVersion || safeVersion(raw.bunVersion) !== raw.bunVersion ||
      typeof raw.lockHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.lockHash) ||
      typeof raw.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.contentHash) ||
      !Number.isSafeInteger(raw.schemaVersion) || (raw.schemaVersion as number) < 1 || !isEngineContract(raw.engineContract) ||
      (raw.engineRevision !== "unverified" && safeVersion(raw.engineRevision) !== raw.engineRevision) ||
      typeof raw.arch !== "string" || !/^[a-z0-9_]{1,16}$/.test(raw.arch) ||
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

/** Reads the dependency record strictly; null when absent or malformed. */
export function readDependencyRecord(dir: string): DependencyRecord | null {
  const keys = ["schema", "artifactId", "lockHash", "contentHash", "platform", "arch", "bunVersion", "dependencyHash", "dependencyFiles", "installedAt"];
  try {
    const raw = JSON.parse(readFileSync(join(resolve(dir), "dependencies.json"), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) return null;
    if (raw.schema !== "jit.service.dependencies/v1" || typeof raw.artifactId !== "string" ||
        [raw.lockHash, raw.contentHash, raw.dependencyHash].some(h => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) ||
        typeof raw.platform !== "string" || typeof raw.arch !== "string" || safeVersion(raw.bunVersion) !== raw.bunVersion ||
        !Number.isSafeInteger(raw.dependencyFiles) || typeof raw.installedAt !== "string") return null;
    return raw as unknown as DependencyRecord;
  } catch { return null; }
}

export interface ArtifactValidation { ok: boolean; manifest: BuildManifest | null; checks: { check: string; ok: boolean }[] }

/**
 * Validates a pinned artifact: manifest shape, required files, lockfile pin,
 * content digest (a modified release fails), schema pin against the
 * executing build and, with `runtime`, that dependencies were installed for
 * this exact platform/arch. Never executes the artifact.
 */
export function validateArtifact(outDir: string, options: { runtime?: boolean } = {}): ArtifactValidation {
  const dir = resolve(outDir);
  const checks: { check: string; ok: boolean }[] = [];
  let manifest: BuildManifest | null = null;
  try { manifest = readManifest(dir); checks.push({ check: "manifest", ok: true }); }
  catch { checks.push({ check: "manifest", ok: false }); return { ok: false, manifest: null, checks }; }
  for (const entry of [...requiredFiles, "manifest.json"]) {
    checks.push({ check: `file:${entry}`, ok: existsSync(join(dir, entry)) && statSync(join(dir, entry)).isFile() });
  }
  try { checks.push({ check: "lock-pin", ok: sha256File(join(dir, "bun.lock")) === manifest.lockHash }); }
  catch { checks.push({ check: "lock-pin", ok: false }); }
  try { checks.push({ check: "content-pin", ok: artifactContentHash(dir) === manifest.contentHash }); }
  catch { checks.push({ check: "content-pin", ok: false }); }
  // The validating build must be the build being packaged: it owns exactly this schema's migrations.
  checks.push({ check: "schema-pin", ok: manifest.schemaVersion === schemaVersion });
  checks.push({ check: "pi-pending", ok: artifactPiStatus(manifest) === "pending" || manifest.arch !== "arm64" });
  if (options.runtime) {
    // The dependency tree is re-hashed, so a modified, added or removed dependency file fails validation.
    const deps = readDependencyRecord(dir);
    let sealed = false;
    if (deps && deps.artifactId === manifest.artifactId && deps.lockHash === manifest.lockHash && deps.contentHash === manifest.contentHash &&
        deps.platform === process.platform && deps.arch === process.arch && deps.bunVersion === manifest.bunVersion) {
      try { const tree = dependencyTreeHash(dir); sealed = tree.hash === deps.dependencyHash && tree.files === deps.dependencyFiles; }
      catch { sealed = false; }
    }
    checks.push({ check: "dependencies", ok: sealed });
  }
  return { ok: checks.every(c => c.ok), manifest, checks };
}

/**
 * Installs the artifact's pinned dependencies on the host that will run it:
 * `bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted`
 * inside the artifact, removes the bin-link directory (unused at runtime),
 * then seals the symlink-free tree into a strict record bound to the
 * artifact's content pin and this platform/arch. Explicit operator step only — the
 * service unit and boot never install or download anything. Registry access
 * (or a pre-populated Bun cache) is the operator's responsibility.
 */
export async function installArtifactDependencies(dir: string, input: { bunPath: string; run: CommandRunner; timeoutMs?: number }): Promise<DependencyRecord> {
  const root = resolve(dir);
  const valid = validateArtifact(root);
  if (!valid.ok || !valid.manifest) throw new Error("invalid_artifact");
  if (existsSync(join(root, "dependencies.json"))) throw new Error("dependencies_already_installed");
  const result = await input.run([input.bunPath, "install", "--frozen-lockfile", "--production", "--ignore-scripts", "--linker=hoisted"],
    { cwd: root, timeoutMs: input.timeoutMs ?? 600_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  if (result.exitCode !== 0) throw new Error("dependency_install_failed");
  const version = await input.run([input.bunPath, "--version"], { timeoutMs: 30_000 });
  const bunVersion = version.stdout.trim();
  if (version.exitCode !== 0 || safeVersion(bunVersion) !== bunVersion || bunVersion !== valid.manifest.bunVersion) throw new Error("runtime_mismatch");
  // Bin links are the only symlinks a hoisted install creates; the service never executes them.
  rmSync(join(root, "node_modules", ".bin"), { recursive: true, force: true });
  const tree = dependencyTreeHash(root);
  const record: DependencyRecord = { schema: "jit.service.dependencies/v1", artifactId: valid.manifest.artifactId, lockHash: valid.manifest.lockHash,
    contentHash: valid.manifest.contentHash, platform: process.platform, arch: process.arch, bunVersion,
    dependencyHash: tree.hash, dependencyFiles: tree.files, installedAt: new Date().toISOString() };
  writeFileSync(join(root, "dependencies.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o644 });
  return record;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "install-deps" && args.length === 2) {
    const { spawnRunner } = await import("../../src/ops/supervisor");
    try {
      const record = await installArtifactDependencies(args[1]!, { bunPath: process.execPath, run: spawnRunner });
      console.log(JSON.stringify({ artifactId: record.artifactId, platform: record.platform, arch: record.arch }));
    } catch (error) {
      console.error(`Dependency install failed: ${error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "unexpected"}`);
      process.exitCode = 2;
    }
  } else {
    const [srcDir, outDir, engineContract, engineRevision] = args;
    if (!srcDir || !outDir || !engineContract) {
      console.error("Use: bun ops/package/bun-build.ts <srcDir> <outDir> <engineContract> [engineRevision]\n     bun ops/package/bun-build.ts install-deps <artifactDir>");
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
}

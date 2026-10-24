import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import manifest from "../../package.json";
import { safeVersion } from "../evidence/contract";
import { schemaVersion } from "../store";
import { SCHWAY_RELEASE_CONTRACT } from "../team/schway-port";
import { upgradeEngineContract, upgradeNativeFormatVersion } from "./upgrade";

/** The supported engine bridge contract this build integrates (JBR01). */
export const engineBridgeContract = "jit.schway.bridge/v1" as const;

/**
 * Tested revisions carried by every drill record. Identity only: no branch
 * names, paths, hosts or environment. `git` and `contentHash` are null when the
 * installation has no readable checkout or the source tree exceeds its bound.
 */
export interface TestedRevisions {
  /** package.json version. */
  app: string;
  bun: string | null;
  /** SQLite `user_version` of the drilled state. */
  schema: number;
  /** Commit SHA of the checkout the drill ran from, when one is readable. */
  git: string | null;
  /** sha256 over package.json, bun.lock and every file under src/, bounded. */
  contentHash: string | null;
  engine: {
    /** Installed `schway` package version, when readable. */
    package: string | null;
    /** Pinned Schway host release contract. */
    release: string;
    /** Jit bridge contract. */
    bridge: string;
    /** Native session snapshot contract and format accepted by backup/upgrade. */
    snapshot: string;
    snapshotFormat: number;
  };
}

const appRoot = resolve(import.meta.dir, "../..");
const sha = /^[a-f0-9]{40}$/;
const contentLimits = { files: 4000, bytes: 64 * 1024 * 1024 };

function readSmall(path: string, max = 1024 * 1024): string | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > max) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

/** Resolves HEAD to a commit SHA without spawning git; follows worktree `commondir` and packed refs. */
export function gitRevision(root: string = appRoot): string | null {
  let gitDir = join(root, ".git");
  try {
    if (lstatSync(gitDir).isFile()) {
      const pointer = readSmall(gitDir, 4096)?.match(/^gitdir: (.+)\s*$/m)?.[1]?.trim();
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    }
  } catch { return null; }
  const head = readSmall(join(gitDir, "HEAD"), 4096)?.trim();
  if (!head) return null;
  if (sha.test(head)) return head;
  const ref = head.match(/^ref: (refs\/[A-Za-z0-9._\/-]{1,200})$/)?.[1];
  if (!ref || ref.includes("..")) return null;
  const common = readSmall(join(gitDir, "commondir"), 4096)?.trim();
  const dirs = [gitDir, ...(common ? [isAbsolute(common) ? common : resolve(gitDir, common)] : [])];
  for (const dir of dirs) {
    const loose = readSmall(join(dir, ref), 4096)?.trim();
    if (loose && sha.test(loose)) return loose;
    const packed = readSmall(join(dir, "packed-refs"), 4 * 1024 * 1024);
    const line = packed?.split("\n").find(l => l.endsWith(` ${ref}`));
    const value = line?.slice(0, 40);
    if (value && sha.test(value)) return value;
  }
  return null;
}

/** Deterministic bounded content hash of the running source; null when unreadable or over the bound. */
export function contentHash(root: string = appRoot): string | null {
  const files: string[] = [];
  let total = 0;
  const walk = (dir: string): boolean => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!walk(full)) return false; continue; }
      if (!entry.isFile()) continue;
      if (files.length >= contentLimits.files) return false;
      files.push(full);
    }
    return true;
  };
  if (!walk(join(root, "src"))) return null;
  for (const name of ["package.json", "bun.lock"]) files.push(join(root, name));
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    let bytes: Buffer;
    try {
      const stats = lstatSync(file);
      if (!stats.isFile()) return null;
      total += stats.size;
      if (total > contentLimits.bytes) return null;
      bytes = readFileSync(file);
    } catch { return null; }
    hash.update(relative(root, file)).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

function enginePackage(root: string): string | null {
  const raw = readSmall(join(root, "node_modules", "schway", "package.json"), 256 * 1024);
  if (!raw) return null;
  try { return safeVersion((JSON.parse(raw) as { version?: unknown }).version); } catch { return null; }
}

/** Collects the tested revisions for a drill over a state at `stateSchema`. */
export function testedRevisions(stateSchema: number = schemaVersion, root: string = appRoot): TestedRevisions {
  return {
    app: manifest.version,
    bun: typeof Bun !== "undefined" ? Bun.version : null,
    schema: stateSchema,
    git: gitRevision(root),
    contentHash: contentHash(root),
    engine: { package: enginePackage(root), release: SCHWAY_RELEASE_CONTRACT, bridge: engineBridgeContract,
      snapshot: upgradeEngineContract, snapshotFormat: upgradeNativeFormatVersion },
  };
}

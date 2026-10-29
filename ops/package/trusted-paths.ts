import { lstatSync, readdirSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Fake-root fixtures may supply their uid, filesystem boundary and metadata; production uses root and real lstat up to `/`. */
export interface RootPathPolicy { root?: string; uid?: number; lstat?: (path: string) => Stats }

/** Identifies the exact unsafe entry without exposing file contents. */
export class UnsafeRootPath extends Error {
  constructor(readonly path: string) { super("unsafe_root_path"); }
}

/** Rejects links, foreign owners and group/other write, checking ancestors top-down before traversing them. Missing output paths are allowed. */
export function assertRootPath(path: string, policy: RootPathPolicy = {}): void {
  const boundary = resolve(policy.root ?? "/"), file = resolve(path);
  if (boundary !== "/" && file !== boundary && !file.startsWith(boundary + "/")) throw new UnsafeRootPath(file);
  const entries = [file];
  while (entries.at(-1) !== boundary) entries.push(dirname(entries.at(-1)!));
  for (const entry of entries.reverse()) {
    try { assertEntry(entry, policy); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function assertEntry(path: string, policy: RootPathPolicy): Stats {
  const stats = (policy.lstat ?? lstatSync)(path);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()) || stats.uid !== (policy.uid ?? 0) || (stats.mode & 0o022) !== 0) throw new UnsafeRootPath(path);
  return stats;
}

/** Checks every executable-tree entry, including dependencies and metadata excluded from content hashing; the tree must exist. */
export function assertRootTree(path: string, policy: RootPathPolicy = {}): void {
  assertRootPath(path, policy);
  const walk = (entry: string) => {
    let stats;
    try { stats = assertEntry(entry, policy); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new UnsafeRootPath(entry); throw error; }
    if (stats.isDirectory()) for (const name of readdirSync(entry)) walk(join(entry, name));
  };
  walk(resolve(path));
}

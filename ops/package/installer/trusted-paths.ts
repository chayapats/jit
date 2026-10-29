import { chmodSync, chownSync, cpSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateArtifact, type BuildManifest } from "../bun-build";

import { assertRootPath, assertRootTree, type RootPathPolicy } from "../trusted-paths";
export { assertRootPath, assertRootTree, type RootPathPolicy } from "../trusted-paths";

/** Transfers a fresh trusted staging tree bottom-up; root never traverses a directory after giving it away. */
export function giveInstallerStaging(path: string, uid: number, gid: number): void {
  const walk = (entry: string) => {
    const stats = lstatSync(entry);
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) throw new Error("unsafe_root_path");
    if (stats.isDirectory()) for (const name of readdirSync(entry)) walk(join(entry, name));
    chownSync(entry, uid, gid);
  };
  assertRootTree(path); walk(path);
}

/**
 * Copies service-writable staging into new inodes behind a private root directory, rejects links/special files,
 * sets root:root and removes group/other write, then validates there against the pre-staging content pin.
 * First locks staging directories top-down so root's copy cannot race a pathname into a symlink. Open file
 * descriptors/hardlinks may still change source bytes, but never the copy. The caller removes the container.
 */
export function freezeInstallerArtifact(staging: string, parent: string, expected: BuildManifest, policy: RootPathPolicy = {}): { artifact: string; container: string } {
  assertRootPath(parent, policy);
  assertRootPath(dirname(staging), policy);
  const stagingUid = lstatSync(staging).uid;
  const lockDirectories = (path: string) => {
    const stats = lstatSync(path);
    if (stats.uid !== stagingUid || stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error("unsafe_root_path");
    if (stats.isDirectory()) {
      // Its parent is already protected, so the service cannot replace this entry between lstat/chown.
      if (policy.uid === undefined) chownSync(path, 0, 0);
      chmodSync(path, 0o755);
      for (const name of readdirSync(path)) lockDirectories(join(path, name));
    }
  };
  lockDirectories(staging);
  const container = mkdtempSync(join(parent, ".installer-release-")); chmodSync(container, 0o700);
  const artifact = join(container, "artifact");
  try {
    cpSync(staging, artifact, { recursive: true, verbatimSymlinks: true });
    const walk = (path: string) => {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error("unsafe_root_path");
      if (stats.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
      // A restrictive umask/source may remove readability; canonical release modes are checked below.
      chmodSync(path, (stats.mode & 0o777) & ~0o022);
      if (policy.uid === undefined) chownSync(path, 0, 0);
    };
    walk(artifact);
    assertRootTree(artifact, policy);
    const checked = validateArtifact(artifact, { runtime: true });
    if (!checked.ok || checked.manifest?.contentHash !== expected.contentHash || checked.manifest.artifactId !== expected.artifactId) throw new Error("release_copy_invalid");
    // Publish traversal only after the new tree is protected and validated.
    chmodSync(container, 0o755);
    return { artifact, container };
  } catch (error) { rmSync(container, { recursive: true, force: true }); throw error; }
}

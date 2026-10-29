import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { AppError } from "../errors";
import type { ProjectCollateralInventory } from "../memory/project-delete";
import { boxDirectories } from "./box-runtime";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const stat = (path: string) => { try { return lstatSync(path); } catch (error) { if (missing(error)) return null; throw error; } };
function beneath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

// The configured root is service authority. Canonicalize it once, then refuse links in every project boundary.
function directories(directory: string | null, projectId: string) {
  boxDirectories(directory ?? "/", projectId); // Validate identity even when execution is not configured.
  if (!directory) return null;
  const info = stat(directory);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError("box_directory_unsafe", 503);
  const root = realpathSync(directory), dirs = boxDirectories(root, projectId);
  for (const path of [dirs.project, dirs.workspace, dirs.profile]) {
    const info = stat(path);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory() || !beneath(root, realpathSync(path)) ||
        (path !== dirs.project && !beneath(dirs.project, realpathSync(path)))) throw new AppError("box_directory_unsafe", 503);
  }
  return dirs;
}

/** Identity-only, bounded workspace/profile inventory. Links inside a tree are counted but never traversed. */
export function previewBoxData(directory: string | null, projectId: string): Omit<ProjectCollateralInventory, "key"> {
  const dirs = directories(directory, projectId), digest = createHash("sha256"), details: NonNullable<ProjectCollateralInventory["details"]> = [];
  let seen = 0;
  for (const kind of ["workspace", "profile"] as const) {
    const identity = `${projectId}:${kind}`, root = dirs?.[kind];
    let bytes = 0, count = 0;
    const visit = (path: string): void => {
      if (++seen > 200_000) throw new AppError("box_inventory_scan_ceiling", 409);
      const info = lstatSync(path);
      digest.update(JSON.stringify([identity, relative(root!, path), info.mode, info.size, info.mtimeMs, info.ctimeMs]));
      if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
      else bytes += info.size;
      if (!Number.isSafeInteger(bytes)) throw new AppError("box_inventory_scan_ceiling", 409);
    };
    if (root && stat(root)) { count = 1; visit(root); }
    details.push({ identity, count, bytes });
  }
  digest.update(JSON.stringify(details));
  return { count: details.reduce((n, d) => n + d.count, 0), bytes: details.reduce((n, d) => n + d.bytes, 0),
    identities: details.map(d => d.identity), details, digest: digest.digest("hex") };
}

/** Deletes only the service-authorized workspace and profile; missing roots succeed, links at boundaries refuse. */
export function wipeBoxData(directory: string | null, projectId: string): void {
  const dirs = directories(directory, projectId);
  if (!dirs) return;
  for (const kind of ["workspace", "profile"] as const) {
    // Revalidate after any runtime work, never use a path supplied by the persisted preview.
    const path = directories(directory, projectId)![kind];
    rmSync(path, { recursive: true, force: true });
    if (stat(path)) throw new AppError("box_data_removal_unverified", 503);
  }
}

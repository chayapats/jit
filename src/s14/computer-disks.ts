import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";

/** Installer-owned, finite pairs of dedicated filesystems; paths never come from a Bot or model. */
export interface ComputerDiskPool { contract: "jit.computer-disk-pool/v1"; imageBytes: number; slots: string[] }
/** Validates the stable pool format shared by the installer and service. */
export function computerDiskPool(value: unknown): ComputerDiskPool {
  const p = value as ComputerDiskPool;
  if (!p || Object.keys(p).sort().join() !== "contract,imageBytes,slots" || p.contract !== "jit.computer-disk-pool/v1" ||
      p.imageBytes !== 1073741824 || !Array.isArray(p.slots) || p.slots.length < 8 || p.slots.length > 1024 ||
      p.slots.some((s, i) => s !== diskSlotId(i))) throw new AppError("computer_disk_pool_invalid", 503);
  return p;
}
/** Stable opaque identifier; extending a pool never renumbers its existing slots. */
export function diskSlotId(index: number): string { return `slot-${String(index + 1).padStart(4, "0")}`; }
/** Reads only an operator-protected manifest, refusing service-writable parents and symlinks. */
export function readComputerDiskPool(root: string): ComputerDiskPool {
  try {
    const path = join(root, "pool.json");
    for (let p = path;; p = dirname(p)) {
      const s = lstatSync(p);
      if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) || (p === path ? !s.isFile() : !s.isDirectory())) throw new Error();
      if (p === dirname(p)) break;
    }
    if (realpathSync(root) !== root) throw new Error();
    return computerDiskPool(JSON.parse(readFileSync(path, "utf8")));
  } catch { throw new AppError("computer_disk_pool_unavailable_rerun_installer", 503); }
}

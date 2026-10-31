import { chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { computerDiskPool, diskSlotId, type ComputerDiskPool } from "../../../src/s14/computer-disks";
import type { CommandRunner } from "../../../src/ops/supervisor";

const GiB = 1024 ** 3;
/** Remaining worst-case sparse growth must fit *available* host bytes, plus reserve and new images. */
export function diskPoolCapacity(free: number, reserve: number, existing: { size: number; allocated: number }[], additional: number): void {
  if (![free, reserve, additional, ...existing.flatMap(i => [i.size, i.allocated])].every(n => Number.isSafeInteger(n) && n >= 0) ||
      free < reserve + existing.reduce((sum, i) => sum + Math.max(0, i.size - i.allocated), 0) + additional * GiB) {
    throw new Error("computer_disk_pool_overcommit: free host capacity must cover every sparse image at full size plus reserve; free space or expand the host disk, then re-run the installer");
  }
}
/** systemd's path escaping, including literal hyphens; no shell or systemd generator is needed. */
export function diskMountUnit(path: string): string {
  return path.slice(1).split("/").map(part => [...Buffer.from(part)].map(b => /[A-Za-z0-9_:]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`).join("")).join("-") + ".mount";
}

/** Root-only install-time loop/ext4 provisioning. Existing images and mounted Bot contents are never reformatted. */
export async function provisionS14Disks(options: {
  root: string; dataRoot: string; uid: number; gid: number; slots?: number | undefined; reserveBytes: number;
  dryRun?: boolean; freeBytes?: number; run: CommandRunner;
}): Promise<ComputerDiskPool> {
  const { dataRoot, uid, gid } = options, dry = options.dryRun === true;
  const requested = options.slots ?? 8;
  if (!Number.isSafeInteger(requested) || requested < 8 || requested > 1024) throw new Error("computer_disk_pool_slots: choose 8..1024 slots");
  if (!dry && (process.getuid?.() !== 0 || options.root !== "/")) throw new Error("root_installer_required");
  const safe = (path: string) => {
    for (let p = path;; p = dirname(p)) {
      try {
        const s = lstatSync(p);
        if (s.isSymbolicLink() || !dry && (s.uid !== 0 || (s.mode & 0o022))) throw new Error("computer_disk_pool_unsafe_path");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (p === dirname(p) || dry && p === options.root) break;
    }
  };
  const dir = (path: string, mode: number) => { safe(path); mkdirSync(path, { recursive: true, mode }); chmodSync(path, mode); };
  const write = (path: string, text: string) => {
    safe(path);
    const temp = `${path}.${randomBytes(8).toString("hex")}`;
    try { writeFileSync(temp, text, { flag: "wx", mode: 0o644 }); chmodSync(temp, 0o644); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  };
  const must = async (argv: string[]) => {
    if (dry) return "";
    const r = await options.run(argv, { timeoutMs: 30000 });
    if (r.exitCode !== 0 || r.timedOut) throw new Error("computer_disk_pool_provision_failed: require loop devices, e2fsprogs and systemd mount support; repair the host and re-run the installer");
    return r.stdout.trim();
  };
  safe(dataRoot);
  const manifest = join(dataRoot, "pool.json");
  const previous = existsSync(manifest) ? computerDiskPool(JSON.parse(readFileSync(manifest, "utf8"))) : null;
  const count = Math.max(requested, previous?.slots.length ?? 0);
  const images = join(dataRoot, "images"), mounts = join(dataRoot, "slots");
  const files = Array.from({ length: count }, (_, i) => ["workspace", "profile"].map(role => ({
    image: join(images, `${diskSlotId(i)}-${role}.ext4`), mount: join(mounts, diskSlotId(i), role),
  }))).flat();
  const existing: { size: number; allocated: number }[] = [];
  for (const f of files) {
    safe(f.image);
    if (!existsSync(f.image)) continue;
    const s = lstatSync(f.image);
    if (!s.isFile() || s.nlink !== 1 || s.size !== GiB) throw new Error("computer_disk_pool_invalid_image");
    existing.push({ size: s.size, allocated: s.blocks * 512 });
  }
  // Check before mkdir/truncate/mkfs: sparse allocations are never mistaken for their full commitment.
  const backing = existsSync(images) ? images : existsSync(dataRoot) ? dataRoot : dirname(dataRoot);
  const fs = dry ? null : statfsSync(backing);
  diskPoolCapacity(fs ? fs.bavail * fs.bsize : options.freeBytes!, options.reserveBytes, existing, files.length - existing.length);
  dir(dataRoot, 0o755); dir(images, 0o700); dir(mounts, 0o755);
  const units = join(options.root, "etc/systemd/system"); dir(units, 0o755);
  for (const f of files) {
    dir(dirname(f.mount), 0o755);
    // Do not change ownership or permissions of an already mounted service filesystem.
    if (!existsSync(f.mount)) dir(f.mount, 0o700);
    const fresh = !existsSync(f.image);
    if (fresh) {
      const temp = `${f.image}.new`;
      safe(temp); rmSync(temp, { force: true });
      writeFileSync(temp, "", { flag: "wx", mode: 0o600 }); truncateSync(temp, GiB);
      await must(["mkfs.ext4", "-q", "-F", "-m", "0", temp]);
      renameSync(temp, f.image);
    }
    if (!dry && await must(["blkid", "-p", "-o", "value", "-s", "TYPE", f.image]) !== "ext4") throw new Error("computer_disk_pool_invalid_image");
    const unit = diskMountUnit(f.mount);
    write(join(units, unit), `[Unit]\nDescription=Jit S14 bounded computer disk\nBefore=jit-s14.service\n[Mount]\nWhat=${f.image}\nWhere=${f.mount}\nType=ext4\nOptions=loop,nodev,nosuid\n[Install]\nWantedBy=local-fs.target\n`);
    await must(["systemctl", "daemon-reload"]);
    await must(["systemctl", "enable", "--now", unit]);
    if (!dry) {
      // Assert the mount is this image before a privileged ownership change. Never chown an unmounted directory.
      const mounted = JSON.parse(await must(["findmnt", "--json", "--mountpoint", f.mount, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS"])).filesystems?.[0];
      if (mounted?.target !== f.mount || mounted.fstype !== "ext4" || !["nodev", "nosuid"].every(o => mounted.options?.split(",").includes(o)) ||
          await must(["losetup", "--noheadings", "--output", "BACK-FILE", mounted.source]) !== f.image) throw new Error("computer_disk_pool_mount_mismatch");
      chownSync(f.mount, uid, gid); chmodSync(f.mount, 0o700);
      const lost = join(f.mount, "lost+found");
      // The mount contents are service-writable: never follow a raced link during privileged ownership repair.
      let fd: number | undefined;
      try {
        fd = openSync(lost, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        if (fstatSync(fd).uid === 0) { fchownSync(fd, uid, gid); fchmodSync(fd, 0o700); }
      } catch (error) { if (!["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  const pool: ComputerDiskPool = { contract: "jit.computer-disk-pool/v1", imageBytes: GiB, slots: Array.from({ length: count }, (_, i) => diskSlotId(i)) };
  write(manifest, JSON.stringify(pool, null, 2) + "\n");
  return pool;
}

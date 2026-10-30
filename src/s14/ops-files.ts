import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { AppError } from "../errors";
import { writeFileAtomic } from "../ops/upgrade-fence";

/** Rejects symlink ancestors before accessing a service-owned maintenance path. */
export function opsPath(path: string): string {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/")) {
    current = resolve(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const systemAlias = process.platform === "darwin" && stat.uid === 0 &&
        (current === "/var" && realpathSync(current) === "/private/var" || current === "/tmp" && realpathSync(current) === "/private/tmp");
      if (!systemAlias) throw new AppError("s14_ops_path_untrusted", 409);
    }
  }
  return absolute;
}
/** Requires a private, same-owner directory with no symlink ancestors. */
export function opsDirectory(path: string): void {
  opsPath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new AppError("s14_ops_path_untrusted", 409);
}
/** Reads one bounded regular maintenance file without following its final entry. */
export function opsRead(path: string, maximum: number): Buffer {
  opsPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new AppError("s14_ops_bounds_or_type", 409);
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > maximum) throw new AppError("s14_ops_file_changed", 409);
    return bytes;
  } finally { closeSync(fd); }
}
/** Durably creates a private regular component exclusively; an existing name is never overwritten. */
export function opsWrite(path: string, bytes: Uint8Array | string): void {
  opsDirectory(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  opsSyncDirectory(dirname(path));
}
/** Reuses the legacy atomic journal primitive only after S14 path and private-directory validation. */
export function opsAtomic(path: string, value: unknown): void {
  opsDirectory(dirname(path));
  opsPath(path);
  writeFileAtomic(path, JSON.stringify(value));
}
/** Flushes rename metadata on supported Linux filesystems; failures keep maintenance fenced. */
export function opsSyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Replaces a validated sibling image atomically and durably while the external fence is held. */
export function opsRename(from: string, to: string): void {
  opsPath(from); opsPath(to);
  renameSync(from, to);
  opsSyncDirectory(dirname(to));
}

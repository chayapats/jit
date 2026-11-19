import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { desktopService } from "./boundary";

const owned = (uid: number) => process.getuid === undefined || uid === process.getuid();
/** Real owner-only directory. Existing symlinks, foreign ownership and broad access refuse instead of adoption. */
export function privateDesktopDirectory(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f]/.test(path)) throw new Error("desktop_path_invalid");
  const parent = realpathSync(dirname(path)), target = join(parent, basename(path));
  if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o077) !== 0) throw new Error("desktop_directory_invalid");
  return target;
}

/** Reads a bounded owner-only JSON record through a no-follow descriptor; its content is never printed. */
export function readDesktopRecord(path: string, maxBytes = 65536): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || !owned(info.uid) || (info.mode & 0o077) !== 0 || info.size > maxBytes) throw new Error("desktop_record_invalid");
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch { throw new Error("desktop_record_invalid"); } finally { closeSync(fd); }
}

/** Durable owner-only atomic record replacement in an already protected directory. Never follows a final symlink. */
export function writeDesktopRecord(path: string, value: unknown): void {
  writeDesktopFile(path, Buffer.from(JSON.stringify(value) + "\n"));
}

/** Atomically writes a private native bootstrap/entry file; callers supply only authored, verified bytes. */
export function writeDesktopFile(path: string, value: Uint8Array, mode: 0o600 | 0o700 = 0o600): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !owned(info.uid))) throw new Error("desktop_record_invalid");
  const temp = join(dirname(path), ".record-" + crypto.randomUUID()), fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, value); fsyncSync(fd); }
  catch (error) { rmSync(temp, { force: true }); throw error; } finally { closeSync(fd); }
  renameSync(temp, path); const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** One exact-service profile, without importing any owner/default browser profile. */
export function desktopProfile(root: string, service: string): { directory: string; origin: string; id: string } {
  const origin = desktopService(service), profiles = privateDesktopDirectory(join(privateDesktopDirectory(root), "profiles"));
  const id = createHash("sha256").update("jit.desktop.profile.v1\n" + origin).digest("hex"), directory = privateDesktopDirectory(join(profiles, id)), identity = join(directory, "identity.json");
  if (existsSync(identity)) {
    const value = readDesktopRecord(identity) as { contract?: unknown; origin?: unknown };
    if (value.contract !== "s16-desktop-profile/v1" || value.origin !== origin || Object.keys(value).length !== 2) throw new Error("desktop_profile_mismatch");
  } else writeDesktopRecord(identity, { contract: "s16-desktop-profile/v1", origin });
  return { directory, origin, id };
}

/**
 * Single writer for a managed private profile. A dead owner's exact lease can be recovered; no live process is killed.
 * PID reuse conservatively refuses. Browser's own SingletonLock remains an additional independent check.
 */
export function leaseDesktopProfile(directory: string, kind: "launcher" | "installation" = "launcher"): () => void {
  const path = join(directory, kind + ".lock");
  const acquire = () => { mkdirSync(path, { mode: 0o700 }); writeDesktopRecord(join(path, "owner.json"), { contract: "s16-desktop-lease/v1", pid: process.pid }); };
  try { acquire(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    privateDesktopDirectory(path);
    const owner = readDesktopRecord(join(path, "owner.json")) as { contract?: unknown; pid?: unknown };
    if (owner.contract !== "s16-desktop-lease/v1" || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) throw new Error("desktop_profile_busy");
    try { process.kill(Number(owner.pid), 0); throw new Error("desktop_profile_busy"); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("desktop_profile_busy"); }
    rmSync(join(path, "owner.json")); rmdirSync(path); acquire();
  }
  let released = false;
  return () => { if (released) return; released = true; rmSync(join(path, "owner.json")); rmdirSync(path); };
}

/**
 * A managed profile always starts on the literal blank page before native guards are installed. Preserve every
 * other Chrome preference; never restore tabs/form navigations ahead of the exact-service boundary after a crash.
 */
export function prepareDesktopStartup(directory: string): string {
  const browser = privateDesktopDirectory(join(directory, "browser"));
  const profile = privateDesktopDirectory(join(browser, "Default")), file = join(profile, "Preferences");
  const current = existsSync(file) ? readDesktopRecord(file, 8 * 1024 * 1024) : {};
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("desktop_preferences_invalid");
  const previous = current as Record<string, unknown>;
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  writeDesktopRecord(file, { ...previous, session: { ...object(previous.session), restore_on_startup: 5, startup_urls: [] }, profile: { ...object(previous.profile), exit_type: "Normal", exited_cleanly: true } });
  return browser;
}

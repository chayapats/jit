import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { validateEvidence } from "./contract";

/** Reads bounded regular JSON files without following a final symlink or returning filesystem diagnostics. */
export async function readBoundedJson(path: string, maximum: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat(); if (!stats.isFile() || stats.size > maximum) throw new Error("invalid_local_record");
    const buffer = Buffer.alloc(maximum + 1); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error("invalid_local_record");
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await file.close(); }
}
async function localDirectory(root: string, create: boolean): Promise<string> {
  const local = resolve(root, ".local");
  if (create) { try { await mkdir(local, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const info = await lstat(local); if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("unsafe_local_directory");
  return realpath(local);
}
/** Config must resolve beneath this installation's ignored .local directory, never an arbitrary credential path. */
export async function readLocalConfig(root: string, path: string): Promise<unknown> {
  const local = await localDirectory(root, false), file = resolve(root, path);
  const parent = await realpath(dirname(file)), rel = relative(local, parent);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("configuration_must_be_local");
  return readBoundedJson(file, 8192);
}
async function recordsDirectory(root: string, create: boolean): Promise<string> {
  const local = await localDirectory(root, create), dir = resolve(local, "host-evidence");
  if (create) { try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const stats = await lstat(dir); if (!stats.isDirectory() || stats.isSymbolicLink() || stats.mode & 0o077) throw new Error("unsafe_evidence_directory");
  return dir;
}
/** Writes a validated, bounded mode-0600 record once; failures remove any incomplete new artifact. */
export async function writeEvidence(root: string, value: unknown): Promise<void> {
  validateEvidence(value);
  const dir = await recordsDirectory(root, true), path = resolve(dir, `${value.id}.json`);
  const file = await open(path, "wx", 0o600); let complete = false;
  try {
    await file.writeFile(JSON.stringify(value) + "\n"); await file.sync();
    const parent = await open(dir, "r"); try { await parent.sync(); } finally { await parent.close(); }
    complete = true;
  }
  finally { await file.close(); if (!complete) await unlink(path); }
}
/** Reads only a named versioned record; malformed or unknown-field artifacts cannot be exported. */
export async function readEvidence(root: string, id: string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error("invalid_evidence_id");
  const dir = await recordsDirectory(root, false), value = await readBoundedJson(resolve(dir, `${id}.json`), 32769);
  validateEvidence(value); return value;
}

import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validateDrillRecord } from "./contracts";
import { readBoundedJson } from "../evidence/records";

/** Ops evidence validation covers drill, profile and release records with shared envelope rules. */
function validateOpsRecord(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_ops_record");
  const schema = (value as { schema?: unknown }).schema;
  if (schema === "jit.ops.drill/v1") { validateDrillRecord(value); return; }
  if (schema === "jit.ops.profile/v1" || schema === "jit.ops.release/v1") {
    const r = value as Record<string, unknown>;
    const keys = schema === "jit.ops.profile/v1"
      ? ["schema", "id", "observedAt", "installationLabel", "drillId", "versions", "config", "measurements", "exhaustedLimits", "sampleLimitations", "piReadiness", "nextAction"]
      : ["schema", "id", "observedAt", "installationLabel", "drillId", "deterministic", "human", "outcome", "nextAction"];
    if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) throw new Error("invalid_ops_record");
    if (Buffer.byteLength(JSON.stringify(value)) > 32768) throw new Error("invalid_ops_record");
    return;
  }
  throw new Error("invalid_ops_record");
}

async function localDirectory(root: string, create: boolean): Promise<string> {
  const local = resolve(root, ".local");
  if (create) { try { await mkdir(local, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const info = await lstat(local);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("unsafe_local_directory");
  return realpath(local);
}

/** Drill invocation files must resolve beneath this installation's ignored `.local` directory. */
export async function readLocalDrillConfig(root: string, path: string): Promise<unknown> {
  const local = await localDirectory(root, false), file = resolve(root, path);
  const parent = await realpath(dirname(file)), rel = relative(local, parent);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("configuration_must_be_local");
  return readBoundedJson(file, 8192);
}

async function recordsDirectory(root: string, create: boolean): Promise<string> {
  const local = await localDirectory(root, create), dir = resolve(local, "ops-evidence");
  if (create) { try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const stats = await lstat(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.mode & 0o077) throw new Error("unsafe_ops_directory");
  return dir;
}

/** Writes a validated, bounded mode-0600 record once; failures remove any incomplete new artifact. */
export async function writeOpsRecord(root: string, value: unknown): Promise<void> {
  validateOpsRecord(value);
  const dir = await recordsDirectory(root, true), path = join(dir, `${(value as { id: string }).id}.json`);
  const file = await open(path, "wx", 0o600);
  let complete = false;
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
    const parent = await open(dir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(path);
  }
}

/** Reads only a named versioned record; malformed or unknown-field artifacts cannot be exported. */
export async function readOpsRecord(root: string, id: string): Promise<unknown> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error("invalid_ops_record_id");
  const dir = await recordsDirectory(root, false), value = await readBoundedJson(join(dir, `${id}.json`), 32769);
  validateOpsRecord(value);
  return value;
}

/** Rebuilds the allowlisted export: full route/model detail never leaves local records. */
export function exportOpsSummary(value: unknown): Record<string, unknown> {
  validateOpsRecord(value);
  const r = value as { schema: string; id: string; observedAt: string; outcome?: string; nextAction?: string;
    legs?: { leg: string; state: string; elapsedMs: number }[]; measurements?: Record<string, unknown> };
  return { schema: r.schema, recordId: r.id, observedAt: r.observedAt,
    legs: (r.legs ?? []).map(l => ({ leg: l.leg, state: l.state, elapsedMs: l.elapsedMs })),
    measurements: r.measurements ?? {}, outcome: r.outcome ?? "blocked", nextAction: r.nextAction ?? "resolve-blocked-work" };
}


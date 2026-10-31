import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../../src/errors";

/** Private recovery marker; a retained marker always refuses a fresh run, including after success. */
export interface InputEvidenceState { contract: "ops.s14-input-evidence-state/v1"; runId: string; password: string | null; phase: "running" | "failed" | "passed" | "cleaned" }
const refuse = (): never => { throw new AppError("input_evidence_unsafe_or_stale_state_cleanup_only"); };
function privateEntry(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) refuse();
}

/** Writes bounded owner-only diagnostic records with no links, sync and no stdout side channel. */
export function writeInputEvidencePrivate(path: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 32768) throw new AppError("input_evidence_record_bound");
  if (existsSync(path)) privateEntry(path, false);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Uses one unique independent store/ledger under a private owned marker; never resumes an uncertain evidence round. */
export function prepareInputEvidenceState(root: string, cleanupOnly: boolean): { state: InputEvidenceState; storePath: string; statePath: string; resultPath: string } {
  if (!cleanupOnly) {
    if (existsSync(root)) refuse();
    mkdirSync(root, { mode: 0o700 });
    const state: InputEvidenceState = { contract: "ops.s14-input-evidence-state/v1", runId: randomBytes(16).toString("hex"), password: randomBytes(32).toString("hex"), phase: "running" };
    mkdirSync(join(root, state.runId), { mode: 0o700 });
    writeInputEvidencePrivate(join(root, "private.json"), state);
  }
  privateEntry(root, true);
  const path = join(root, "private.json"); privateEntry(path, false);
  if (lstatSync(path).size > 4096) refuse();
  const state = JSON.parse(readFileSync(path, "utf8")) as InputEvidenceState;
  if (!state || Object.keys(state).sort().join() !== "contract,password,phase,runId" || state.contract !== "ops.s14-input-evidence-state/v1" || !/^[a-f0-9]{32}$/.test(state.runId) || !["running", "failed", "passed", "cleaned"].includes(state.phase) || (state.password !== null && !/^[a-f0-9]{64}$/.test(state.password))) refuse();
  if (cleanupOnly && (state.password === null || ["passed", "cleaned"].includes(state.phase))) refuse();
  const children = readdirSync(root);
  if (children.some(name => !["private.json", "result.json", state.runId].includes(name))) refuse();
  const directory = join(root, state.runId); privateEntry(directory, true);
  let total = 0;
  const files = readdirSync(directory);
  if (files.length > 8) refuse();
  for (const name of files) {
    if (!/^application\.sqlite(?:\.lifecycle\.sqlite)?(?:-journal|-wal|-shm)?$/.test(name)) refuse();
    const file = join(directory, name); privateEntry(file, false); total += lstatSync(file).size;
  }
  if (total > 32 * 1024 ** 2) refuse();
  if (children.includes("result.json")) { privateEntry(join(root, "result.json"), false); if (lstatSync(join(root, "result.json")).size > 32768) refuse(); }
  return { state, storePath: join(directory, "application.sqlite"), statePath: path, resultPath: join(root, "result.json") };
}

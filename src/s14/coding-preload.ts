import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";
import { CodingGitMirror } from "./coding-git-mirror";
import type { GitProcessLimits } from "./coding-git-limits";
import { codingCommit, codingOrigin } from "./coding-protocol";
import type { CodingRepository, CodingRepositoryFetch } from "./coding-types";

const schedule = (expire: () => void, timeoutMs: number) => { const timer = setTimeout(expire, timeoutMs); return () => clearTimeout(timer); };
const packet = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;

async function inspectObjects(mirror: CodingGitMirror, secret: string | undefined, signal: AbortSignal, allowed: () => void): Promise<void> {
  // Inspect decoded bytes too: a remote must not reflect the authenticated value inside compressed objects.
  const forbidden = secret === undefined ? [] : [secret, Buffer.from(secret).toString("base64"), Buffer.from(`x-access-token:${secret}`).toString("base64")].map(value => Buffer.from(value));
  const overlap = Math.max(0, ...forbidden.map(value => value.length - 1));
  let decoded = 0, tail = Buffer.alloc(0);
  const inspected = await mirror.git(["-C", mirror.path, "cat-file", "--batch-all-objects", "--batch"], {
    signal, inspect(chunk) {
      allowed();
      decoded += chunk.length;
      if (decoded > 32 * 1024 * 1024) throw new AppError("coding_preload_size_limit", 413);
      const bytes = Buffer.concat([tail, chunk]);
      if (forbidden.some(value => bytes.includes(value))) throw new AppError("coding_preload_credential_refused", 403);
      tail = overlap ? bytes.subarray(-overlap) : Buffer.alloc(0);
    },
  });
  allowed();
  if (inspected.code !== 0) throw new AppError("coding_preload_objects_refused", 409);
}

/** Fetches one pinned GitHub commit as bounded data; no checkout, hooks, filters, submodules or remote config run on the host. */
export async function repositoryBundle(repository: CodingRepository, secret: string | undefined, signal: AbortSignal,
  allowed: () => void, transport: CodingRepositoryFetch = fetch, limits = { packBytes: 16 * 1024 * 1024, timeoutMs: 60000, schedule }, gitLimits?: GitProcessLimits): Promise<Uint8Array> {
  const maximumPack = limits.packBytes;
  codingOrigin(repository.url);
  codingCommit(repository.baseCommit);
  const controller = new AbortController();
  let timedOut = false;
  const clearDeadline = limits.schedule(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) throw new AppError("coding_cancelled", 409);
    let abort!: () => void;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        abort = () => reject(new AppError("coding_cancelled", 409));
        controller.signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { controller.signal.removeEventListener("abort", abort); }
  };
  let mirror: CodingGitMirror | undefined;
  try {
    allowed();
    // Smart HTTP v0, no side-band/thin pack: exactly NAK followed by one complete pack.
    // The remote receives only the exact SHA. Redirects and all alternate protocols refuse.
    const response = await wait(transport(`${repository.url}/git-upload-pack`, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result", "accept-encoding": "identity",
        ...(secret === undefined ? {} : { authorization: `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}` }) },
      body: `${packet(`want ${repository.baseCommit} ofs-delta\n`)}0000${packet("done\n")}` }));
    allowed();
    if (response.status !== 200 || response.headers.get("content-type") !== "application/x-git-upload-pack-result" ||
        ![null, "identity"].includes(response.headers.get("content-encoding")) || !response.body) throw new AppError("coding_preload_protocol_refused", 409);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumPack + 8)) throw new AppError("coding_preload_size_limit", 413);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await wait(reader.read());
        allowed();
        if (item.done) break;
        size += item.value.length;
        if (size > maximumPack + 8) throw new AppError("coding_preload_size_limit", 413);
        chunks.push(item.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    if (declared !== null && Number(declared) !== size) throw new AppError("coding_preload_protocol_refused", 409);
    const bytes = Buffer.concat(chunks);
    const pack = bytes.subarray(8);
    if (pack.length < 32 || !createHash("sha1").update(pack.subarray(0, -20)).digest().equals(pack.subarray(-20))) throw new AppError("coding_preload_protocol_refused", 409);
    if (bytes.subarray(0, 12).toString("binary") !== "0008NAK\nPACK") throw new AppError("coding_preload_protocol_refused", 409);
    if (secret !== undefined && bytes.includes(Buffer.from(secret))) throw new AppError("coding_preload_credential_refused", 403);
    const objects = mirror = new CodingGitMirror(gitLimits);
    const git = async (args: string[], input?: Uint8Array) => {
      allowed();
      const result = await objects.git(args, { signal: controller.signal, ...(input ? { input } : {}) });
      allowed();
      if (result.code !== 0) throw new AppError("coding_preload_objects_refused", 409);
      return result.stdout.trim();
    };
    await git(["init", "--bare", `--template=${join(mirror.directory, "empty-template")}`, mirror.path]);
    await git(["-C", mirror.path, "index-pack", "--stdin", "--strict", `--max-input-size=${maximumPack}`], pack);
    if (await git(["-C", mirror.path, "cat-file", "-t", repository.baseCommit]) !== "commit") throw new AppError("coding_preload_commit_mismatch", 409);
    await git(["-C", mirror.path, "update-ref", "refs/heads/preload", repository.baseCommit]);
    await git(["-C", mirror.path, "fsck", "--strict", "--no-reflogs"]);
    await inspectObjects(mirror, secret, controller.signal, allowed);
    const file = join(mirror.directory, "preload.bundle");
    await git(["-C", mirror.path, "bundle", "create", file, "refs/heads/preload"]);
    if (statSync(file).size > maximumPack) throw new AppError("coding_preload_size_limit", 413);
    const bundle = readFileSync(file);
    if (!bundle.length || bundle.length > maximumPack || (secret !== undefined && bundle.includes(Buffer.from(secret)))) throw new AppError("coding_preload_size_limit", 413);
    if (await git(["-C", mirror.path, "bundle", "list-heads", file]) !== `${repository.baseCommit} refs/heads/preload`) throw new AppError("coding_preload_commit_mismatch", 409);
    allowed();
    if (controller.signal.aborted) throw new AppError("coding_cancelled", 409);
    return bundle;
  } catch (error) {
    if (timedOut) throw new AppError("coding_preload_timeout", 409);
    if (signal.aborted) throw new AppError("coding_cancelled", 409);
    if (error instanceof AppError) throw error;
    throw new AppError("coding_preload_unavailable", 503);
  } finally {
    clearDeadline();
    controller.abort();
    signal.removeEventListener("abort", cancel);
    mirror?.close();
  }
}

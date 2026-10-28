import type {
  ExecutionBackend, ExecutionDirectoryEntry, ExecutionFileObservation, ExecutionSearchRequest, ExecutionSearchResult, ExecutionSpawnRequest, ExecutionSpawnResult,
} from "schway/host";
import { AppError } from "../errors";
import type { BoxHandle, BoxRuntime } from "./box-runtime";

/** Options of {@link createBoxBackend}. */
export interface BoxBackendOptions {
  /** Applied to every command output and search line before Schway sees it (the connection redaction guard). */
  redact?: (text: string) => string;
  /** Host-side deadline of one non-spawn runner call (default 90 s; the runner's own limits are tighter). */
  callMs?: number;
}

/** Bytes per `read` request; the runner's fixed chunk limit. */
export const boxReadChunkBytes = 1_048_576;
const spawnGraceMs = 30_000;
const killMs = 10_000;
const defaultSpawnMs = 1_800_000;

interface RunnerResponse { v: 1; ok: boolean; result?: unknown; error?: { code?: unknown } }

/** A Node-style failure Schway maps to its model-visible error text. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
const decode = (base64: string) => Uint8Array.from(Buffer.from(base64, "base64"));
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
const knownCodes = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ECHANGED", "EINVAL", "EFBIG", "E2BIG", "EIO", "EPROTO"]);

/**
 * exec.box_backend/v1 (EXE03) — Schway's `ExecutionBackend` (`schway.host.core-tools/v1`) over the box runner.
 *
 * Each member is one `jit.box.runner/v1` request through {@link BoxRuntime.exec}; paths are the box paths of
 * `handle` (`/workspace`, `/tmp`). Schway keeps ownership of everything model-facing — path resolution and
 * confinement, the 50,000-byte output caps, truncation notices and spill files — so the core tools produce the same
 * output through a box as in process. The runner adds its own confinement to `/workspace` (realpath checks).
 *
 * - `readFile` streams 1 MiB chunks, one request each, and stops when iteration stops.
 * - `observeFile` returns opaque observations; `writeFileAtomically` only accepts observations this backend issued
 *   (`TypeError` otherwise) and the runner rejects a changed path with `ECHANGED`.
 * - `glob` lists regular files under `cwd` in the box (hidden directories pruned unless the pattern names one) and
 *   matches them on the host with `Bun.Glob`, the matcher of Schway's local backend.
 * - `spawn` runs `bash -c` in its own process group in the box. Cancellation sends a runner `kill` for that group
 *   (reaching the process inside the box, not only the `podman exec` client), then rejects with `AbortError`; a
 *   result that arrives after cancellation is never returned. Output is delivered to `onOutput` once the command ends.
 * - Runner failures reject with a Node-style `code` (`ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `ECHANGED`, …); a
 *   runner or transport failure is `EIO`.
 */
export function createBoxBackend(runtime: BoxRuntime, handle: BoxHandle, options: BoxBackendOptions = {}): ExecutionBackend {
  const redact = options.redact ?? (text => text);
  const callMs = options.callMs ?? 90_000;
  const observations = new WeakMap<ExecutionFileObservation, string>();

  async function call<T>(request: Record<string, unknown>, settings: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (settings.signal?.aborted) throw abortError();
    let result;
    try {
      result = await runtime.exec(handle, {
        input: new TextEncoder().encode(JSON.stringify({ v: 1, ...request })), timeoutMs: settings.timeoutMs ?? callMs,
        ...(settings.signal ? { signal: settings.signal } : {}),
      });
    } catch (error) {
      if (settings.signal?.aborted) throw abortError();
      throw error instanceof AppError ? errno("EIO") : error;
    }
    if (settings.signal?.aborted) throw abortError();
    let response: RunnerResponse;
    try { response = JSON.parse(new TextDecoder().decode(result.stdout)) as RunnerResponse; } catch { throw errno("EIO"); }
    if (result.exitCode !== 0 || !response || response.v !== 1) throw errno("EIO");
    if (!response.ok) {
      const code = typeof response.error?.code === "string" && knownCodes.has(response.error.code) ? response.error.code : "EIO";
      throw errno(code);
    }
    return response.result as T;
  }

  return {
    workspaceRoot: handle.workspaceRoot,
    temporaryDirectory: handle.temporaryDirectory,
    async realpath(path) { return (await call<{ path: string }>({ op: "realpath", path })).path; },
    async stat(path) { return { type: (await call<{ type: "file" | "directory" | "other" }>({ op: "stat", path })).type }; },
    readFile(path, readOptions) {
      return (async function* () {
        for (let offset = 0; ;) {
          const chunk = await call<{ data: string; eof: boolean }>({ op: "read", path, offset, length: boxReadChunkBytes }, readOptions?.signal ? { signal: readOptions.signal } : {});
          const bytes = decode(chunk.data);
          if (bytes.length) yield bytes;
          offset += bytes.length;
          if (chunk.eof || bytes.length === 0) return;
        }
      })();
    },
    async observeFile(path, observeOptions) {
      const observed = await call<{ targetExists: boolean; token: string; data?: string } | null>(
        { op: "observe", path, content: observeOptions?.content === true }, observeOptions?.signal ? { signal: observeOptions.signal } : {});
      if (!observed) return null;
      const observation: ExecutionFileObservation = { targetExists: observed.targetExists, ...(observed.data !== undefined ? { bytes: decode(observed.data) } : {}) };
      observations.set(observation, observed.token);
      return observation;
    },
    async writeFileAtomically(path, content, writeOptions = {}) {
      let observed: string | null | undefined;
      if (writeOptions.observed === null) observed = null;
      else if (writeOptions.observed !== undefined) {
        observed = observations.get(writeOptions.observed);
        if (observed === undefined) throw new TypeError("File observation was not issued by this backend");
      }
      await call({ op: "write", path, data: encode(content), createParents: writeOptions.createParents === true, ...(observed !== undefined ? { observed } : {}) },
        writeOptions.signal ? { signal: writeOptions.signal } : {});
    },
    async writePrivateFile(path, content) { await call({ op: "writePrivate", path, data: encode(content) }); },
    async list(path, listOptions) {
      const listed = await call<{ entries: ExecutionDirectoryEntry[] }>({ op: "list", path }, listOptions?.signal ? { signal: listOptions.signal } : {});
      return listed.entries;
    },
    glob(pattern, globOptions) {
      return (async function* () {
        // Bun.Glob skips dot entries unless the pattern names one; prune hidden trees in the box the same way.
        const dot = pattern.split("/").some(segment => segment.startsWith("."));
        const listed = await call<{ files: string[] }>({ op: "glob", cwd: globOptions.cwd, dot }, globOptions.signal ? { signal: globOptions.signal } : {});
        const matcher = new Bun.Glob(pattern);
        for (const file of listed.files) if (matcher.match(file)) yield file;
      })();
    },
    async search(request: ExecutionSearchRequest): Promise<ExecutionSearchResult> {
      const result = await call<ExecutionSearchResult>({
        op: "search", pattern: request.pattern, path: request.path, cwd: request.cwd, limit: request.limit,
        ...(request.glob !== undefined ? { glob: request.glob } : {}), ...(request.ignoreCase !== undefined ? { ignoreCase: request.ignoreCase } : {}),
      }, request.signal ? { signal: request.signal } : {});
      return { matches: result.matches.map(match => ({ ...match, text: redact(match.text) })), truncated: result.truncated,
        ...(result.failure !== undefined ? { failure: redact(result.failure) } : {}) };
    },
    async spawn(request: ExecutionSpawnRequest): Promise<ExecutionSpawnResult> {
      if (request.signal?.aborted) throw abortError();
      const id = crypto.randomUUID();
      const env = request.env === undefined ? undefined
        : Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const transport = new AbortController();
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        // Kill the process group inside the box, then release the exec client whatever the kill call did.
        void call({ op: "kill", id }, { timeoutMs: killMs }).catch(() => undefined).finally(() => transport.abort());
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const timeoutMs = request.timeoutMs ?? defaultSpawnMs;
        const result = await call<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>(
          { op: "spawn", id, command: request.command, cwd: request.cwd, ...(env ? { env } : {}), ...(request.timeoutMs !== undefined ? { timeoutMs } : {}) },
          { signal: transport.signal, timeoutMs: timeoutMs + spawnGraceMs },
        ).catch(error => { if (cancelled) throw abortError(); throw error; });
        if (cancelled || request.signal?.aborted) throw abortError();
        const text = (base64: string) => redact(new TextDecoder("utf-8").decode(decode(base64)));
        const stdout = text(result.stdout), stderr = text(result.stderr);
        if (stdout) request.onOutput?.({ stream: "stdout", text: stdout });
        if (stderr) request.onOutput?.({ stream: "stderr", text: stderr });
        return { stdout, stderr, exitCode: result.exitCode, timedOut: result.timedOut };
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

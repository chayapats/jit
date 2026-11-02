import type { ExecutionBackend, ExecutionDirectoryEntry, ExecutionFileObservation, ExecutionSpawnResult } from "schway/host";
import { containsCredential, redactCredentials } from "../../security/credentials";
import { redactRegisteredSecrets } from "../../security/secret-fingerprints";
import type { VmLimits } from "./types";
import { vmBytes, vmFail, vmInteger, vmPath, vmRecord } from "./validation";

/** Trusted private per-session invocation. Implementations claim/guard/capture/publish before returning data. */
export interface VmBackendPort {
  protocolError?(): void;
  call(operation: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal): Promise<Record<string, unknown>>;
}
const safeBytes = (bytes: Uint8Array): Uint8Array => { if (containsCredential(Buffer.from(bytes).toString("utf8"))) vmFail("vm_sensitive_output", 403); return bytes; };
const prefix = (text: string, bytes: number): string => {
  const encoded = Buffer.from(text); if (encoded.length <= bytes) return text;
  let end = Math.max(0, bytes); while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
};
const clean = (s: string) => redactRegisteredSecrets(redactCredentials(s)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
/** Public Schway backend over the VM port; observations are backend-instance/path-bound and cannot be serialized. */
export function createVmBackend(port: VmBackendPort, root: string, temporaryDirectory: string, limits: VmLimits,
  proxyEnvironment: Readonly<Record<string, string>> = {}, access: "inspect" | "execute" = "execute"): ExecutionBackend {
  function bad(): never { port.protocolError?.(); return vmFail("vm_protocol_invalid"); }
  function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    try { return vmRecord(value, keys); } catch { return bad(); }
  }
  function returnedPath(value: unknown): string {
    try { return vmPath(value as string, [root, temporaryDirectory]); } catch { return bad(); }
  }
  const decode = (v: unknown, max: number): Uint8Array => { try { return vmBytes(v, max); } catch { return bad(); } };
  const roots = [root, temporaryDirectory], path = (p: string) => vmPath(p, roots);
  const observations = new WeakMap<ExecutionFileObservation, { path: string; token: string }>();
  const call = (r: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal) => {
    if (access === "inspect" && kind !== "read") vmFail("vm_inspect_only", 403);
    return port.call(r, kind, signal);
  };
  async function entries(p: string, recursive: boolean, signal?: AbortSignal): Promise<ExecutionDirectoryEntry[]> {
    const r = await call({ op: "list", path: path(p), recursive }, "read", signal); record(r, ["entries"]);
    if (!Array.isArray(r.entries) || r.entries.length > 10000) bad();
    return r.entries.map(e => {
      const entry = record(e, ["name", "type"]);
      if (typeof entry.name !== "string" || !entry.name || Buffer.byteLength(entry.name) > 4096 || (!recursive && entry.name.includes("/"))) bad();
      returnedPath(`${p}/${entry.name}`); if (containsCredential(entry.name)) vmFail("vm_sensitive_output", 403);
      if (!["file", "directory", "symlink", "other"].includes(entry.type as string)) bad();
      return { name: entry.name, type: entry.type as ExecutionDirectoryEntry["type"] };
    });
  }
  function processResult(r: Record<string, unknown>): ExecutionSpawnResult {
    record(r, ["stdout", "stderr", "exitCode", "timedOut", "truncated", "totalBytes"]);
    const stdoutBytes = decode(r.stdout, limits.outputBytes), stderrBytes = decode(r.stderr, limits.outputBytes);
    if (stdoutBytes.length + stderrBytes.length > limits.outputBytes || typeof r.timedOut !== "boolean" || typeof r.truncated !== "boolean" || (r.timedOut && r.exitCode !== null)) bad();
    if (r.exitCode !== null) vmInteger(r.exitCode, 255, 0);
    vmInteger(r.totalBytes, Number.MAX_SAFE_INTEGER, 0);
    if (r.totalBytes < stdoutBytes.length + stderrBytes.length || (!r.truncated && r.totalBytes !== stdoutBytes.length + stderrBytes.length)) bad();
    const fullOut = clean(Buffer.from(stdoutBytes).toString("utf8")), fullError = clean(Buffer.from(stderrBytes).toString("utf8"));
    const notice = r.truncated || Buffer.byteLength(fullOut) + Buffer.byteLength(fullError) > limits.outputBytes ? prefix("\n[VM output truncated]", limits.outputBytes) : "";
    const budget = limits.outputBytes - Buffer.byteLength(notice), stdout = prefix(fullOut, budget), stderr = prefix(fullError, budget - Buffer.byteLength(stdout)) + notice;
    return { stdout, stderr, exitCode: r.exitCode as number | null, timedOut: r.timedOut as boolean };
  }
  const backend: ExecutionBackend = {
    workspaceRoot: root, temporaryDirectory,
    async realpath(p) { const r = await call({ op: "realpath", path: path(p) }, "read"); record(r, ["path"]); return returnedPath(r.path); },
    async stat(p) { const r = await call({ op: "stat", path: path(p) }, "read"); record(r, ["type"]); if (!["file", "directory", "other"].includes(r.type as string)) bad(); return { type: r.type as "file" | "directory" | "other" }; },
    async *readFile(p, options) { const r = await call({ op: "read", path: path(p) }, "read", options?.signal); record(r, ["data"]); yield safeBytes(decode(r.data, limits.fileBytes)); },
    async observeFile(p, options) {
      path(p); const r = await call({ op: "observe", path: p, content: options?.content === true }, "read", options?.signal); record(r, ["token", "data"]);
      if (r.token === null) { if (r.data !== null) bad(); return null; }
      if (typeof r.token !== "string" || !/^[a-f0-9]{64}$/.test(r.token)) bad();
      const observation: ExecutionFileObservation = Object.freeze({ targetExists: true, ...(r.data === null ? {} : { bytes: safeBytes(decode(r.data, limits.fileBytes)) }) });
      observations.set(observation, { path: p, token: r.token }); return observation;
    },
    async writeFileAtomically(p, content, options) {
      path(p); if (typeof content !== "string" || !content.isWellFormed() || Buffer.byteLength(content) > limits.fileBytes) vmFail("vm_output_limit");
      let observed: string | null | undefined;
      if (options && Object.hasOwn(options, "observed")) {
        if (options.observed === null) observed = null;
        else {
          const own = options.observed && observations.get(options.observed);
          if (!own || own.path !== p) throw new TypeError("Invalid VM file observation");
          observed = own.token;
        }
      }
      const r = await call({ op: "write", path: p, data: Buffer.from(content).toString("base64"), createParents: options?.createParents === true, ...(observed === undefined ? {} : { observed }) }, "write", options?.signal); record(r, []);
    },
    async writePrivateFile(p, content) { vmPath(p, [temporaryDirectory]); await backend.writeFileAtomically(p, content); },
    list: (p, options) => entries(p, false, options?.signal),
    async *glob(pattern, options) {
      if (typeof pattern !== "string" || pattern.length > 4096 || pattern.includes("\0")) vmFail("vm_path_denied");
      const glob = new Bun.Glob(pattern);
      for (const e of await entries(path(options.cwd), true, options.signal)) if (e.type === "file" && glob.match(e.name)) yield e.name;
    },
    async search(request) {
      path(request.path); path(request.cwd); vmInteger(request.limit, 1000);
      if (typeof request.pattern !== "string" || Buffer.byteLength(request.pattern) > 4096) vmFail("vm_limit_invalid");
      // Regex evaluation stays in the bounded guest process, not the protected JS event loop.
      if (request.glob !== undefined && (typeof request.glob !== "string" || request.glob.length > 4096 || request.glob.includes("\0"))) vmFail("vm_limit_invalid");
      const result = processResult(await call({ op: "search", path: request.path, cwd: request.cwd, pattern: request.pattern,
        limit: request.limit, ignoreCase: request.ignoreCase === true, glob: request.glob ?? null, timeoutMs: Math.min(limits.commandMs, 20000) }, "read", request.signal));
      if (result.timedOut || result.stderr.includes("[VM output truncated]")) return { matches: [], truncated: true, failure: "VM search exceeded its limit" };
      if (result.exitCode !== 0 && result.exitCode !== 1) return { matches: [], truncated: false, failure: "VM search unavailable" };
      const matches: { path: string; line: number; text: string }[] = []; let truncated = false;
      for (const line of result.stdout.split("\n")) if (line) {
        let event; try { event = JSON.parse(line); } catch { bad(); }
        if (event.type !== "match") continue;
        const p = returnedPath(event.data?.path?.text); vmInteger(event.data?.line_number);
        if (typeof event.data?.lines?.text !== "string") bad();
        if (matches.length >= request.limit) { truncated = true; break; }
        matches.push({ path: p, line: event.data.line_number, text: clean(event.data.lines.text.replace(/\n$/, "")) });
      }
      return { matches, truncated };
    },
    async spawn(request) {
      path(request.cwd); const timeoutMs = request.timeoutMs ?? limits.commandMs; vmInteger(timeoutMs, limits.commandMs);
      if (typeof request.command !== "string" || !request.command.isWellFormed() || request.command.includes("\0") || Buffer.byteLength(request.command) > 131072) vmFail("vm_limit_invalid");
      const env: Record<string, string> = { ...proxyEnvironment };
      for (const [key, value] of Object.entries(request.env ?? {})) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|KEY|PROXY)|^(?:PATH|HOME|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|GIT_CONFIG.*|SSH_.*)$/.test(key) || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4096) vmFail("vm_environment_denied", 403);
        env[key] = value;
      }
      const r = await call({ op: "spawn", command: request.command, cwd: request.cwd, env, timeoutMs }, "shell", request.signal);
      const { stdout, stderr, exitCode, timedOut } = processResult(r);
      if (stdout) request.onOutput?.({ stream: "stdout", text: stdout });
      if (stderr) request.onOutput?.({ stream: "stderr", text: stderr });
      return { stdout, stderr, exitCode, timedOut };
    },
  };
  return backend;
}

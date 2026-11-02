import type { ExecutionBackend, ExecutionDirectoryEntry, ExecutionFileObservation } from "schway/host";
import { redactCredentials } from "../../security/credentials";
import { redactRegisteredSecrets } from "../../security/secret-fingerprints";
import type { VmLimits } from "./types";
import { vmBytes, vmFail, vmInteger, vmPath, vmRecord } from "./validation";

/** Trusted private per-session invocation. Implementations claim/guard/capture/publish before returning data. */
export interface VmBackendPort {
  call(operation: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal): Promise<Record<string, unknown>>;
}
const clean = (s: string) => redactRegisteredSecrets(redactCredentials(s)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
/** Public Schway backend over the VM port; observations are backend-instance/path-bound and cannot be serialized. */
export function createVmBackend(port: VmBackendPort, root: string, temporaryDirectory: string, limits: VmLimits,
  proxyEnvironment: Readonly<Record<string, string>> = {}): ExecutionBackend {
  const roots = [root, temporaryDirectory], path = (p: string) => vmPath(p, roots);
  const observations = new WeakMap<ExecutionFileObservation, { path: string; token: string }>();
  const call = (r: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal) => port.call(r, kind, signal);
  async function entries(p: string, recursive: boolean, signal?: AbortSignal): Promise<ExecutionDirectoryEntry[]> {
    const r = await call({ op: "list", path: path(p), recursive }, "read", signal); vmRecord(r, ["entries"]);
    if (!Array.isArray(r.entries) || r.entries.length > 10000) vmFail("vm_protocol_invalid");
    return r.entries.map(e => {
      const entry = vmRecord(e, ["name", "type"]);
      if (typeof entry.name !== "string" || !entry.name || Buffer.byteLength(entry.name) > 4096 || (!recursive && entry.name.includes("/"))) vmFail("vm_protocol_invalid");
      path(`${p}/${entry.name}`);
      if (!["file", "directory", "symlink", "other"].includes(entry.type as string)) vmFail("vm_protocol_invalid");
      return { name: entry.name, type: entry.type as ExecutionDirectoryEntry["type"] };
    });
  }
  const backend: ExecutionBackend = {
    workspaceRoot: root, temporaryDirectory,
    async realpath(p) { const r = await call({ op: "realpath", path: path(p) }, "read"); vmRecord(r, ["path"]); return path(r.path as string); },
    async stat(p) { const r = await call({ op: "stat", path: path(p) }, "read"); vmRecord(r, ["type"]); if (!["file", "directory", "other"].includes(r.type as string)) vmFail("vm_protocol_invalid"); return { type: r.type as "file" | "directory" | "other" }; },
    async *readFile(p, options) { const r = await call({ op: "read", path: path(p) }, "read", options?.signal); vmRecord(r, ["data"]); yield vmBytes(r.data, limits.fileBytes); },
    async observeFile(p, options) {
      path(p); const r = await call({ op: "observe", path: p, content: options?.content === true }, "read", options?.signal); vmRecord(r, ["token", "data"]);
      if (r.token === null) { if (r.data !== null) vmFail("vm_protocol_invalid"); return null; }
      if (typeof r.token !== "string" || !/^[a-f0-9]{64}$/.test(r.token)) vmFail("vm_protocol_invalid");
      const observation: ExecutionFileObservation = Object.freeze({ targetExists: true, ...(r.data === null ? {} : { bytes: vmBytes(r.data, limits.fileBytes) }) });
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
      const r = await call({ op: "write", path: p, data: Buffer.from(content).toString("base64"), createParents: options?.createParents === true, ...(observed === undefined ? {} : { observed }) }, "write", options?.signal); vmRecord(r, []);
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
      const args = ["rg", "--json", "--no-follow", "--max-count", String(request.limit), ...(request.ignoreCase ? ["--ignore-case"] : []), ...(request.glob ? ["--glob", request.glob] : []), "--", request.pattern, request.path];
      const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
      const result = await backend.spawn({ command: args.map(quote).join(" "), cwd: request.cwd, ...(request.signal ? { signal: request.signal } : {}) });
      if (result.exitCode !== 0 && result.exitCode !== 1) return { matches: [], truncated: false, failure: "VM search unavailable" };
      const matches: { path: string; line: number; text: string }[] = []; let truncated = false;
      for (const line of result.stdout.split("\n")) if (line) {
        let event; try { event = JSON.parse(line); } catch { vmFail("vm_protocol_invalid"); }
        if (event.type !== "match") continue;
        const p = path(event.data?.path?.text); vmInteger(event.data?.line_number);
        if (typeof event.data?.lines?.text !== "string") vmFail("vm_protocol_invalid");
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
      vmRecord(r, ["stdout", "stderr", "exitCode", "timedOut", "truncated", "totalBytes"]);
      const stdoutBytes = vmBytes(r.stdout, limits.outputBytes), stderrBytes = vmBytes(r.stderr, limits.outputBytes);
      if (stdoutBytes.length + stderrBytes.length > limits.outputBytes || typeof r.timedOut !== "boolean" || typeof r.truncated !== "boolean" || (r.timedOut && r.exitCode !== null)) vmFail("vm_protocol_invalid");
      if (r.exitCode !== null) vmInteger(r.exitCode, 255, 0);
      vmInteger(r.totalBytes, Number.MAX_SAFE_INTEGER, 0);
      if (r.totalBytes < stdoutBytes.length + stderrBytes.length || (!r.truncated && r.totalBytes !== stdoutBytes.length + stderrBytes.length)) vmFail("vm_protocol_invalid");
      const stdout = clean(Buffer.from(stdoutBytes).toString("utf8")), stderr = clean(Buffer.from(stderrBytes).toString("utf8")) + (r.truncated ? "\n[VM output truncated]" : "");
      if (stdout) request.onOutput?.({ stream: "stdout", text: stdout });
      if (stderr) request.onOutput?.({ stream: "stderr", text: stderr });
      return { stdout, stderr, exitCode: r.exitCode as number | null, timedOut: r.timedOut };
    },
  };
  return backend;
}

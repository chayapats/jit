import type { VmEndpoint, VmHostCommand } from "./types";
import { vmHostCommand, vmQuote, vmSshArgs } from "./host";
import { vmRunnerSource } from "./runner";
import { vmCanonical, vmFail, vmRecord } from "./validation";

/** Host-initiated bounded transport, with no command retries, ambient SSH config, or host execution fallback. */
export class VmSshTransport {
  constructor(readonly endpoint: VmEndpoint, readonly run: VmHostCommand = vmHostCommand) {}
  /** The remote program is fixed by trusted service code; all operation data travels only on stdin. */
  async invoke(request: Record<string, unknown>, settings: { unit: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal; beforeStart: () => void }): Promise<Record<string, unknown>> {
    if (!/^jit-[a-f0-9]{32}\.slice$/.test(settings.unit)) vmFail("vm_scope_invalid");
    const program = ["sudo", "-n", "systemd-run", "--quiet", "--pipe", "--wait", "--collect", `--slice=${settings.unit}`,
      `--unit=jit-op-${crypto.randomUUID().replaceAll("-", "")}`, "/usr/bin/python3", "-I", "-c", vmRunnerSource];
    const result = await this.run([...vmSshArgs(this.endpoint), program.map(vmQuote).join(" ")], { input: Buffer.from(vmCanonical(request)), timeoutMs: settings.timeoutMs,
      maxBytes: settings.maxBytes, ...(settings.signal ? { signal: settings.signal } : {}), beforeStart: settings.beforeStart });
    if (result.exitCode !== 0) vmFail("vm_connection_failed", 503);
    let decoded: unknown; const raw = Buffer.from(result.stdout).toString("utf8");
    try { decoded = JSON.parse(raw); } catch { vmFail("vm_protocol_invalid"); }
    const response = vmRecord(decoded, ["v", "id", "ok"], ["result", "code"]);
    if (vmCanonical(response) !== raw || response.v !== 1 || response.id !== request.id || typeof response.ok !== "boolean" ||
      (response.ok ? !Object.hasOwn(response, "result") || Object.hasOwn(response, "code") : !Object.hasOwn(response, "code") || Object.hasOwn(response, "result"))) vmFail("vm_protocol_invalid");
    if (!response.ok) {
      if (typeof response.code !== "string" || !["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "ECHANGED", "EINVAL", "EFBIG", "E2BIG", "ETIMEDOUT", "EIO", "ELOOP"].includes(response.code)) vmFail("vm_protocol_invalid");
      throw Object.assign(new Error(response.code), { code: response.code });
    }
    return vmRecord(response.result, Object.keys(response.result as object));
  }
  /** Fixed lifecycle/health commands are trusted infrastructure, not a model-accessible management shell. */
  async control(argv: readonly string[], options: { timeoutMs?: number; maxBytes?: number; beforeStart?: () => void } = {}): Promise<string> {
    const result = await this.run([...vmSshArgs(this.endpoint), argv.map(vmQuote).join(" ")], { timeoutMs: options.timeoutMs ?? 15000,
      maxBytes: options.maxBytes ?? 16384, ...(options.beforeStart ? { beforeStart: options.beforeStart } : {}) });
    if (result.exitCode !== 0) vmFail("vm_connection_failed", 503);
    return Buffer.from(result.stdout).toString("utf8");
  }
  /** Keep an allocation alive while work is active; this cgroup is guest-owned and is labelled accordingly. */
  async openScope(unit: string, milliseconds: number, beforeStart: () => void): Promise<void> {
    await this.control(["sudo", "-n", "systemd-run", "--quiet", `--slice=${unit}`, `--unit=${unit.slice(0, -6)}-keeper`,
      `--property=RuntimeMaxSec=${Math.ceil(milliseconds / 1000)}`, "/usr/bin/sleep", "infinity"], { beforeStart });
  }
  /** Host-initiated cooperative stop/read-back. It cannot attest root-resistant descendant settlement. */
  async closeScope(unit: string): Promise<boolean> {
    try {
      await this.control(["sudo", "-n", "systemctl", "stop", unit]);
      const state = (await this.control(["sudo", "-n", "systemctl", "show", unit, "--property=ActiveState", "--property=ControlGroup"])).trim().split("\n");
      const group = state.find(s => s.startsWith("ControlGroup="))?.slice(13);
      if (!state.includes("ActiveState=inactive") || group === undefined || group && !/^\/jit-[a-f0-9]{32}\.slice$/.test(group)) return false;
      if (!group) return true;
      const events = await this.control(["sudo", "-n", "cat", `/sys/fs/cgroup${group}/cgroup.events`]);
      return /^populated 0$/m.test(events);
    } catch { return false; }
  }
}

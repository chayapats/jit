import type { VmHostCommand, VmEndpoint } from "./types";
import { vmEndpoint, vmFail } from "./validation";

/** Bounded argv-only protected process runner; the working command is never a host shell command. */
export const vmHostCommand: VmHostCommand = async (argv, options) => {
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  options.beforeStart?.();
  const proc = Bun.spawn([...argv], { env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", ...options.env },
    stdin: options.input ?? "ignore", stdout: "pipe", stderr: "ignore" });
  let cut = false, timeout = false;
  const stop = () => { proc.kill("SIGKILL"); };
  const timer = setTimeout(() => { timeout = true; stop(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for await (const chunk of proc.stdout) {
      total += chunk.length;
      if (total > options.maxBytes) { cut = true; stop(); break; }
      chunks.push(chunk);
    }
    const exitCode = await proc.exited;
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (cut) vmFail("vm_output_limit");
    if (timeout) vmFail("vm_transport_timeout");
    return { stdout: Buffer.concat(chunks), exitCode };
  } catch (error) { stop(); await proc.exited; throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); }
};
/** Fixed SSH options deny agent/X11/port forwarding, config hooks, multiplexing and silent host-key acceptance. */
export function vmSshArgs(endpoint: VmEndpoint): string[] {
  const e = vmEndpoint(endpoint);
  return ["ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
    "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ControlMaster=no", "-o", "ControlPath=none",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${e.knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    "-i", e.identityFile, "-p", String(e.port), "-l", e.user, "--", e.host];
}
/** POSIX quoting is used only for the remote guest command, never for a protected-host shell. */
export function vmQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

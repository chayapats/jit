import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";

/** Captures only fd 3, bounded in memory; stdout/stderr are discarded and no command output is logged. */
export async function captureOwnerPipe(argv: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: "/", env, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
    let value = "", failed = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } };
    const timer = setTimeout(() => { failed = true; kill(); finish(false); }, timeoutMs);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdio[3]?.destroy();
      if (ok && !failed) resolve(value); else reject(new Error("owner_link_pipe_failed"));
    };
    child.stdio[3]!.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(value) + chunk.length > 1024) { failed = true; kill(); finish(false); }
      else value += chunk.toString("utf8");
    });
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
  });
}

/** Opens the controlling terminal before issuance; a redirected installer logger never receives a capability. */
export function operatorTerminal(): { write(text: string): void; close(): void } {
  const fd = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  if (!fstatSync(fd).isCharacterDevice()) { closeSync(fd); throw new Error("operator_terminal_required"); }
  return { write: text => { writeSync(fd, text); }, close: () => closeSync(fd) };
}

/** Issues via the trusted S14 CLI and displays once only on the operator terminal; existing owners get sign-in. */
export async function deliverS14OwnerLink(argv: string[], env: Record<string, string>, origin: string,
  deps = { capture: captureOwnerPipe, terminal: operatorTerminal }): Promise<void> {
  const terminal = deps.terminal();
  try {
    const value = await deps.capture(argv, env);
    const prefix = `${origin}/owner/setup?token=`;
    if (value !== "" && (value !== value.trim() + "\n" || !value.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(value.trim().slice(prefix.length)))) throw new Error("owner_link_pipe_invalid");
    terminal.write(`Open ${value.trim() || `${origin}/login`} to finish setup\n`);
  } finally { terminal.close(); }
}

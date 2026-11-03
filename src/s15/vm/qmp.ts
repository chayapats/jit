import { connect } from "node:net";
import { vmFail } from "./validation";

/** One QMP command. Only trusted management code builds these; no guest or model text reaches QMP. */
export interface QmpCommand { execute: string; arguments?: Record<string, unknown> }
/**
 * Protected QMP exchange over the controller-only Unix socket. Returns one `return` value per command,
 * in order. Asynchronous events are ignored. A QMP error, malformed reply, oversized buffer or timeout
 * raises `vm_management_unavailable`; no command is retried.
 */
export type QmpExchange = (socketPath: string, commands: readonly QmpCommand[], options: { timeoutMs: number }) => Promise<unknown[]>;

/** Real QMP client: greeting, capability negotiation, then each command strictly in sequence. */
export const qmpExchange: QmpExchange = (socketPath, commands, options) => new Promise<unknown[]>((resolve, reject) => {
  const results: unknown[] = []; let buffer = "", stage = -2, settled = false;
  const socket = connect({ path: socketPath });
  const finish = (error: unknown | null) => {
    if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
    if (error === null) resolve(results); else reject(error);
  };
  const timer = setTimeout(() => finish(Object.assign(new Error("vm_management_unavailable"), { code: "vm_management_unavailable" })), options.timeoutMs);
  const send = () => {
    if (stage === -1) { socket.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n"); return; }
    const command = commands[stage];
    if (!command) { finish(null); return; }
    socket.write(JSON.stringify(command.arguments ? { execute: command.execute, arguments: command.arguments } : { execute: command.execute }) + "\n");
  };
  socket.setEncoding("utf8");
  socket.on("error", () => { if (stage >= commands.length) finish(null); else finish(new Error("vm_management_unavailable")); });
  socket.on("close", () => {
    // `quit` may close the socket before or right after its reply; that is the expected terminal path.
    if (stage === commands.length - 1 && commands.at(-1)?.execute === "quit") { results.push({}); finish(null); }
    else if (stage >= commands.length) finish(null); else finish(new Error("vm_management_unavailable"));
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1_048_576) { finish(new Error("vm_management_unavailable")); return; }
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { finish(new Error("vm_management_unavailable")); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { finish(new Error("vm_management_unavailable")); return; }
      if ("event" in message) continue;
      if (stage === -2) { if (!("QMP" in message)) { finish(new Error("vm_management_unavailable")); return; } stage = -1; send(); continue; }
      if ("error" in message || !("return" in message)) { finish(new Error("vm_management_unavailable")); return; }
      if (stage >= 0) results.push(message.return);
      stage++; send();
      if (settled) return;
    }
  });
}).catch(() => vmFail("vm_management_unavailable", 503));

import { dirname, join, resolve } from "node:path";
import { AppError } from "../errors";
import { readHiddenPassword } from "../terminal-password";
import { s14CredentialLifecycle } from "./lifecycle";
import { opsRead } from "./ops-files";
import { schwayOpsNative } from "./ops-native";
import { S14Maintenance } from "./ops";
import { supportedS14Routes } from "./sign-in";
import type { OpsCommand } from "./ops-types";

/** Runs owner maintenance offline under the same exclusive lock as serve; stdin is used only for the owner password. */
export async function runS14Ops(path: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const index = args.indexOf("--command");
  const allowed = new Set(["ops", "--s14", "--password-stdin", "--command", ...(index >= 0 && args[index + 1] ? [args[index + 1]!] : [])]);
  if (args.some(arg => !allowed.has(arg)) || args.filter(arg => arg === "--command").length > 1 || index >= 0 && !args[index + 1]) throw new AppError("s14_ops_usage");
  if (!process.stdin.isTTY && !args.includes("--password-stdin")) throw new AppError("password_stdin_flag_required");
  // No model, service transport, computer runtime, vault or executor exists in this process.
  const maintenance = new S14Maintenance(path, {
    policy: { routes: env.JIT_S14_ROUTES ? JSON.parse(env.JIT_S14_ROUTES) : supportedS14Routes(), tools: ["web_search", "web_fetch", "computer"], resources: JSON.parse(env.JIT_S14_RESOURCES ?? "[]") },
    chat: { async reply() { throw new AppError("s14_ops_workers_fenced", 503); } },
  }, schwayOpsNative(join(dirname(path), "native")));
  try {
    const password = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, "");
    const token = await maintenance.app.login(password);
    const actor = maintenance.app.authenticate(token).actor;
    const result = index < 0 ? maintenance.status(actor) : await maintenance.execute(actor, JSON.parse(opsRead(resolve(args[index + 1]!), 131072).toString()) as OpsCommand);
    console.log(JSON.stringify(result));
  } finally { maintenance.close(); await s14CredentialLifecycle().close(); }
}

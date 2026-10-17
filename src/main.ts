import { Application } from "./application";
import { readConfig } from "./config";
import { TransactionStore } from "./store";
import { createWebHandler } from "./web";
import { readHiddenPassword } from "./terminal-password";

async function secret(): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!process.argv.includes("--password-stdin")) throw new Error("Use an interactive terminal or --password-stdin");
    const input = await Bun.stdin.text();
    if (input.length > 258) throw new Error("Password input is too long");
    return input.replace(/\r?\n$/, "");
  }
  return readHiddenPassword();
}

async function main(): Promise<void> {
  const config = readConfig();
  const command = process.argv[2];
  if (!["serve", "setup", "reset-owner"].includes(command ?? "")) throw new Error("Use serve, setup or reset-owner");
  const store = new TransactionStore(config.databasePath);
  const app = new Application(store, config);
  if (command !== "serve") {
    try { await app.setupOwner(await secret(), command === "reset-owner"); console.log("Owner credentials saved; existing browser sessions revoked."); }
    finally { store.close(); }
    return;
  }
  const server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: config.bodyBytes,
    idleTimeout: 15, fetch: createWebHandler(app), error: () => new Response("Request failed", { status: 503 }) });
  console.log("Jit workspace started. No external services connected.");
  const stop = async () => { await server.stop(); store.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => { console.error("Jit could not complete the operation. Check local configuration, owner setup and storage."); process.exitCode = 1; });

import { Application } from "./application";
import { readConfig } from "./config";
import { TransactionStore } from "./store";
import { createWebHandler } from "./web";
import { readHiddenPassword } from "./terminal-password";
import { JobQueue } from "./jobs/queue";
import { projectStateWork } from "./jobs/project-state";
import { AppError } from "./errors";
import { discussionPlanWork, specialistAnalysisWork } from "./team/dispatch";
import { ScriptedRunPort } from "./team/scripted-port";
import { scriptedPreviewWork } from "./team/preview";

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
  let queue: JobQueue | undefined;
  try { if (command === "serve") {
    const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes);
    queue = new JobQueue(store, config.jobs, [
      projectStateWork(store), scriptedPreviewWork(store, config, port), discussionPlanWork(), specialistAnalysisWork(store, config, port),
    ]);
    await queue.reconcile(port);
  } }
  catch (error) { queue?.close(); store.close(); throw error; }
  const app = new Application(store, config, queue ? { jobs: queue } : {});
  if (command !== "serve") {
    try { await app.setupOwner(await secret(), command === "reset-owner"); console.log("Owner credentials saved; existing browser sessions revoked."); }
    finally { store.close(); }
    return;
  }
  let server: ReturnType<typeof Bun.serve>;
  try { server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: config.bodyBytes,
    idleTimeout: 15, fetch: createWebHandler(app), error: () => new Response("Request failed", { status: 503 }) }); }
  catch (error) { queue?.close(); store.close(); throw error; }
  const timer = setInterval(() => { try { queue!.pump(); } catch { /* Queue refuses acknowledgments after a storage/ownership failure. */ } }, 100);
  timer.unref();
  console.log("Jit workspace started. No external services connected.");
  const stop = async () => { clearInterval(timer); queue?.close(); await server.stop(); store.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(error => {
  console.error(error instanceof AppError && error.code === "scheduler_unavailable"
    ? "Jit job admission is unavailable. Stop the other Jit instance or verify stale scheduler ownership before retrying."
    : "Jit could not complete the operation. Check local configuration, owner setup and storage.");
  process.exitCode = 1;
});

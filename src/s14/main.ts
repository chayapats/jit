import { dirname, join, resolve } from "node:path";
import { ConnectionVault } from "../exec/connections";
import { schwayRecovery } from "./native-recovery";
import { schwayResearch } from "./research";
import { AppError } from "../errors";
import { readHiddenPassword } from "../terminal-password";
import { S14Application } from "./application";
import { schwayChat } from "./chat";
import { FreshStateRequired, inspectS14Store, s14SchemaVersion, S14Store } from "./store";
import { createS14Handler } from "./web";
import { renderS14 } from "./web-pages";
import { createS14Product } from "./web-product";
import { acquireS14RuntimeLock } from "./runtime-lock";
import { serveS14Refusal } from "./web-refusal";
import type { Policy } from "./types";
import { BotPodmanRuntime } from "./computer-podman";
import { s14CredentialLifecycle } from "./lifecycle";
import { runComputerWork } from "./computer-work";

/** Explicit opt-in composition root; it imports no legacy application, workers, configuration or store at runtime. */
export async function runS14(args = process.argv.slice(2), env = process.env): Promise<void> {
  const path = resolve(env.JIT_S14_DATABASE ?? ".local/s14/application.sqlite"), command = args[0];
  try {
    inspectS14Store(path); // Refuse legacy before creating even a lock, profile directory or worker.
    if (!["serve", "setup"].includes(command ?? "") || args.some(a => !["serve", "setup", "--s14", "--password-stdin", "--refusal-page"].includes(a))) throw new AppError("use_setup_or_serve_with_s14");
    const policy: Policy = { routes: JSON.parse(env.JIT_S14_ROUTES ?? "[]"), tools: ["web_search", "web_fetch", "computer"], resources: JSON.parse(env.JIT_S14_RESOURCES ?? "[]") };
    const release = acquireS14RuntimeLock(path);
    let store: S14Store | undefined;
    try {
      store = new S14Store(path);
      const chat: import("./types").ChatPort = { reply: (input, signal) => schwayChat(join(dirname(path), "native"), undefined, app.recovery).reply(input, signal) };
      const vaultDirectory = resolve(env.JIT_S14_VAULT_DIRECTORY ?? join(dirname(path), "..", "s14-vault"));
      const vault = new ConnectionVault(vaultDirectory, { forbidden: [dirname(path)] });
      const runtime = env.JIT_S14_COMPUTER_ROOT ? new BotPodmanRuntime({ dataRoot: env.JIT_S14_COMPUTER_ROOT,
        protectedPaths: [dirname(path), vaultDirectory, resolve(".local"), resolve("backups")], workspaceImage: env.JIT_BOX_IMAGE_BASE ?? "", browserImage: env.JIT_BOX_IMAGE_BROWSER ?? "" }) : undefined;
      const app: S14Application = new S14Application(store, { policy, chat, parallel: { vault }, computers: runtime ? { runtime } : {}, authority: { scheduler: JSON.parse(env.JIT_S14_SCHEDULER_LIMITS ?? '{"global":2,"route":2,"bot":1,"computer":2}'), executor: { async run(attempt, signal) {
        if (attempt.snapshot.tools.includes("computer")) return runComputerWork(app, join(dirname(path), "native"), attempt, signal);
        return schwayResearch(join(dirname(path), "native"), app).run(attempt, signal);
      } } } });
      if (command === "setup") {
        if (!process.stdin.isTTY && !args.includes("--password-stdin")) throw new AppError("password_stdin_flag_required");
        const password = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, "");
        await app.provisionOwner(password); console.log(JSON.stringify({ state: "owner_provisioned", nextAction: "sign_in_and_submit_setup", storeFormat: "jit.s14/v1", schemaVersion: s14SchemaVersion }));
        store.close(); release(); return;
      }
      const origin = env.JIT_S14_ORIGIN ?? "http://localhost:3001", url = new URL(origin);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new AppError("s14_loopback_origin_required");
      await app.recovery.boot(schwayRecovery(join(dirname(path), "native")));
      await app.botLifecycle.drain(schwayRecovery(join(dirname(path), "native")));
      await app.computers.drain();
      // Interactive chat is checked before every bounded graph admission; each run has its own host.
      let pumping: Promise<void> | null = null;
      const pump = (): Promise<void> => {
        if (pumping) return pumping;
        pumping = (async () => {
          for (;;) {
            app.routines.tick();
            await app.drainReplies(); await app.authority.drain();
            await app.attention.drain();
            await app.botLifecycle.drain(schwayRecovery(join(dirname(path), "native")));
            if (!store!.read(tx => tx.get("SELECT id FROM reply_outbox WHERE json_extract(record_json,'$.state')='queued' LIMIT 1"))) break;
          }
        })().finally(() => { pumping = null; });
        return pumping;
      };
      const handler = createS14Handler(app, origin, renderS14, createS14Product(app));
      const maintainComputers = () => {
        app.routines.tick();
        void pump().catch(() => {});
        app.computers.sweep();
        app.authority.cancelFenced();
        void app.computers.drain().catch(() => {});
      };
      const server = Bun.serve({ hostname: url.hostname === "[::1]" ? "::1" : url.hostname, port: Number(url.port || 80), async fetch(request) {
        const response = await handler(request); maintainComputers(); void pump().catch(() => {}); return response;
      } });
      const computerTimer = setInterval(maintainComputers, 1000);
      void pump().catch(() => {});
      process.once("exit", release);
      const shutdown = () => {
        clearInterval(computerTimer); server.stop(true);
        void (async () => {
          await app.authority.shutdown();
          await pumping;
          app.computers.recover(); await app.computers.drain();
          await s14CredentialLifecycle().close();
          store!.close(); release(); process.exit(0);
        })().catch(() => { process.exitCode = 1; });
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      console.log(JSON.stringify({ state: "s14_listening", origin, contracts: ["app.bots/v1", "app.conversations/v2", "app.work-grants/v1", "app.effect-approval/v2", "app.bot-computer/v1", "app.input-lease/v1", "app.memory-scope/v2", "app.context-provenance/v2", "app.parallel-web/v1", "app.external-evidence/v2", "app.work-graph/v1", "app.report-artifacts/v1", "app.artifact-gateway/v1", "app.snapshot-sharing/v1", "app.work-checkpoints/v1", "app.replay-policy/v1", "app.routine-grants/v1", "app.attention-outbox/v1", "app.bot-lifecycle/v1"], readiness: "configured_unverified" }));
    } catch (e) { store?.close(); release(); throw e; }
  } catch (error) {
    console.error(JSON.stringify(error instanceof FreshStateRequired ? { error: error.code, nextAction: error.nextAction } : { error: error instanceof AppError ? error.code : "s14_start_failed" }));
    process.exitCode = 1;
    // Opt-in explanation page: it runs after the refusal, with no store, lock or worker, so it can only say what happened.
    if (error instanceof FreshStateRequired && command === "serve" && args.includes("--refusal-page")) serveS14Refusal(path, env.JIT_S14_ORIGIN ?? "http://localhost:3001");
  }
}

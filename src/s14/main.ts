import { dirname, join, resolve } from "node:path";
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

/** Explicit opt-in composition root; it imports no legacy application, workers, configuration or store at runtime. */
export async function runS14(args = process.argv.slice(2), env = process.env): Promise<void> {
  const path = resolve(env.JIT_S14_DATABASE ?? ".local/s14/application.sqlite"), command = args[0];
  try {
    inspectS14Store(path); // Refuse legacy before creating even a lock, profile directory or worker.
    if (!["serve", "setup"].includes(command ?? "") || args.some(a => !["serve", "setup", "--s14", "--password-stdin", "--refusal-page"].includes(a))) throw new AppError("use_setup_or_serve_with_s14");
    const policy: Policy = { routes: JSON.parse(env.JIT_S14_ROUTES ?? "[]"), tools: [], resources: [] };
    const release = acquireS14RuntimeLock(path);
    let store: S14Store | undefined;
    try {
      store = new S14Store(path);
      const chat = schwayChat(join(dirname(path), "native"));
      const app = new S14Application(store, { policy, chat, authority: { executor: { async run(attempt, signal) {
        const profile = store!.read(tx => JSON.parse(tx.get<{ profile_json: string }>("SELECT profile_json FROM installation")!.profile_json) as { name: string; language: "th" | "en" });
        const result = await chat.reply({ route: attempt.snapshot.route, bot: attempt.snapshot.bot, language: profile.language, ownerName: profile.name,
          messages: [{ id: attempt.id, conversationId: attempt.workId, role: "owner", text: attempt.snapshot.input, createdAt: attempt.createdAt }] }, signal);
        return { state: "ready", text: result.text };
      } } } });
      if (command === "setup") {
        if (!process.stdin.isTTY && !args.includes("--password-stdin")) throw new AppError("password_stdin_flag_required");
        const password = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, "");
        await app.provisionOwner(password); console.log(JSON.stringify({ state: "owner_provisioned", nextAction: "sign_in_and_submit_setup", storeFormat: "jit.s14/v1", schemaVersion: s14SchemaVersion }));
        store.close(); release(); return;
      }
      const origin = env.JIT_S14_ORIGIN ?? "http://localhost:3001", url = new URL(origin);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new AppError("s14_loopback_origin_required");
      app.recoverReplies(); app.authority.recover();
      // One root pump keeps conversational/work inference serial on the selected credential route.
      let pumping = false;
      const pump = async () => {
        if (pumping) return; pumping = true;
        try { for (;;) {
          await app.drainReplies(); await app.authority.drain();
          // A message can arrive while an internal work transport is settling.
          if (!store!.read(tx => tx.get("SELECT id FROM reply_outbox WHERE json_extract(record_json,'$.state')='queued' LIMIT 1"))) break;
        } } finally { pumping = false; }
      };
      const handler = createS14Handler(app, origin, renderS14, createS14Product(app));
      const server = Bun.serve({ hostname: url.hostname === "[::1]" ? "::1" : url.hostname, port: Number(url.port || 80), async fetch(request) {
        const response = await handler(request); void pump().catch(() => {}); return response;
      } });
      void pump().catch(() => {});
      process.once("exit", release);
      process.once("SIGTERM", () => { server.stop(true); process.exit(0); });
      process.once("SIGINT", () => { server.stop(true); process.exit(0); });
      console.log(JSON.stringify({ state: "s14_listening", origin, contracts: ["app.bots/v1", "app.conversations/v2", "app.work-grants/v1", "app.effect-approval/v2"], readiness: "configured_unverified" }));
    } catch (e) { store?.close(); release(); throw e; }
  } catch (error) {
    console.error(JSON.stringify(error instanceof FreshStateRequired ? { error: error.code, nextAction: error.nextAction } : { error: error instanceof AppError ? error.code : "s14_start_failed" }));
    process.exitCode = 1;
    // Opt-in explanation page: it runs after the refusal, with no store, lock or worker, so it can only say what happened.
    if (error instanceof FreshStateRequired && command === "serve" && args.includes("--refusal-page")) serveS14Refusal(path, env.JIT_S14_ORIGIN ?? "http://localhost:3001");
  }
}

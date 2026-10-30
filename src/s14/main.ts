import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AppError } from "../errors";
import { readHiddenPassword } from "../terminal-password";
import { S14Application } from "./application";
import { schwayChat } from "./chat";
import { FreshStateRequired, inspectS14Store, s14SchemaVersion, S14Store } from "./store";
import { createS14Handler } from "./web";
import type { Policy } from "./types";
import { BotPodmanRuntime } from "./computer-podman";
import { runComputerWork } from "./computer-work";

/** Explicit opt-in composition root; it imports no legacy application, workers, configuration or store at runtime. */
export async function runS14(args = process.argv.slice(2), env = process.env): Promise<void> {
  const path = resolve(env.JIT_S14_DATABASE ?? ".local/s14/application.sqlite"), command = args[0];
  try {
    inspectS14Store(path); // Refuse legacy before creating even a lock, profile directory or worker.
    if (!["serve", "setup"].includes(command ?? "") || args.some(a => !["serve", "setup", "--s14", "--password-stdin"].includes(a))) throw new AppError("use_setup_or_serve_with_s14");
    const policy: Policy = { routes: JSON.parse(env.JIT_S14_ROUTES ?? "[]"), tools: ["computer"], resources: [] };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = `${path}.runtime-lock`;
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8")); let live = true;
      try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") live = false; }
      if (live || !Number.isSafeInteger(pid) || pid <= 0) throw new AppError("s14_runtime_already_open", 409);
      unlinkSync(lock);
    }
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    let store: S14Store | undefined;
    const release = () => { if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); };
    try {
      store = new S14Store(path);
      const chat = schwayChat(join(dirname(path), "native"));
      const runtime = env.JIT_S14_COMPUTER_ROOT ? new BotPodmanRuntime({ dataRoot: env.JIT_S14_COMPUTER_ROOT,
        protectedPaths: [dirname(path), resolve(".local"), resolve("backups")], workspaceImage: env.JIT_BOX_IMAGE_BASE ?? "", browserImage: env.JIT_BOX_IMAGE_BROWSER ?? "" }) : undefined;
      const app: S14Application = new S14Application(store, { policy, chat, computers: runtime ? { runtime } : {}, authority: { executor: { async run(attempt, signal) {
        if (attempt.snapshot.tools.includes("computer")) return runComputerWork(app, join(dirname(path), "native"), attempt, signal);
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
      app.recoverReplies(); app.authority.recover(); app.computers.recover();
      await app.computers.drain();
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
      const handler = createS14Handler(app, origin);
      const maintainComputers = () => {
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
      const shutdown = () => { clearInterval(computerTimer); server.stop(true); app.computers.recover(); void app.computers.drain().finally(() => process.exit(0)); };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      console.log(JSON.stringify({ state: "s14_listening", origin, contracts: ["app.bots/v1", "app.conversations/v2", "app.work-grants/v1", "app.effect-approval/v2", "app.bot-computer/v1", "app.input-lease/v1"], readiness: "configured_unverified" }));
    } catch (e) { store?.close(); release(); throw e; }
  } catch (error) {
    console.error(JSON.stringify(error instanceof FreshStateRequired ? { error: error.code, nextAction: error.nextAction } : { error: error instanceof AppError ? error.code : "s14_start_failed" }));
    process.exitCode = 1;
  }
}

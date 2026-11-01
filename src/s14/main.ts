import { createS14Pump } from "./pump";
import { personalServiceBinding, personalProxyRequest } from "./personal-origin";
import { PersonalVault } from "./personal-vault";
import { dirname, join, resolve } from "node:path";
import { reconcileOnlineBackups } from "./backups";
import { schwayOpsNative } from "./ops-native";
import { runS14Ops } from "./ops-cli";
import { assertS14OpsUnfenced } from "./ops-state";
import { ConnectionVault } from "../exec/connections";
import { schwayRecovery } from "./native-recovery";
import { schwayResearch } from "./research";
import { AppError } from "../errors";
import { readHiddenPassword } from "../terminal-password";
import { S14Application } from "./application";
import { schwayChat } from "./chat";
import { FreshStateRequired, inspectS14Store, s14SchemaVersion, S14Store } from "./store";
import { createS14Handler } from "./web";
import { createS14Auth } from "./web-first-run";
import { renderS14 } from "./web-pages";
import { createS14Product } from "./web-product";
import { acquireS14RuntimeLock } from "./runtime-lock";
import { serveS14Refusal } from "./web-refusal";
import { existingResourceCeilings } from "./scope-options";
import { s14Policy } from "./policy";
import { BotPodmanRuntime } from "./computer-podman";
import { s14CredentialLifecycle } from "./lifecycle";
import { runComputerWork } from "./computer-work";
import { openS14BootstrapStore, printS14OwnerSetupLink, requireS14OwnerLinkPipe, writeS14OwnerSetupLink } from "./owner-bootstrap";

/** Default composition root; it imports no legacy application, workers, configuration or store at runtime. */
export async function runS14(args = process.argv.slice(2), env = process.env): Promise<void> {
  const path = resolve(env.JIT_S14_DATABASE ?? ".local/s14/application.sqlite"), command = args[0];
  try {
    inspectS14Store(path); // Refuse legacy before creating even a lock, profile directory or worker.
    if (command === "ops") { await runS14Ops(path, args, env); return; }
    assertS14OpsUnfenced(path);
    const origin = env.JIT_S14_ORIGIN ?? "http://localhost:3001";
    if (command === "owner-link") {
      // This CLI coexists with a running service: only the store's writer lock is needed, never its runtime lock/hosts.
      if (args.length !== 4 || args[1] !== "--s14" || args[2] !== "--output-fd" || !/^[0-9]+$/.test(args[3]!)) throw new AppError("owner_link_private_pipe_required");
      const fd = Number(args[3]);
      requireS14OwnerLinkPipe(fd); // Validate delivery before opening/creating any state.
      const store = await openS14BootstrapStore(path);
      try { writeS14OwnerSetupLink(store, origin, fd); } finally { store.close(); }
      return;
    }
    if (!["serve", "setup"].includes(command ?? "") || args.some(a => !["serve", "setup", "--s14", "--password-stdin", "--refusal-page", "--no-refusal-page"].includes(a))) throw new AppError("use_setup_or_serve_with_s14");
    const binding = personalServiceBinding(command === "serve" ? origin : "http://localhost:3001");
    const policy = s14Policy(env);
    const release = acquireS14RuntimeLock(path);
    let store: S14Store | undefined;
    try {
      reconcileOnlineBackups(path);
      store = new S14Store(path);
      policy.resources = [...new Set([...store.read(existingResourceCeilings), ...policy.resources])];
      const chat: import("./types").ChatPort = { reply: (input, signal) => schwayChat(join(dirname(path), "native"), undefined, app.recovery).reply(input, signal) };
      const vaultDirectory = resolve(env.JIT_S14_VAULT_DIRECTORY ?? join(dirname(path), "..", "s14-vault"));
      const vault = new ConnectionVault(vaultDirectory, { forbidden: [dirname(path), resolve("backups"), env.JIT_S14_COMPUTER_ROOT] });
      const runtime = env.JIT_S14_COMPUTER_ROOT ? new BotPodmanRuntime({ dataRoot: env.JIT_S14_COMPUTER_ROOT,
        protectedPaths: [dirname(path), vaultDirectory, resolve(".local"), resolve("backups")], workspaceImage: env.JIT_BOX_IMAGE_BASE ?? "", browserImage: env.JIT_BOX_IMAGE_BROWSER ?? "" }) : undefined;
      const app: S14Application = new S14Application(store, { policy, chat, git: { vault }, requireBootReconciliation: true, backups: schwayOpsNative(join(dirname(path), "native")), parallel: { vault }, personal: { vault: new PersonalVault(vault), evidenceGuard: env.JIT_S14_PERSONAL_EVIDENCE_GUARD === "1" }, computers: runtime ? { runtime } : {}, authority: { scheduler: JSON.parse(env.JIT_S14_SCHEDULER_LIMITS ?? '{"global":2,"route":2,"bot":1,"computer":2}'), executor: { async run(attempt, signal) {
        if (app.store.read(tx => app.coding.job(tx, attempt.workId))) return app.coding.run(join(dirname(path), "native"), attempt, signal);
        if (attempt.snapshot.tools.includes("computer")) return runComputerWork(app, join(dirname(path), "native"), attempt, signal);
        return schwayResearch(join(dirname(path), "native"), app).run(attempt, signal);
      } } } });
      if (command === "setup") {
        if (!process.stdin.isTTY && !args.includes("--password-stdin")) throw new AppError("password_stdin_flag_required");
        const password = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, "");
        await app.provisionOwner(password); console.log(JSON.stringify({ state: "owner_provisioned", nextAction: "sign_in_and_submit_setup", storeFormat: "jit.s14/v1", schemaVersion: s14SchemaVersion }));
        store.close(); release(); return;
      }
      await app.recovery.boot(schwayRecovery(join(dirname(path), "native")));
      await app.botLifecycle.drain(schwayRecovery(join(dirname(path), "native")));
      await app.computers.drain();
      const pump = createS14Pump({
        busy: () => app.backups.busy,
        tick: () => app.routines.tick(),
        replies: () => app.drainReplies(), work: () => app.authority.drain(),
        repliesQueued: () => !!store!.read(tx => tx.get("SELECT id FROM reply_outbox WHERE json_extract(record_json,'$.state')='queued' LIMIT 1")),
        git: () => app.git.drain(), attention: () => app.attention.drain(),
        personal: () => app.personal.drain(), personalEffects: () => app.personal.effects.drain(),
        botLifecycle: () => app.botLifecycle.drain(schwayRecovery(join(dirname(path), "native"))),
      });
      const handler = createS14Handler(app, origin, renderS14, createS14Product(app), createS14Auth(app));
      const maintainComputers = () => {
        if (app.backups.busy) return;
        app.routines.tick();
        void pump.drain().catch(() => {});
        app.computers.sweep();
        app.authority.cancelFenced();
        void app.computers.drain().catch(() => {});
      };
      const server = Bun.serve({ hostname: binding.hostname, port: binding.port, async fetch(request) {
        let incoming = request;
        try { if (binding.proxy) incoming = personalProxyRequest(request, origin); }
        catch { return new Response("host_rejected", { status: 403 }); }
        const response = await handler(incoming); maintainComputers(); void pump.drain().catch(() => {}); return response;
      } });
      const computerTimer = setInterval(maintainComputers, 1000);
      void pump.drain().catch(() => {});
      process.once("exit", release);
      const shutdown = () => {
        pump.stop(); clearInterval(computerTimer); server.stop(true);
        void (async () => {
          await app.backups.settle();
          await app.authority.shutdown();
          await pump.idle();
          app.computers.recover(); await app.computers.drain();
          await app.signIns.close();
          await s14CredentialLifecycle().close();
          store!.close(); release(); process.exit(0);
        })().catch(() => { process.exitCode = 1; });
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      console.log(JSON.stringify({ state: "s14_listening", origin, contracts: ["app.bots/v1", "app.conversations/v2", "app.work-grants/v1", "app.effect-approval/v2", "app.bot-computer/v1", "app.input-lease/v1", "app.memory-scope/v2", "app.context-provenance/v2", "app.parallel-web/v1", "app.external-evidence/v2", "app.work-graph/v1", "app.report-artifacts/v1", "app.artifact-gateway/v1", "app.snapshot-sharing/v1", "app.work-checkpoints/v1", "app.replay-policy/v1", "app.routine-grants/v1", "app.attention-outbox/v1", "app.bot-lifecycle/v1", "app.managed-backup/v1", "app.restore-activation/v1", "app.coding-work/v1", "app.git-effects/v2", "app.personal-read-connectors/v1", "app.personal-effects/v1"], readiness: "configured_unverified" }));
      printS14OwnerSetupLink(store, origin);
    } catch (e) { store?.close(); release(); throw e; }
  } catch (error) {
    console.error(JSON.stringify(error instanceof FreshStateRequired ? { error: error.code, nextAction: error.nextAction } : { error: error instanceof AppError ? error.code : "s14_start_failed" }));
    process.exitCode = 1;
    // Default browser explanation page: it runs after the refusal, with no store, lock or worker, so it can only say what happened.
    if (error instanceof FreshStateRequired && command === "serve" && !args.includes("--no-refusal-page")) serveS14Refusal(path, env.JIT_S14_ORIGIN ?? "http://localhost:3001");
  }
}

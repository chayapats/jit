import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { S14Application } from "../../src/s14/application";
import { S14Store } from "../../src/s14/store";
import { BotPodmanRuntime } from "../../src/s14/computer-podman";
import { acquireS14RuntimeLock } from "../../src/s14/runtime-lock";
import type { BotComputer } from "../../src/s14/computer-types";
import { AppError } from "../../src/errors";

// Explicit disposable-host evidence only. Run instead of serve in the SAME hardened unit, then restore serve.
// It uses a separate synthetic application store, the installed pool/images and no provider/native/model port.
async function main() {
  const env = process.env;
  if (env.JIT_S14_COMPUTER_EVIDENCE !== "1" || !env.JIT_S14_DATABASE || !env.JIT_S14_COMPUTER_ROOT) throw new AppError("explicit_disposable_computer_evidence_required");
  const path = `${env.JIT_S14_DATABASE}.computer-evidence.sqlite`, statePath = `${path}.private.json`;
  const release = acquireS14RuntimeLock(env.JIT_S14_DATABASE); // Exclude the real service throughout this round.
  const installed = new S14Store(env.JIT_S14_DATABASE);
  try {
    if (installed.read(tx => tx.get("SELECT 1 FROM bot_computers WHERE json_extract(record_json,'$.state')<>'deleted' OR json_extract(record_json,'$.diskSlot.id') IS NOT NULL LIMIT 1"))) {
      throw new AppError("evidence_requires_unused_disposable_pool");
    }
  } catch (error) { release(); throw error; }
  finally { installed.close(); }
  const store = new S14Store(path);
  const runtime = new BotPodmanRuntime({ dataRoot: env.JIT_S14_COMPUTER_ROOT, protectedPaths: [dirname(path)], workspaceImage: env.JIT_BOX_IMAGE_BASE!, browserImage: env.JIT_BOX_IMAGE_BROWSER! });
  const app = new S14Application(store, { requireBootReconciliation: true, policy: { routes: [{ id: "evidence", provider: "codex", model: "scripted" }], tools: ["computer"], resources: [] },
    computers: { runtime }, chat: { async reply() { throw new Error("no model calls in computer evidence"); } } });
  const rid = () => crypto.randomUUID().replaceAll("-", "");
  const check = (ok: unknown, reason: string) => { if (!ok) throw new AppError(reason); };
  const output = (checks: Record<string, unknown>) => console.log(JSON.stringify({ contract: "ops.s14-computer-evidence/v1", ...checks }));
  let state: { password: string; phase: string; conversationId: string; workId: string; generation: number; slotId: string };
  try {
    if (existsSync(statePath)) state = JSON.parse(readFileSync(statePath, "utf8"));
    else {
      check(!store.read(tx => tx.get("SELECT id FROM owner")), "evidence_owner_already_exists");
      state = { password: randomBytes(32).toString("hex"), phase: "initial", conversationId: "", workId: "", generation: 0, slotId: "" };
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await app.provisionOwner(state.password);
    }
    const token = await app.login(state.password), { actor } = app.authenticate(token);
    const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const view = (botId = "jit") => app.computers.view(actor, botId).computer!;
    const lifecycle = async (kind: "computer.reset" | "computer.delete", c = view()) => {
      app.execute(actor, { kind, requestId: rid(), expectedRevision: c.revision, payload: { botId: c.botId, computerId: c.id, generation: c.generation } });
      await app.computers.drain(); check(view(c.botId).state === (kind === "computer.reset" ? "stopped" : "deleted"), "evidence_wipe_failed");
    };
    const open = async (botId = "jit", workId = state.workId) => {
      app.execute(actor, { kind: "computer.open", requestId: rid(), expectedRevision: view(botId)?.revision ?? 0, payload: { botId, workId } });
      await app.computers.drain(); check(view(botId).state === "running", view(botId).reason ?? "evidence_start_failed");
      const attempt = app.authority.admit(workId, rid(), { botId, tools: ["computer"], scopes: [], input: "Synthetic Linux computer evidence", calls: 16, outputBytes: 1024 });
      return app.computers.open(attempt.id);
    };
    const startWork = (botId = "jit") => app.execute(actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(actor, state.conversationId).conversation.revision,
      payload: { conversationId: state.conversationId, task: null, title: "Synthetic computer evidence", purpose: "Verify installed Linux boundaries", completionRule: "Verified host assertions", bots: [{ id: botId, revision: app.home(actor).bots.find(b => b.id === botId)!.revision }], tools: ["computer"], scopes: [],
        limits: { attempts: 8, steps: 8, calls: 128, outputBytes: 8192, wallMs: 3600000, concurrency: 2, reads: 1 }, expiresAt: Date.now() + 3600000 } }).work!.id;
    await app.recovery.boot({ async open() { throw new Error("native session unexpected in model-free computer evidence"); } });
    await app.computers.drain(); // The production boot barrier fences/stops; never replay input/start/reset.
    if (state.phase === "initial") {
      if (!state.conversationId) {
        const setup = app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Computer evidence", language: "th", routeId: "evidence", capabilities: { tools: ["computer"], resources: [] } } });
        state.conversationId = setup.conversation!.id;
      }
      state.workId = startWork(); save();
      const session = await open();
      const initialAttempt = session.lease.attemptId!;
      try {
        await session.backend.writeFileAtomically("/workspace/evidence-marker", "persistent synthetic Bot data");
        const denial = await session.backend.spawn({ cwd: "/workspace", timeoutMs: 10000,
          command: "test ! -e /profile && test ! -S /run/podman/podman.sock && ! curl --noproxy '*' --max-time 2 -fsS http://192.0.2.1 >/dev/null 2>&1 && python3 -c 'import socket;\ntry: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)\nexcept PermissionError: raise SystemExit(0)\nraise SystemExit(1)'" });
        check(denial.exitCode === 0, "evidence_profile_socket_network_denial_failed");
      } finally { session.release(); }
      let c = view(); state.slotId = c.diskSlot!.id;
      writeFileSync(join(env.JIT_S14_COMPUTER_ROOT, "slots", state.slotId, "profile/evidence-profile"), "synthetic profile persistence", { mode: 0o600 });
      const png = await app.computers.screenshot(actor, "jit");
      check(Buffer.from(png).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "evidence_png_failed");
      c = view(); const lease = app.computers.view(actor, "jit").lease!;
      app.execute(actor, { kind: "takeover.start", requestId: rid(), expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation, leaseRevision: lease.revision } });
      const takeover = app.computers.view(actor, "jit");
      await app.computers.ownerInput(actor, { kind: "takeover.input", requestId: rid(), expectedRevision: takeover.computer!.revision,
        payload: { botId: "jit", computerId: c.id, generation: c.generation, leaseRevision: takeover.lease!.revision, input: { kind: "key", key: "Tab" } } });
      const current = app.computers.view(actor, "jit");
      app.execute(actor, { kind: "takeover.end", requestId: rid(), expectedRevision: current.computer!.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation, leaseRevision: current.lease!.revision } });
      output({ phase: "running", screenshotBytes: png.length, screenshotSha256: createHash("sha256").update(png).digest("hex"), profileSocketNetworkDenial: true, ownerInputLease: true, realIdleWaitMs: 300100 });
      await Bun.sleep(300100);
      app.computers.sweep(); await app.computers.drain();
      check(view().state === "stopped" && view().reason === "computer_idle", "evidence_real_idle_stop_failed");
      app.authority.settle(initialAttempt, "synthetic_computer_handler_returned");
      state.workId = startWork(); save();
      const resumed = await open(); resumed.release();
      state.generation = view().generation; state.phase = "restart"; save();
      output({ phase: "awaiting_unit_restart", realFiveMinuteIdleStop: true, identityAndSlotRetained: view().diskSlot!.id === state.slotId });
    } else if (state.phase === "restart") {
      check(view().state === "stopped" && view().generation > state.generation, "evidence_restart_fencing_failed");
      state.workId = startWork(); save(); // Boot does not re-authorize a previous computer attempt.
      const session = await open();
      let text = "";
      try { for await (const bytes of session.backend.readFile("/workspace/evidence-marker")) text += new TextDecoder().decode(bytes); }
      finally { session.release(); }
      check(text === "persistent synthetic Bot data", "evidence_workspace_persistence_failed");
      check(readFileSync(join(env.JIT_S14_COMPUTER_ROOT, "slots", state.slotId, "profile/evidence-profile"), "utf8") === "synthetic profile persistence", "evidence_profile_persistence_failed");
      check((await app.computers.screenshot(actor, "jit")).length > 8, "evidence_restart_screenshot_failed");
      app.authority.settle(session.lease.attemptId!, "synthetic_computer_handler_returned");
      await lifecycle("computer.reset");
      for (const role of ["workspace", "profile"]) check(readdirSync(join(env.JIT_S14_COMPUTER_ROOT, "slots", state.slotId, role)).length === 0, "evidence_reset_not_empty");
      await lifecycle("computer.delete"); check(view().diskSlot === null, "evidence_delete_claim_retained");
      // Scripted proposal plus exact owner acceptance creates B without a provider call or a store bypass.
      app.options.chat = { async reply() { return { text: "Synthetic proposal", proposal: { name: "Evidence B", responsibility: "Verify clean slot reuse", routeId: "evidence" } }; } };
      app.execute(actor, { kind: "message.post", requestId: rid(), expectedRevision: app.conversation(actor, state.conversationId).conversation.revision, payload: { conversationId: state.conversationId, text: "Propose evidence Bot B" } });
      await app.drainReplies();
      const proposal = app.home(actor).proposals[0]!;
      const botId = app.execute(actor, { kind: "bot.proposal.accept", requestId: rid(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, capabilities: { tools: ["computer"], resources: [] } } }).bot!.id;
      // Simulate orphaned prior bytes: every new claim must wipe even if the previous store said clean.
      writeFileSync(join(env.JIT_S14_COMPUTER_ROOT, "slots", state.slotId, "workspace/orphan-marker"), "previous Bot orphan");
      const next = await open(botId, startWork(botId)); next.release();
      app.authority.settle(next.lease.attemptId!, "synthetic_computer_handler_returned");
      check(view(botId).diskSlot!.id === state.slotId, "evidence_slot_not_reused");
      check(readdirSync(join(env.JIT_S14_COMPUTER_ROOT, "slots", state.slotId, "workspace")).length === 0, "evidence_cross_bot_data_leak");
      await lifecycle("computer.reset", view(botId));
      await lifecycle("computer.delete", view(botId));
      state.phase = "done"; save();
      output({ phase: "passed", restartGenerationFencing: true, workspaceAndProfilePersistence: true, screenshotAfterRestart: true, resetBothSlotsEmpty: true, deleteReturnsClaim: true, crossBotOrphanWipe: true, modelCalls: 0 });
      rmSync(statePath);
    } else throw new AppError("evidence_phase_refused");
  } finally { store.close(); release(); }
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ evidence: "failed", reason: error instanceof AppError ? error.code : "computer_evidence_failed" })); process.exitCode = 1; });

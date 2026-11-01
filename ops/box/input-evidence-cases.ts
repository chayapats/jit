import { AppError } from "../../src/errors";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { S14Application } from "../../src/s14/application";
import type { S14Store } from "../../src/s14/store";
import type { ComputerRuntime, ComputerSession } from "../../src/s14/computer-types";
import type { OwnerActor } from "../../src/s14/types";
import { InputEvidenceTransport } from "./input-evidence-transport";

const rid = () => crypto.randomUUID().replaceAll("-", "");
const check = (ok: unknown, reason: string) => { if (!ok) throw new AppError(reason); };
const forbidden = (): never => { throw new AppError("input_evidence_forbidden_port"); };

/** Model/native/effect-free composition; no HTTP listener, vault, provider or installed authority is imported. */
export function inputEvidenceApplication(store: S14Store, runtime: ComputerRuntime): S14Application {
  return new S14Application(store, {
    requireBootReconciliation: true,
    policy: { routes: [{ id: "evidence", provider: "codex", model: "scripted" }], tools: ["computer", "effect_publish"], resources: [] },
    computers: { runtime }, chat: { reply: forbidden },
    authority: { executor: { run: forbidden }, effects: {} },
    parallel: { transport: forbidden }, personal: { transport: forbidden },
    git: { remote: { push: forbidden, createPr: forbidden, readBack: forbidden } },
  });
}

/** Safe observations distinguish real transport/kernel facts from synthetic authority and controlled-latch assertions. */
export interface InputEvidenceResults {
  transportKernelFacts: string[];
  controlledAssertions: string[];
  unrun: string[];
}

/** Exact synthetic-authority stop/drain/delete; settlement, both wipes and claim return must all be confirmed. */
export async function cleanupInputEvidence(app: S14Application, actor: OwnerActor, computerRoot: string, processAbsent: (id: string) => Promise<void>): Promise<void> {
  const works = app.authority.list(actor);
  check(works.length <= 4 && app.home(actor).bots.every(bot => bot.id === "jit"), "input_evidence_cleanup_scope_refused");
  for (const work of works) {
    if (work.grantId && !["stopping", "stopped"].includes(work.state)) app.execute(actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } });
  }
  app.computers.sweep(); await app.computers.drain();
  let c = app.computers.view(actor, "jit").computer;
  if (c && c.state !== "deleted") {
    app.execute(actor, { kind: "computer.stop", requestId: rid(), expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation } });
    await app.computers.drain(); c = app.computers.view(actor, "jit").computer!;
    check(c.state === "stopped", "input_evidence_cleanup_stop_unconfirmed"); await processAbsent(c.id);
    const slot = c.diskSlot?.id;
    app.execute(actor, { kind: "computer.delete", requestId: rid(), expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation } });
    await app.computers.drain(); c = app.computers.view(actor, "jit").computer!;
    check(c.state === "deleted" && c.diskSlot === null, "input_evidence_cleanup_claim_retained"); await processAbsent(c.id);
    if (slot) for (const role of ["workspace", "profile"]) check(readdirSync(join(computerRoot, "slots", slot, role)).length === 0, "input_evidence_cleanup_wipe_unconfirmed");
  } else if (c) { check(c.diskSlot === null, "input_evidence_cleanup_claim_retained"); await processAbsent(c.id); }
  check(app.authority.list(actor).every(w => !w.grantId || w.state === "stopped"), "input_evidence_cleanup_work_unsettled");
}

/** Runs four sequential synthetic-authority cases over the application's actual runtime and observed protected pipe. */
export async function runInputEvidenceCases(app: S14Application, actor: OwnerActor, conversationId: string,
  transport: InputEvidenceTransport, processes: { remember(id: string): Promise<void>; absent(id: string): Promise<void> }, results: InputEvidenceResults): Promise<void> {
  const view = () => app.computers.view(actor, "jit");
  const c = () => view().computer!;
  const pending = new Set<Promise<unknown>>();
  const sessions: ComputerSession[] = [];
  const attempts: string[] = [];
  let identity: { computer: string; slot: string } | undefined;
  const tracked = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> => {
    const settled = promise.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    pending.add(settled); void settled.then(() => pending.delete(settled)); return settled;
  };
  const waitForReply = (gate: ReturnType<InputEvidenceTransport["arm"]>, operation: Promise<PromiseSettledResult<unknown>>) =>
    Promise.race([gate.reached, operation.then(outcome => {
      // Preparation has no gate timer: a normal runtime/authority failure must still end the case promptly.
      if (outcome.status === "rejected") throw outcome.reason;
      throw new AppError("input_evidence_reply_not_received");
    })]);
  const rejected = async (result: Promise<PromiseSettledResult<unknown>>, codes: string[]) => {
    const outcome = await result;
    check(outcome.status === "rejected" && codes.includes(outcome.reason instanceof AppError ? outcome.reason.code : outcome.reason?.code), "input_evidence_expected_fence_missing");
  };
  const noPublication = (attemptId: string, workId: string) => {
    let denied = false;
    try { app.authority.commit(attemptId, { state: "ready", text: "Synthetic late result must be refused" }); }
    catch (error) { denied = error instanceof AppError && ["computer_attempt_fenced", "computer_scope_changed", "work_revoked", "attempt_fenced", "work_stopped", "authority_changed"].includes(error.code); }
    check(denied && app.authority.view(actor, workId).results.length === 0, "input_evidence_late_publication_not_fenced");
  };
  const stopWork = (workId: string) => {
    const work = app.authority.view(actor, workId).work;
    if (!["stopping", "stopped"].includes(work.state)) app.execute(actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId } });
  };
  const stop = async () => {
    await app.computers.drain();
    const current = c();
    if (current?.state === "stopped") { await processes.absent(current.id); return; }
    if (current && current.state !== "deleted") {
      app.execute(actor, { kind: "computer.stop", requestId: rid(), expectedRevision: current.revision,
        payload: { botId: "jit", computerId: current.id, generation: current.generation } });
      await app.computers.drain();
      check(c().state === "stopped", "input_evidence_stop_unconfirmed"); await processes.absent(c().id);
    }
  };
  const open = async (index: number) => {
    transport.check();
    const work = app.execute(actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(actor, conversationId).conversation.revision,
      payload: { conversationId, task: null, title: `Synthetic input evidence case ${index}`, purpose: "Verify installed offline input fencing", completionRule: "Bounded transport and authority assertions",
        bots: [{ id: "jit", revision: app.home(actor).bots.find(b => b.id === "jit")!.revision }], tools: ["computer", "effect_publish"], scopes: [],
        limits: { attempts: 1, steps: 1, calls: 16, outputBytes: 1024, wallMs: 180000, concurrency: 1, reads: 1 }, expiresAt: Date.now() + 180000 } }).work!;
    app.execute(actor, { kind: "computer.open", requestId: rid(), expectedRevision: c()?.revision ?? 0, payload: { botId: "jit", workId: work.id } });
    await app.computers.drain();
    check(c().state === "running" && c().limits.startupMs === 30000 && c().limits.idleMs === 300000, "input_evidence_start_unconfirmed");
    if (!identity) identity = { computer: c().id, slot: c().diskSlot!.id };
    check(c().id === identity.computer && c().diskSlot?.id === identity.slot, "input_evidence_computer_identity_changed");
    await processes.remember(c().id);
    const attempt = app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer", "effect_publish"], scopes: [], input: "Synthetic offline input evidence", calls: 16, outputBytes: 1024 });
    attempts.push(attempt.id);
    const session = app.computers.open(attempt.id); sessions.push(session);
    results.transportKernelFacts.push(`case_${index}_runtime_started_with_unchanged_kernel_disk_namespace_network_checks`);
    return { work, attempt, session };
  };
  const takeover = (kind: "takeover.start" | "takeover.end") => {
    const v = view();
    app.execute(actor, { kind, requestId: rid(), expectedRevision: v.computer!.revision,
      payload: { botId: "jit", computerId: v.computer!.id, generation: v.computer!.generation, leaseRevision: v.lease!.revision } });
  };
  const inputFrames = (from: number) => transport.trace.slice(from).filter(t => t.stage === "write" && t.method.startsWith("Input."));
  try {
    // Case 1: the gate receives Target.attachToTarget before takeover; no Input is dispatched.
    const a = await open(1), gate = transport.arm("Target.attachToTarget"), begin = transport.trace.length;
    let effect: ReturnType<typeof app.authority.proposeEffect> | undefined;
    try {
      effect = app.authority.proposeEffect(a.attempt.id, rid(), { kind: "publish", destination: "synthetic:held-offline", content: "Synthetic held action; no performer" }, Date.now() + 120000);
      check(effect.state === "pending" && !effect.supported, "input_evidence_effect_must_be_unsupported");
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "unsupported_effect") throw error;
      results.unrun.push("case_1_held_effect_handback_public_setup_unsupported");
    }
    const old = tracked(app.computers.agentInput(a.attempt.id, a.session.lease, { kind: "scroll", deltaY: 1 }));
    try {
      await waitForReply(gate, old); takeover("takeover.start"); gate.release();
      await rejected(old, ["input_lease_fenced"]);
      check(inputFrames(begin).length === 0, "input_evidence_attach_race_sent_input");
      const ownerLease = JSON.stringify(view().lease);
      a.session.release(); check(JSON.stringify(view().lease) === ownerLease && view().lease!.actor === "owner", "input_evidence_stale_release_cleared_owner");
      takeover("takeover.end");
      if (effect) {
        const held = app.authority.effect(actor, effect.id).effect;
        check(held.state === "pending" && !held.supported && held.revision === effect.revision && held.actionHash === effect.actionHash, "input_evidence_handback_changed_effect");
        results.controlledAssertions.push("case_1_handback_preserves_exact_unsupported_pending_effect");
      }
      results.transportKernelFacts.push("case_1_actual_attach_reply_received_no_Input_frame");
      results.controlledAssertions.push("case_1_attach_latch_takeover_fences_original_session");
    } finally { gate.close(); await old; }
    app.authority.settle(a.attempt.id, "synthetic_handler_returned"); stopWork(a.work.id); await stop();

    // Case 2: S0 has executed far enough to ACK. Holding its response says nothing about visible scrolling.
    const b = await open(2), ack = transport.arm("Input.dispatchMouseEvent"), begin2 = transport.trace.length;
    const s0 = tracked(app.computers.agentInput(b.attempt.id, b.session.lease, { kind: "scroll", deltaY: 1 }));
    let s1: ReturnType<typeof tracked> | undefined, owner: Promise<PromiseSettledResult<{ requestId: string; state: "succeeded" | "unknown" }>> | undefined;
    try {
      await waitForReply(ack, s0);
      s1 = tracked(app.computers.agentInput(b.attempt.id, b.session.lease, { kind: "scroll", deltaY: 2 }));
      takeover("takeover.start");
      const v = view();
      owner = tracked(app.computers.ownerInput(actor, { kind: "takeover.input", requestId: rid(), expectedRevision: v.computer!.revision,
        payload: { botId: "jit", computerId: c().id, generation: c().generation, leaseRevision: v.lease!.revision, input: { kind: "key", key: "Tab" } } }));
      check(inputFrames(begin2).length === 1, "input_evidence_owner_dispatched_before_settlement");
      const received = transport.trace.findLast(t => t.stage === "received" && t.method === "Input.dispatchMouseEvent")!;
      ack.release();
      await rejected(s0, ["input_lease_fenced"]); await rejected(s1, ["input_lease_fenced"]);
      const outcome = await owner;
      check(outcome.status === "fulfilled" && outcome.value.state === "succeeded", "input_evidence_owner_ack_unconfirmed");
      const frames = inputFrames(begin2), delivered = transport.trace.find(t => t.pipe === received.pipe && t.id === received.id && t.stage === "delivered")!;
      check(frames.length === 3 && frames[0]!.method === "Input.dispatchMouseEvent" && frames.slice(1).every(t => t.method === "Input.dispatchKeyEvent" && t.order > delivered.order && transport.trace.some(reply => reply.pipe === t.pipe && reply.id === t.id && reply.stage === "delivered")), "input_evidence_settlement_order_failed");
      const ownerLease = JSON.stringify(view().lease);
      b.session.release(); check(JSON.stringify(view().lease) === ownerLease && view().lease!.actor === "owner", "input_evidence_stale_release_cleared_owner");
      takeover("takeover.end");
      results.transportKernelFacts.push("case_2_actual_S0_scroll_ACK_and_both_owner_Tab_ACKs_received");
      results.controlledAssertions.push("case_2_S0_post_settlement_fence_S1_no_wheel_owner_key_pair_after_settlement_stale_release_safe");
    } finally { ack.close(); await Promise.allSettled([s0, ...(s1 ? [s1] : []), ...(owner ? [owner] : [])]); }
    app.authority.settle(b.attempt.id, "synthetic_handler_returned"); stopWork(b.work.id); await stop();

    for (const index of [3, 4]) {
      const x = await open(index), heldInput = transport.arm("Input.dispatchMouseEvent");
      const scroll = tracked(app.computers.agentInput(x.attempt.id, x.session.lease, { kind: "scroll", deltaY: 1 }));
      let runner: ReturnType<typeof tracked> | undefined;
      let heldRunner: ReturnType<InputEvidenceTransport["arm"]> | undefined;
      let output = 0;
      try {
        await waitForReply(heldInput, scroll);
        heldRunner = transport.arm("runner.spawn");
        runner = tracked(x.session.backend.spawn({ command: "printf synthetic-input-evidence", cwd: "/workspace", timeoutMs: 1000, onOutput: () => { output++; } }));
        await waitForReply(heldRunner, runner); // The actual runner process has returned; only its response is latched.
        const before = c();
        if (index === 3) app.execute(actor, { kind: "computer.stop", requestId: rid(), expectedRevision: before.revision,
          payload: { botId: "jit", computerId: before.id, generation: before.generation } });
        else {
          stopWork(x.work.id);
          check(app.authority.view(actor, x.work.id).authority?.revoked === true, "input_evidence_work_grant_not_revoked");
          app.computers.sweep();
        }
        check(c().generation > before.generation && view().lease!.actor === null && c().state === "stopping", "input_evidence_generation_not_fenced");
        const mark = transport.trace.length;
        await rejected(tracked(app.computers.agentInput(x.attempt.id, x.session.lease, { kind: "scroll", deltaY: 3 })), ["computer_attempt_fenced"]);
        await rejected(tracked(x.session.backend.writeFileAtomically("/workspace/must-not-exist", "Synthetic forbidden late write")), ["EIO"]);
        noPublication(x.attempt.id, x.work.id);
        check(transport.trace.length === mark, "input_evidence_late_dispatch_observed");
        heldInput.release(); heldRunner.release();
        await rejected(scroll, ["computer_scope_changed", "computer_attempt_fenced", "work_revoked"]);
        await rejected(runner, ["EIO"]);
        check(output === 0, "input_evidence_late_runner_output_published");
        x.session.release(); app.authority.settle(x.attempt.id, "actual_transports_returned");
        await app.computers.drain();
        check(c().state === "stopped", "input_evidence_stop_unconfirmed"); await processes.absent(c().id);
        if (index === 3) stopWork(x.work.id);
        check(app.authority.view(actor, x.work.id).work.state === "stopped", "input_evidence_work_stop_unsettled");
        results.transportKernelFacts.push(`case_${index}_actual_input_ACK_runner_response_received_and_component_process_removal_confirmed`);
        results.controlledAssertions.push(`case_${index}_${index === 3 ? "computer_stop" : "typed_work_stop_revoke_sweep"}_fences_generation_lease_later_input_write_publication_and_late_runner_output`);
      } finally { heldInput.close(); heldRunner?.close(); await Promise.allSettled([scroll, ...(runner ? [runner] : [])]); }
    }
    transport.check();
  } catch (error) {
    transport.abort("input_evidence_case_failed"); throw error;
  } finally {
    // No session/attempt is released as a running transport while its actual input/runner promise is unsettled.
    await Promise.allSettled(pending);
    for (const session of sessions) session.release();
    for (const attemptId of attempts) app.authority.settle(attemptId, "actual_transports_returned");
  }
}

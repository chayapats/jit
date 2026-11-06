import type { Model } from "schway/host";
import { composedFixture } from "./s15-composition";
import type { ClientRoutineDetail, ClientRoutineDraft, ClientRoutineProposal, ClientRoutineReceipt } from "../../src/s16/client/contracts";

/** Far policy/owner/recipient expiry so a fake clock can move to real calendar dates (DST weekends). */
export const far = Date.UTC(2036, 0, 1);
export const at = (iso: string) => Date.parse(iso);
let sequence = 0;
export const rid = (prefix = "r") => `${prefix}${++sequence}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Composed S15 fixture with S16 routines enabled. `replies` scripts the work model per run: each entry is
 * either a final text (one model turn) or a tool call followed by a final text. Runs past the queue reply
 * with ordinary observed-evidence text. Interpretation defaults to a read-only inspection of the computer.
 */
export async function routineFixture(options: { files?: boolean; start?: number; profile?: "default" | "personal" } = {}) {
  const replies: ({ tools?: { name: string; arguments: Record<string, unknown> }[]; text: string; hold?: boolean; gate?: Promise<unknown> })[] = [];
  const workInputs: string[] = [];
  let step = 0, current: (typeof replies)[number] | undefined;
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
    workInputs.push(JSON.stringify(request));
    // A run that ended at a held tool call never asked for its final text: a fresh run starts a new reply.
    if (!(request.items ?? []).some(item => item.type !== "user")) step = 0;
    if (step === 0) current = replies.shift() ?? { tools: [{ name: "read", arguments: { path: "status.txt" } }], text: "Completed with observed tool evidence." };
    // A held reply never completes on its own; only the run's abort signal (stop) ends it.
    if (current!.hold) { step = 0; await new Promise((_resolve, reject) => { const signal = (request as { signal?: AbortSignal }).signal; if (signal?.aborted) reject(new Error("aborted")); signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); }
    if (current!.gate && step === 0) await current!.gate;
    const tool = current!.tools?.[step];
    const content = tool ? [{ type: "tool_call" as const, id: rid("call"), name: tool.name, arguments: tool.arguments }] : [{ type: "text" as const, text: current!.text }];
    step = tool ? step + 1 : 0;
    yield { type: "message_complete", message: { type: "assistant", id: rid("m"), content } };
  } };
  const f = await composedFixture(options.profile ?? "default", false, undefined, base => {
    const policy = base.proposedPolicy!;
    policy.expiresAt = far; policy.budget!.expiresAt = far; for (const rule of policy.rules) rule.expiresAt = far;
    if (options.files) for (const rule of policy.rules) { if (!rule.adapters.includes("s16_files")) rule.adapters.push("s16_files"); if (!rule.operations.includes("artifact_create")) rule.operations.push("artifact_create"); }
    const verify = base.owner.verifyOwner;
    // Read-only inspection needs `stat`, which the shared fixture transport does not script.
    const transport = base.vm.transport;
    const vm = { ...base.vm, transport: (endpoint: Parameters<NonNullable<typeof transport>>[0]) => { const t = transport!(endpoint); const invoke = t.invoke.bind(t); t.invoke = async (request, input) => { if (request.op === "stat") { input.beforeStart(); return { type: "file" }; } return invoke(request, input); }; return t; } };
    return { ...base, vm, routines: {}, ...(options.files ? { files: {} } : {}), model: { ...base.model, scripted: () => model }, owner: { ...base.owner, verifyOwner: proof => { const owner = verify(proof); return owner && { ...owner, expiresAt: far }; } } };
  });
  for (const approval of f.recipientApprovals) approval.expiresAt = far;
  f.interpretation = { intent: "inspect", purposeId: "purpose", resourceIds: ["computer"], access: "read", subject: null };
  if (options.start) f.advance(options.start - f.now);
  const json = async <T>(response: Response, status = 200): Promise<T> => { const text = await response.text(); if (response.status !== status) throw new Error(`${response.status} ${text}`); return JSON.parse(text) as T; };
  const helpers = {
    replies, workInputs,
    draft(overrides: Partial<ClientRoutineDraft> = {}): ClientRoutineDraft {
      return { contract: "s16-routine-draft/v1", conversationId: "routine_chat", name: "Morning check", instruction: "Check the computer and summarize what changed.", schedule: { kind: "daily", time: "09:00" }, timezone: "UTC", misfire: "coalesce", quiet: false,
        limits: { maxRuns: 30, endsAt: f.now + 60 * 86400000 }, scope: { purposeId: "purpose", resourceIds: ["computer"], access: "read" }, ...overrides };
    },
    async propose(draft: ClientRoutineDraft, status = 200) { return json<ClientRoutineProposal>(await f.request("/api/s16/client/routines/proposals", "POST", draft), status); },
    async command<T = ClientRoutineReceipt>(body: Record<string, unknown>, status = 200) { return json<T>(await f.request("/api/s16/client/routines/commands", "POST", { requestId: rid("cmd"), ...body }), status); },
    async create(draft: ClientRoutineDraft) { const proposal = await helpers.propose(draft); return (await helpers.command({ kind: "routine.confirm", draft: proposal.draft, proposalHash: proposal.proposalHash })).routine!; },
    async detail(id: string) { return json<ClientRoutineDetail>(await f.request(`/api/s16/client/routines/${id}`)); },
    /** One protected service wake: tick, dispatch, CHAT drain, observe. */
    async wake() { await f.service.drain(); await f.service.conversation.drain(); await f.service.drain(); },
    json,
  };
  return Object.assign(f, helpers);
}
export type RoutineFixture = Awaited<ReturnType<typeof routineFixture>>;

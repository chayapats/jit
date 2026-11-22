import { expect, test } from 'bun:test';
import type { Model } from 'schway/host';
import { JitClient } from '../src/s16/client';
import type { ClientRoutineDraft } from '../src/s16/client/contracts';
import { composedFixture } from './fixtures/s15-composition';

const uid = () => crypto.randomUUID().replaceAll('-', '');
const far = Date.UTC(2036, 0, 1);
const at = (value: string) => Date.parse(value);

test.each([10, 18])('one actual JitClient follows a delegated scheduled responsibility with finite %i tool calls and preserves restart or budget holds', async toolCalls => {
  let physicalModelCalls = 0, vmReads = 0;
  const model: Model = { provider: 'codex-subscription', id: 'fixture-model', async *stream(request) {
    physicalModelCalls++;
    const last = request.items.at(-1);
    const content = last?.type === 'tool_result'
      ? [{ type: 'text' as const, text: 'Observed delegated check: ' + last.content.slice(0, 400) }]
      : request.tools?.some(tool => tool.name === 'delegate')
        ? [{ type: 'tool_call' as const, id: uid(), name: 'delegate', arguments: { assignments: [{ to: 'specialist', task: 'Read status.txt and report the observed status.' }] } }]
        : [{ type: 'tool_call' as const, id: uid(), name: 'read', arguments: { path: 'status.txt' } }];
    yield { type: 'message_complete', message: { type: 'assistant', id: uid(), content } };
  } };
  // Existing owning composition, POLICY, CHAT, routines, delegation and VM gateway.
  // Only provider/VM transports and the clock are scripted; this is not native UI or live-account evidence.
  const f = await composedFixture('default', false, undefined, base => {
    const policy = base.proposedPolicy!;
    policy.expiresAt = far; policy.budget!.expiresAt = far; for (const rule of policy.rules) rule.expiresAt = far;
    const verify = base.owner.verifyOwner;
    const transport = base.vm.transport;
    const vm = { ...base.vm, transport: (endpoint: Parameters<NonNullable<typeof transport>>[0]) => {
      const session = transport!(endpoint), invoke = session.invoke.bind(session);
      session.invoke = async (request, input) => {
        if (/(^|\/)status\.txt$/.test(String(request.path))) {
          if (request.op === 'stat') { input.beforeStart(); return { type: 'file' }; }
          if (request.op === 'read') { input.beforeStart(); vmReads++; return { data: Buffer.from('The fixture computer is ready.').toString('base64') }; }
        }
        return invoke(request, input);
      };
      return session;
    } };
    return { ...base, vm, bots: {}, routines: {}, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 },
      // A read includes workspace/path/stat primitives. The smaller child slice must visibly hold;
      // the larger finite slice exercises the completed journey under the same installed read ceiling.
      conversation: { ...base.conversation, limits: { ...base.conversation.limits, modelCalls: 12, toolCalls } },
      owner: { ...base.owner, verifyOwner: proof => { const owner = verify(proof); return owner && { ...owner, expiresAt: far }; } },
      model: { ...base.model, scripted: () => model } };
  });
  try {
    for (const approval of f.recipientApprovals) approval.expiresAt = far;
    f.advance(at('2026-03-02T08:00:00Z') - f.now);
    f.interpretation = { intent: 'inspect', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null };
    const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
      const url = new URL(request.url);
      return f.request(url.pathname + url.search, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers));
    } });
    expect((await client.bootstrap()).capabilities.routines?.available).toBe(true);
    const draft: ClientRoutineDraft = { contract: 's16-routine-draft/v1', conversationId: 'delegated_routine', name: 'Delegated daily check', instruction: 'Ask the specialist to check the computer and summarize the observed status.',
      schedule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', misfire: 'coalesce', quiet: false,
      limits: { maxRuns: 3, endsAt: at('2026-03-10T00:00:00Z') }, scope: { purposeId: 'purpose', resourceIds: ['computer'], access: 'read' } };
    const proposal = await client.proposeRoutine(draft);
    const command = { kind: 'routine.confirm', requestId: 'save_delegated_daily', draft: proposal.draft, proposalHash: proposal.proposalHash };
    const routine = (await client.routineCommand(command)).routine!;
    expect((await client.routines()).routines).toHaveLength(1);
    const wake = async () => { await f.service.drain(); await f.service.conversation.drain(); await f.service.drain(); };
    f.advance(at('2026-03-02T09:00:01Z') - f.now); await wake();
    const first = await client.routine(routine.id);
    expect(first.occurrences).toHaveLength(1); expect(first.occurrences[0]).toMatchObject({ state: 'succeeded', trigger: 'schedule' });
    const firstRequest = await client.request(first.occurrences[0]!.requestId!);
    expect(firstRequest.row.state).toBe('done'); expect(firstRequest.row.children).toHaveLength(1);
    if (toolCalls === 10) {
      expect(firstRequest.row.children![0]).toMatchObject({ kind: 'peer', botId: 'specialist', state: 'needs_you', code: 'result_unavailable' });
      const held = await client.request(firstRequest.row.children![0]!.requestId);
      expect(held.row.result).toBeNull(); expect(held.row.evidence).toEqual([]);
      expect(held.row.needsYou?.code).toBe('result_unavailable');
      expect(f.service.conversation.store.evidence(held.receipt.requestId).some(item => item.tool === 'read' && item.isError && item.content === 'read_bound_exhausted')).toBe(true);
      expect(vmReads).toBe(0); return;
    }
    expect(firstRequest.row.children![0]).toMatchObject({ kind: 'peer', botId: 'specialist', state: 'done' });
    const child = await client.request(firstRequest.row.children![0]!.requestId);
    expect(child.row.state).toBe('done'); expect(child.row.evidence.some(item => item.tool === 'read' && !item.isError)).toBe(true);
    expect(firstRequest.row.result?.text).toContain('Observed delegated check');
    expect(child.row.result?.text).toContain('The fixture computer is ready.'); expect(vmReads).toBe(1);
    const modelBefore = physicalModelCalls, vmBefore = f.vmCalls.length, oldService = f.service;
    await f.reopen(); expect(f.service).not.toBe(oldService);
    await client.bootstrap(); await wake(); await wake();
    expect(await client.request(firstRequest.receipt.requestId)).toEqual(firstRequest);
    expect(await client.request(child.receipt.requestId)).toEqual(child);
    expect(physicalModelCalls).toBe(modelBefore); expect(f.vmCalls).toHaveLength(vmBefore); expect(vmReads).toBe(1);
    expect((await client.routineCommand(command)).routine!.id).toBe(routine.id);
    expect((await client.routines()).routines).toHaveLength(1);
    // The original responsibility remains due after restart; the next instant starts exactly one new parent/child.
    f.advance(at('2026-03-03T09:00:01Z') - f.now); await wake(); await wake();
    const second = await client.routine(routine.id);
    expect(second.occurrences).toHaveLength(2); expect(second.occurrences.every(row => row.state === 'succeeded')).toBe(true);
    const secondOccurrence = second.occurrences.find(row => row.id !== first.occurrences[0]!.id)!;
    const secondRequest = await client.request(secondOccurrence.requestId!);
    expect(secondRequest.receipt.requestId).not.toBe(firstRequest.receipt.requestId);
    expect(secondRequest.row.children).toHaveLength(1); expect(secondRequest.row.children![0]!.requestId).not.toBe(child.receipt.requestId);
    expect(physicalModelCalls - modelBefore).toBe(4);
    expect(vmReads).toBe(2);
    expect(await client.request(firstRequest.receipt.requestId)).toEqual(firstRequest);
    expect(second.summary.routine.runsUsed).toBe(2);
    await client.routineCommand({ kind: 'routine.pause', requestId: 'pause_delegated_daily', routineId: routine.id, expectedRevision: second.summary.routine.revision });
    const callsAtPause = physicalModelCalls; f.advance(86400001); await wake();
    expect(physicalModelCalls).toBe(callsAtPause); expect((await client.routine(routine.id)).occurrences).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);

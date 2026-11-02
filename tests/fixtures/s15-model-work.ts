import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyService, type ActionAdapter, type CatalogKind, type PolicyInput, type Selection, type WorkRequest } from '../../src/s15/policy';
import { equal, unknownUsage, zero } from '../../src/s15/policy/validation';
import type { ConversationRequest } from '../../src/s15/conversation';
import type { ApprovedModelRoute, ModelOptions } from '../../src/s15/model';
import type { AttemptSettlement, WorkOptions } from '../../src/s15/work';

export const ref = (id: string) => ({ id, revision: 1, generation: 1 });
export const ordinary: Selection = { route: ref('route'), model: ref('ordinary'), effort: 'low' };
export const difficult: Selection = { route: ref('route'), model: ref('difficult'), effort: 'high' };
export const modelBound = () => ({ ...zero(), attempts: 1, steps: 1, calls: 1, outputBytes: 32768, activeMs: 10000, spendMinor: '0' });
export const observed = (extra: Partial<AttemptSettlement> = {}): AttemptSettlement => ({ transportSettled: true, executionSettled: true, effects: 'known', progress: 'none', evidenceRefs: ['evidence'], recommendation: 'Inspect the failing check before choosing another approach.', usage: { ...unknownUsage(), attempts: 1, calls: 1 }, ...extra });

export function modelWorkFixture(input: { budget?: boolean; subscription?: boolean; root?: string; create?: boolean; adapters?: ActionAdapter[] } = {}) {
  const root = input.root ?? mkdtempSync(join(tmpdir(), 'jit-s15-model-work-')), create = input.create ?? true;
  let now = 1000, generation = 1, allow = true;
  const catalog = new Map<string, { ref: ReturnType<typeof ref>; active: boolean }>();
  for (const [kind, names] of Object.entries({ purpose: ['purpose', 'outside'], bot: ['bot'], resource: ['repo'], recipient: ['provider'], route: ['route'], model: ['ordinary', 'difficult'] })) for (const name of names) catalog.set(kind + ':' + name, { ref: ref(name), active: true });
  const routes: ApprovedModelRoute[] = [ordinary, difficult].map((selection, i) => ({ selection: structuredClone(selection), provider: 'codex', modelId: selection.model.id, account: ref('account'), billing: ref('subscription'), recipient: ref('provider'), charge: 'subscription', availability: 'available', efforts: ['low', 'high'], effortEvidence: 'requested_only', upperBound: modelBound(), rank: { ordinary: i, difficult: 1 - i } }));
  let pins = { route: null, model: null, effort: null } as ReturnType<ModelOptions['registry']['pins']>;
  const registry: ModelOptions['registry'] = { list: () => routes, current: choice => routes.find(row => equal(row.selection, choice)) ?? null, pins: () => pins };
  const open = (create: boolean) => openPolicyService({ runtime: 's15', path: join(root, 'policy.sqlite'), create, installationId: 'fixture', ownerGeneration: () => generation, now: () => now,
    verifyOwner: proof => proof === 'fixture_owner' ? { id: 'owner', generation, expiresAt: 1000000 } : null,
    catalogs: { current: (kind: CatalogKind, id: string) => catalog.get(kind + ':' + id) ?? null, allows: () => allow }, adapters: input.adapters ?? [],
    reads: [{ operation: 'read', validate() {} }],
    ...(input.subscription ? { subscriptionModels: { current: selection => registry.current(selection)?.charge === 'subscription' && registry.current(selection)?.availability === 'available', concurrency: 1, perWork: { calls: 6, steps: 6, activeMs: 60000 } } } : {}),
  });
  let policy = open(create), owner = policy.owner.authenticate('fixture_owner');
  const configuration: PolicyInput = { purposes: [ref('purpose')], bots: [ref('bot')], resources: [ref('repo')], recipients: [ref('provider')], selections: [ordinary, difficult], rules: [], expiresAt: 900000,
    budget: input.budget === false ? null : { currency: 'USD', startsAt: 0, expiresAt: 900000, ceiling: { attempts: 20, steps: 20, calls: 20, reads: 20, outputBytes: 1000000, activeMs: 500000, spendMinor: '100' }, concurrency: 5 } };
  if (create) policy.owner.install(owner, 'install', 0, configuration);
  const sources = new Map<string, ConversationRequest>();
  function source(sourceId: string, extra: Partial<WorkRequest> = {}) {
    const request: WorkRequest = { requestId: sourceId, intent: 'execute', access: 'reversible_write', purpose: ref('purpose'), bot: ref('bot'), resources: [ref('repo')], recipients: [], selection: ordinary, selectionPin: null, expiresAt: 800000, subject: { resource: ref('repo'), issue: 42 }, ...extra };
    const receipt = policy.owner.admit(owner, request), authority = receipt.work;
    const command = { contract: 's15-conversation/v1' as const, requestId: sourceId, conversationId: 'conversation', text: 'Implement issue #42 and keep responsibility until checks pass.', continuation: null };
    const record: ConversationRequest = { receipt: { contract: 's15-conversation-receipt/v1', requestId: sourceId, rootRequestId: sourceId, conversationId: 'conversation', receivedAt: now }, command, interpretationRequest: command, owner: { id: 'owner', generation }, revision: 1,
      intent: { kind: request.intent === 'accept_obligation' ? 'accept' : request.intent === 'inspect' ? 'inspect' : 'execute', subject: 'issue:42', instruction: command.text, scope: { purposeId: 'purpose', resourceIds: ['repo'], access: request.access! } }, state: authority ? 'completed' : 'accepted', code: null,
      authority: authority ? { id: authority.id, purposeId: 'purpose', policyRevision: authority.policyRevision, resources: ['repo'], route: { provider: 'codex', model: 'ordinary' }, limits: { modelCalls: 6, toolCalls: 6, outputBytes: 10000, activeMs: 10000 } } : null,
      phase: 'work', interpretation: null, interpretationCalls: 0, modelCalls: 0, toolCalls: 0, result: null, usage: null, actions: [], decision: null };
    sources.set(sourceId, record); return { record, authority, actor: authority ? policy.control.bindWork(authority.id) : null };
  }
  const clock: NonNullable<ModelOptions['clock']> = { now: () => now, monotonicNow: () => now, sleep: (_ms, signal) => new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) };
  const modelOptions = (): ModelOptions => ({ runtime: 's15', path: join(root, 'model.sqlite'), create, installationId: 'fixture', nativeDirectory: join(root, 'native'), policy, registry, clock,
    limits: { turns: 4, attempts: 1, activeMs: 10000, outputBytes: 10000, contextWindow: 32768, inputChars: 65536 } });
  const workOptions = (): WorkOptions => ({ runtime: 's15', path: join(root, 'work.sqlite'), create, installationId: 'fixture', policy, now: () => now,
    remainingCalls: workId => { const rows = policy.control.reservations(workId); return input.budget === false ? input.subscription ? 6 - rows.reduce((sum, r) => sum + r.upperBound.calls, 0) : null : 20 - policy.control.usage().charged.calls; },
    conversation: { view(actor, id) { policy.owner.current(actor); const source = sources.get(id); if (!source) throw new Error('not_found'); return structuredClone(source); } },
  });
  return { root, get policy() { return policy; }, get owner() { return owner; }, configuration, routes, registry, sources, catalog, clock, source, modelOptions, workOptions,
    get now() { return now; }, advance(ms: number) { now += ms; }, set pins(value: typeof pins) { pins = value; }, set allow(value: boolean) { allow = value; }, set generation(value: number) { generation = value; },
    reopen() { policy.control.close(); policy = open(false); owner = policy.owner.authenticate('fixture_owner'); },
    cleanup(remove = true) { policy.control.close(); if (remove) rmSync(root, { recursive: true, force: true }); },
  };
}

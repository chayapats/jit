import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../../src/errors';
import { ConnectionVault } from '../../src/exec/connections';
import { S14Application } from '../../src/s14/application';
import { s14Policy } from '../../src/s14/policy';
import { S14Store } from '../../src/s14/store';
import { readS15RuntimeConfig } from '../../src/s15/runtime-config';
import { openS16InstallationLease } from '../../src/s16/operations/installation-lease';
import { assertS16OperationsOwnerBinding } from '../../src/s16/operations/operations-owner';
import { FixturePaymentPort } from '../../src/s15/payments';
import type { AdapterResult, PolicyInput } from '../../src/s15/policy';
import { unknownUsage } from '../../src/s15/policy/validation';
import { VmManagers } from '../../src/s15/vm/managers';
import type { VmManagement } from '../../src/s15/vm/types';
import { composedFixture, ref } from './s15-composition';

/** Private test host input. The package's own src and dependencies supply every owning service class. */
export interface S16ServiceReleaseHostInput { mode: 'seed' | 'attach'; configPath: string; externalDirectory: string; authPath: string; externalBackendModule: string }
interface ExternalState {
  contract: 's16-service-release-external-fixture/v1';
  counts: { model: number; interpreter: number; vm: number; payment: number; reconcile: number; vmManagement: number };
  files: Record<string, string>; payment: Record<string, AdapterResult>;
  selectedManagerId: string | null; managers: Record<string, { identity: string; state: 'running' | 'stopped' }>;
}
interface Message { seq: number; kind: string; value?: any }

/** Actual copied owning service; external model/VM/payment ports remain explicit persistent fixtures. */
export async function openS16ServiceReleaseHost(input: S16ServiceReleaseHostInput) {
  const config = readS15RuntimeConfig(input.configPath), externalPath = join(input.externalDirectory, 'external.fixture.json');
  const state = JSON.parse(readFileSync(externalPath, 'utf8')) as ExternalState;
  if (state.contract !== 's16-service-release-external-fixture/v1' || !['seed', 'attach'].includes(input.mode)) throw Error('fixture_host_invalid');
  const save = () => writeFileSync(externalPath, JSON.stringify(state), { mode: 0o600 });
  const observe = (kind: 'model' | 'interpreter' | 'vm') => { state.counts[kind]++; save(); };
  class Files extends Map<string, Uint8Array> {
    override set(key: string, value: Uint8Array) { super.set(key, value); state.files[key] = Buffer.from(value).toString('base64'); save(); return this; }
  }
  const files = new Files(); for (const [key, value] of Object.entries(state.files)) Map.prototype.set.call(files, key, Buffer.from(value, 'base64'));
  const manager = (id: string): VmManagement => ({
    async inspect() { const current = state.managers[id]; if (!current) throw Error('fixture_manager_missing'); return { state: current.state, identity: current.identity, boot: 'boot', cpuCount: 2, memoryBytes: 1e9, diskBytes: 1e9, network: 'isolated', nicMac: '52:54:00:12:34:56' }; },
    async stop() { state.managers[id]!.state = 'stopped'; state.counts.vmManagement++; save(); }, async start() { state.managers[id]!.state = 'running'; state.counts.vmManagement++; save(); },
    async snapshot() { state.counts.vmManagement++; save(); }, async restore() { throw Error('unexpected_fixture_disk_restore'); }, async retireSnapshot() { state.counts.vmManagement++; save(); },
  });
  const payment = new FixturePaymentPort([{ id: 'invoice', version: 'v1', purpose: ref('purpose'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '5.00', memo: 'Controlled fixture only', expiresAt: 800000 }]);
  const pay = payment.pay.bind(payment);
  payment.pay = async quote => {
    state.counts.payment++; save(); if (state.payment[quote.id]) throw Error('fixture_external_duplicate_payment');
    const result = await pay(quote); state.payment[quote.id] = result; save(); return result;
  };
  payment.reconcile = async transaction => { state.counts.reconcile++; save(); return structuredClone(state.payment[transaction.quoteId] ?? { outcome: 'unknown', actual: unknownUsage(), transportSettled: false }); };
  const lease = openS16InstallationLease({ directory: config.directory, mode: 'shared' }); assertS16OperationsOwnerBinding(lease, config.directory);
  const store = new S14Store(join(config.directory, 'owner/owner.sqlite'));
  const app = new S14Application(store, { policy: s14Policy({}), chat: { async reply() { throw new AppError('s15_conversation_required'); } }, now: () => 1000 });
  let token: string;
  if (input.mode === 'seed') {
    if (existsSync(input.authPath)) throw Error('fixture_owner_already_seeded');
    const password = crypto.randomUUID(); await app.provisionOwner(password); token = await app.login(password); writeFileSync(input.authPath, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
  } else token = JSON.parse(readFileSync(input.authPath, 'utf8')).token;
  const owner = () => app.authenticate(token).actor;
  const generation = () => store.read(tx => tx.get<{ generation: number }>('SELECT generation FROM owner')!.generation);
  // The external fixture backend is independent of the selected controller package.
  // Keep its implementation and persisted records across A -> B -> A, as with remote services.
  const externalBackend = await import(pathToFileURL(input.externalBackendModule).href) as typeof import('../../src/s15/effects');
  const f = await composedFixture('default', false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { if (!rule.adapters.includes('s16_files')) rule.adapters.push('s16_files'); if (!rule.operations.includes('artifact_create')) rule.operations.push('artifact_create'); }
    options.proposedPolicy!.budget!.ceiling.spendMinor = '10000';
    const managers = new Map<string, VmManagement>([['manager', manager('manager')]]);
    for (const id of Object.keys(state.managers)) if (id !== 'manager') managers.set(id, manager(id));
    return { ...options, directory: join(config.directory, 'runtime'), create: false, installationId: config.installationId, files: {}, computers: { idleStopMs: 1800000, sweepMs: 0 }, browser: { ...options.browser!, resource: ref('browser') },
      owner: { authenticate(value) { lease.assertCurrent(); const auth = app.authenticate(value); return { proof: auth.actor, csrf: auth.csrf }; }, generation,
        verifyOwner(proof) { try { lease.assertCurrent(); store.read(tx => app.requireOwner(tx, proof as ReturnType<typeof owner>)); return { id: 'owner', generation: generation(), expiresAt: 900000 }; } catch { return null; } },
        verifyCsrf: (expected, supplied) => app.verifyCsrf(expected, supplied) },
      vm: { ...options.vm, managementVault: new ConnectionVault(join(config.directory, 'vault'), { forbidden: [join(config.directory, 'runtime')] }), managers } };
  }, true, owner, { mode: input.mode, parent: input.externalDirectory, files, manager: manager('manager'), payment, observe, recordServiceFactory: externalBackend.openFixtureRecordService });
  if (input.mode === 'seed') {
    if (!(f.service.vmManagers instanceof VmManagers)) throw Error('fixture_managers_missing');
    const selected = f.service.vmManagers.register(f.owner, { kind: 'lima', instance: 'jit-work-release-fixture' }); state.selectedManagerId = selected.managerId; state.managers[selected.managerId] = state.managers.manager!; save();
    f.service.vmManagers.set(selected.managerId, manager(selected.managerId));
    const key = join(input.externalDirectory, 'fixture-key'), known = join(input.externalDirectory, 'fixture-known-hosts');
    writeFileSync(key, 'Disposable scripted SSH marker.', { mode: 0o600, flag: 'wx' }); writeFileSync(known, 'Disposable scripted host marker.', { mode: 0o600, flag: 'wx' });
    f.service.vmStore.save({ ...f.service.vmStore.registration('vm'), managerId: selected.managerId, endpoint: { host: 'fixture.invalid', port: 22, user: 'jit', identityFile: key, knownHostsFile: known } });
  }
  let closed = false;
  const close = async () => { if (closed) return; await f.close(); await app.signIns.close(); store.close(); lease.close(); closed = true; };
  return { close, async handle(message: Message): Promise<unknown> {
    const value = message.value;
    if (message.kind === 'fetch') {
      const request = new Request(value.url, { method: value.method, headers: value.headers, ...(value.body === null ? {} : { body: Buffer.from(value.body, 'base64') }) });
      const response = await f.service.fetch(request); return { status: response.status, headers: [...response.headers], body: Buffer.from(await response.arrayBuffer()).toString('base64') };
    }
    if (message.kind === 'drain') { await f.service.drain(); return { state: 'drained' }; }
    if (message.kind === 'script') { f.script = value; return { state: 'scripted' }; }
    if (message.kind === 'facts') return { usage: f.service.policy.control.usage(), policy: f.service.policy.owner.current(f.owner), counts: state.counts, ownerGeneration: generation(), assigned: f.service.computerScopes!.assigned('bot'), vm: f.service.vmStore.registration('private_vm_1'), ...(value?.action ? { slip: f.service.policy.owner.actionSlip(f.owner, value.action) } : {}) };
    if (message.kind === 'assign_private') {
      if (!(f.service.vmManagers instanceof VmManagers)) throw Error('fixture_managers_missing');
      const id = value.id as string; if (!/^[a-z0-9_]{1,40}$/.test(id)) throw Error('fixture_private_id_invalid');
      const selected = f.service.vmManagers.register(f.owner, { kind: 'lima', instance: 'jit-work-release-' + id.replaceAll('_', '-') }), identity = 'fixture-' + id;
      state.managers[selected.managerId] = { state: 'running', identity }; save(); f.service.vmManagers.set(selected.managerId, manager(selected.managerId));
      const shared = f.service.vmStore.registration('vm'); f.service.vmStore.save({ ...shared, id, managerId: selected.managerId, machineIdentity: identity, endpoint: { ...shared.endpoint, host: 'private.fixture.invalid' } });
      f.service.computerScopes!.assignPrivate(id, 'bot'); return { state: 'private', vmId: id };
    }
    if (message.kind === 'unknown_payment') {
      const currentPay = payment.pay.bind(payment); payment.pay = async quote => { await currentPay(quote); throw Error('fixture_lost_payment_response'); };
      const admitted = f.service.policy.owner.admit(f.owner, { requestId: 'unknown_payment', intent: 'execute', access: 'effect', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[0]!, resources: [f.policyInput.resources[2]!], recipients: [f.policyInput.recipients[1]!], selection: f.choice, selectionPin: null, expiresAt: 800000 });
      const actor = f.service.policy.control.bindWork(admitted.work!.id), prepared = f.service.policy.work.prepare(actor, { slot: 'invoice', adapter: 'fixture_payment', proposal: { quoteId: 'invoice', quoteVersion: 'v1' } });
      if (prepared.decision.state !== 'hold') throw Error('fixture_payment_not_held'); const action = { id: prepared.action.id, revision: prepared.action.revision, actionHash: prepared.action.actionHash };
      f.service.policy.owner.decide(f.owner, { requestId: 'approve_fixture_payment', action, decision: 'approve', expiresAt: 800000 });
      const result = await f.service.policy.work.dispatch(actor, action); if (result.outcome !== 'unknown') throw Error('fixture_payment_not_unknown'); return { workId: admitted.work!.id, action };
    }
    if (message.kind === 'duplicate_payment') { try { await f.service.policy.work.dispatch(f.service.policy.control.bindWork(value.workId), value.action); return { refused: false }; } catch { return { refused: true }; } }
    if (message.kind === 'policy_change') {
      const current = f.service.policy.owner.current(f.owner), policy = structuredClone(f.policyInput) as PolicyInput;
      if (!current) throw Error('fixture_policy_missing');
      policy.budget!.ceiling.outputBytes = 900000001; f.service.policy.owner.install(f.owner, 'trial_policy_change', current.revision, policy); return f.service.policy.owner.current(f.owner);
    }
    if (message.kind === 'close') { await close(); return { state: 'closed' }; }
    throw Error('fixture_host_command_invalid');
  } };
}

if (import.meta.main) {
  let host: Awaited<ReturnType<typeof openS16ServiceReleaseHost>> | undefined;
  try {
    const input = await Bun.stdin.json() as S16ServiceReleaseHostInput; host = await openS16ServiceReleaseHost(input); process.send?.({ kind: 'ready' });
    let chain = Promise.resolve();
    process.on('message', (message: Message) => { chain = chain.then(async () => {
      try { const result = await host!.handle(message); process.send?.({ seq: message.seq, ok: true, value: result }); if (message.kind === 'close') process.disconnect?.(); }
      catch (error) { process.send?.({ seq: message.seq, ok: false, error: (error as { code?: string }).code ?? 'fixture_host_command_failed' }); }
    }); });
  } catch (error) { try { await host?.close(); } catch { /* Disposable fixture failure remains a failure. */ } process.send?.({ kind: 'failed', error: (error as { code?: string; message?: string }).code ?? (error as Error).message, detail: (error as Error).stack }); process.disconnect?.(); process.exitCode = 1; }
}

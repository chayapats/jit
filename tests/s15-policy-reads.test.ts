import { afterEach, expect, test } from 'bun:test';
import type { ReadClaim, ReadInput, ReadOperation } from '../src/s15/policy';
import { PolicyError } from '../src/s15/policy';
import { exact, unknownUsage, zero } from '../src/s15/policy/validation';
import { actionRef, fence, fixture, ref, type Fixture } from './fixtures/s15-policy';
const fixtures: Fixture[] = [];
const operations: ReadOperation[] = ['read', 'grep', 'find', 'ls', 'workspace_setup'];
function setup() {
  const f = fixture({ reads: operations.map(operation => ({ operation, validate(payload) { exact(payload, ['path']); if (typeof payload.path !== 'string' || !/^\/workspace\/[a-z_]+$/.test(payload.path)) throw new PolicyError('outside_scope'); } })) }); fixtures.push(f); f.install(); return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const input = (requestId = 'read_one'): ReadInput => ({ requestId, resource: ref('account'), operation: 'read', exactPayload: { path: '/workspace/evidence' }, upperBound: { ...zero(), reads: 1 }, fences: [fence('vm', 'vm'), fence('input', 'input')] });
const success = () => ({ outcome: 'succeeded' as const, basis: 'remote_verified' as const, code: null, actual: { ...unknownUsage(), reads: 1 }, transportSettled: true });
const allowed = (result: ReturnType<Fixture['service']['work']['reserveRead']>): ReadClaim => { expect(result.state).toBe('allow'); if (result.state !== 'allow') throw new Error(result.code); return result.claim; };

test.each(operations)('inspect performs declared %s with a separate durable read claim', operation => {
  const f = setup(), w = f.admit({ intent: 'inspect', access: 'read', readLimit: 5 }).actor!, claim = allowed(f.service.work.reserveRead(w, { ...input(), operation })); expect(claim.input.operation).toBe(operation); expect(f.service.control.usage().charged.calls).toBe(0); expect(f.service.control.usage().charged.reads).toBe(1);
  const dispatched = f.service.work.guardRead(w, claim.id); expect(dispatched.input.exactPayload).toEqual({ path: '/workspace/evidence' }); f.service.control.settleRead(claim.id, success(), 'a'.repeat(64)); expect(f.service.control.publishRead(w, claim.id)).toEqual({ observation: success(), resultHash: 'a'.repeat(64) }); expect(f.service.control.usage().unsettled).toBe(0); expect(f.calls).toBe(0);
});
test.each(['write', 'send', 'system_admin', 'fetch', 'payment'])('inspect denies %s without a read charge', operation => {
  const f = setup(), w = f.admit({ intent: 'inspect', access: 'read' }).actor!; expect(f.service.work.reserveRead(w, { ...input(), operation: operation as ReadOperation })).toEqual({ state: 'deny', code: 'read_operation_unavailable' }); expect(f.service.control.usage().charged.reads).toBe(0); expect(() => f.prepare(w)).toThrow('outside_scope');
});
test('a read handler refuses write/egress arguments and paths outside its fixed workspace', () => {
  const f = setup(), w = f.admit({ intent: 'inspect', access: 'read' }).actor!; expect(f.service.work.reserveRead(w, { ...input(), exactPayload: { path: '/workspace/evidence', write: true } })).toEqual({ state: 'deny', code: 'invalid_shape' }); expect(f.service.work.reserveRead(w, { ...input(), exactPayload: { path: 'https://new.example/' } })).toEqual({ state: 'deny', code: 'outside_scope' }); expect(f.service.control.usage().charged.reads).toBe(0);
});
test.each(['resource', 'bot', 'vm', 'input'] as const)('read guard denies stale %s immediately before I/O', kind => {
  const f = setup(), w = f.admit({ intent: 'inspect', access: 'read' }).actor!, claim = allowed(f.service.work.reserveRead(w, input())); f.catalog.get(kind + ':' + (kind === 'resource' ? 'account' : kind))!.ref.generation++; expect(() => f.service.work.guardRead(w, claim.id)).toThrow('stale_authority'); expect(f.service.control.usage().unsettled).toBe(1); f.service.control.settleRead(claim.id, { outcome: 'not_dispatched', basis: 'local_guard', code: 'stale_authority', actual: unknownUsage(), transportSettled: true }, null); expect(f.service.control.usage().charged.reads).toBe(1);
});
test('per-work read bound exhausts while another work keeps its own remaining scope', () => {
  const f = setup(), w = f.admit({ intent: 'inspect', access: 'read', readLimit: 1 }).actor!; allowed(f.service.work.reserveRead(w, input())); expect(f.service.work.reserveRead(w, input('read_two'))).toEqual({ state: 'deny', code: 'read_bound_exhausted' }); const other = f.admit({ intent: 'inspect', readLimit: 1 }).actor!; allowed(f.service.work.reserveRead(other, input())); expect(f.service.control.usage().charged.reads).toBe(2);
});
test('duplicate reservation and duplicate guard never claim or charge the read twice, including restart', () => {
  const f = setup(), { actor, receipt } = f.admit({ intent: 'inspect' }), claim = allowed(f.service.work.reserveRead(actor!, input())); expect(f.service.work.reserveRead(actor!, input())).toEqual({ state: 'deny', code: 'already_claimed' }); expect(f.service.work.reserveRead(actor!, { ...input(), exactPayload: { path: '/workspace/other' } })).toEqual({ state: 'deny', code: 'request_id_conflict' }); f.service.work.guardRead(actor!, claim.id); expect(() => f.service.work.guardRead(actor!, claim.id)).toThrow('already_claimed'); f.reopen(); const recovered = f.service.control.bindWork(receipt.work!.id); expect(() => f.service.work.guardRead(recovered, claim.id)).toThrow('already_claimed'); expect(f.service.work.reserveRead(recovered, input())).toEqual({ state: 'deny', code: 'already_claimed' }); expect(f.service.control.usage().charged.reads).toBe(1);
});
test('read settlement preserves real facts while revoked work cannot publish them', () => {
  const f = setup(), w = f.admit({ intent: 'inspect' }).actor!, claim = allowed(f.service.work.reserveRead(w, input())); f.service.work.guardRead(w, claim.id); f.service.owner.revoke(f.owner, 'stop_read_work', { kind: 'work', id: claim.workId }); f.service.control.settleRead(claim.id, success(), 'b'.repeat(64)); expect(() => f.service.control.publishRead(w, claim.id)).toThrow('authority_revoked'); expect(f.service.control.usage().unsettled).toBe(0);
});
test('read expiry and scope/actor identity are checked without widening purpose/resources', () => {
  const f = setup(), w = f.admit({ intent: 'inspect' }).actor!; expect(f.service.work.reserveRead(w, { ...input(), resource: ref('outside') })).toEqual({ state: 'deny', code: 'outside_scope' }); const claim = allowed(f.service.work.reserveRead(w, input())); const other = f.admit({ intent: 'inspect' }).actor!; expect(() => f.service.work.guardRead(other, claim.id)).toThrow('outside_scope'); f.now = claim.expiresAt; expect(() => f.service.work.guardRead(w, claim.id)).toThrow('expired');
});
test('inference-only bootstrap cannot obtain a read claim', () => {
  const f = setup(); f.input.interpretationPurpose = ref('purpose'); f.install(); const prepared = f.service.owner.prepareInterpretation(f.owner, { requestId: 'interpret', selection: f.input.selections[0]!, expiresAt: 90000 }), w = f.service.control.bindWork(prepared.authority.id); expect(f.service.work.reserveRead(w, input())).toEqual({ state: 'deny', code: 'outside_scope' });
});
test('claim serialization failure rolls back its reservation and all read charges', () => {
  const f = fixture({ reads: [{ operation: 'read', validate() {} }] }); fixtures.push(f); f.install(); const w = f.admit({ intent: 'inspect' }).actor!; const before = f.service.control.usage(); const result = f.service.work.reserveRead(w, { ...input(), exactPayload: { text: 'a'.repeat(130900) } }); expect(result.state).toBe('deny'); expect(f.service.control.usage()).toEqual(before);
});

test('an explicit owner deny rule fences the declared read path before charge', () => {
  const f = setup(), deny = structuredClone(f.input.rules[0]!); deny.id = 'deny_read'; deny.mode = 'deny'; deny.operations = ['read']; f.input.rules.push(deny); f.install(); const w = f.admit({ intent: 'inspect' }).actor!; expect(f.service.work.reserveRead(w, input())).toEqual({ state: 'deny', code: 'rule_denied' }); expect(f.service.control.usage().charged.reads).toBe(0);
});

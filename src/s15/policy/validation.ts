import { createHash } from 'node:crypto';
import { containsRegisteredSecret } from '../../security/secret-fingerprints';
import type { ActionClass, ActionDraft, BudgetVector, PolicyInput, Ref, Rule, RuleMode, Selection, Usage, WorkRequest } from './types';

/** Safe public refusal code. No raw provider error, payload or credential is included. */
export class PolicyError extends Error { constructor(readonly code: string) { super(code); this.name = 'PolicyError'; } }
export function fail(code: string): never { throw new PolicyError(code); }
export function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_shape');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string') || Object.entries(descriptors).some(([k, d]) => !d.enumerable || !('value' in d) || ![...keys, ...optional].includes(k)) || keys.some(k => !Object.hasOwn(value, k))) fail('invalid_shape');
}
export function nat(value: unknown, positive = false): asserts value is number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < (positive ? 1 : 0)) fail('invalid_number'); }
export function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('invalid_id'); }
export function minor(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(value)) fail('invalid_minor'); }
export function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid_hash'); }
export function string(value: unknown, max = 4096): asserts value is string { if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > max) fail('invalid_string'); }
export function currency(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) fail('invalid_currency'); }
export function ref(value: unknown): asserts value is Ref { exact(value, ['id', 'revision', 'generation']); id(value.id); nat(value.revision, true); nat(value.generation, true); }
export function selection(value: unknown): asserts value is Selection { exact(value, ['route', 'model', 'effort']); ref(value.route); ref(value.model); id(value.effort); }
export const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export const contains = (set: readonly unknown[], item: unknown): boolean => set.some(x => equal(x, item));
function array(value: unknown, visit: (v: unknown) => void, nonempty = false): asserts value is unknown[] { if (!Array.isArray(value) || value.length > 64 || (nonempty && !value.length)) fail('invalid_shape'); canonical(value); value.forEach(visit); if (new Set(value.map(canonical)).size !== value.length) fail('invalid_shape'); }
export function refs(value: unknown): asserts value is Ref[] { array(value, ref); if (new Set(value.map(v => (v as Ref).id)).size !== value.length) fail('invalid_shape'); }
const dims = ['attempts', 'steps', 'calls', 'reads', 'outputBytes', 'activeMs', 'spendMinor'] as const;
export function vector(value: unknown): asserts value is BudgetVector { exact(value, dims); for (const k of dims) k === 'spendMinor' ? minor(value[k]) : nat(value[k]); }
export function usage(value: unknown): asserts value is Usage { exact(value, dims); for (const k of dims) if (value[k] !== null) k === 'spendMinor' ? minor(value[k]) : nat(value[k]); }
export const zero = (): BudgetVector => ({ attempts: 0, steps: 0, calls: 0, reads: 0, outputBytes: 0, activeMs: 0, spendMinor: '0' });
export const unknownUsage = (): Usage => ({ attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null });
export function add(a: BudgetVector, b: BudgetVector): BudgetVector { const result = zero(); for (const k of dims) { if (k === 'spendMinor') result[k] = (BigInt(a[k]) + BigInt(b[k])).toString(); else { result[k] = a[k] + b[k]; nat(result[k]); } } minor(result.spendMinor); return result; }
export function within(value: BudgetVector, ceiling: BudgetVector): boolean { return dims.every(k => k === 'spendMinor' ? BigInt(value[k]) <= BigInt(ceiling[k]) : value[k] <= ceiling[k]); }
/** Bounded exact JSON canonicalization; refuses accessors/exotic values before reading them. No text normalization. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function walk(v: unknown, depth: number): string {
    if (depth > 16) fail('invalid_shape');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') { string(v, 131072); if (containsRegisteredSecret(v) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:Bearer\s+[A-Za-z0-9._~+\/-]{16,})|(?:gh[pousr]_[A-Za-z0-9]{20,})/.test(v)) fail('credential_content_refused'); return JSON.stringify(v); }
    if (typeof v === 'number') { nat(v); return JSON.stringify(v); }
    if (!v || typeof v !== 'object' || seen.has(v)) fail('invalid_shape');
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (v.length > 256 || Reflect.ownKeys(v).length !== v.length + 1) fail('invalid_shape');
      for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, i); if (!d || !d.enumerable || !('value' in d)) fail('invalid_shape'); }
      result = '[' + Array.from(v, x => walk(x, depth + 1)).join(',') + ']';
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype) fail('invalid_shape');
      const keys = Reflect.ownKeys(v); if (keys.length > 256 || keys.some(k => typeof k !== 'string')) fail('invalid_shape');
      result = '{' + (keys as string[]).sort().map(k => { const d = Object.getOwnPropertyDescriptor(v, k)!; if (!d.enumerable || !('value' in d)) fail('invalid_shape'); string(k); return JSON.stringify(k) + ':' + walk(d.value, depth + 1); }).join(',') + '}';
    }
    seen.delete(v); return result;
  }
  const result = walk(value, 0); if (Buffer.byteLength(result) > 131072) fail('input_too_large'); return result;
}
/** Domain-separated exact record identity, never authentication. */
export const digest = (domain: string, value: unknown): string => createHash('sha256').update(domain + '\n' + canonical(value)).digest('hex');
const classes: ActionClass[] = ['ordinary_edit', 'guest_local_admin', 'guest_system_admin', 'new_egress', 'communication', 'financial', 'github_publish', 'github_merge', 'production', 'disclosure', 'major_change'];
const ruleModes: readonly RuleMode[] = ['ordinary', 'communication', 'personal_github_publish', 'personal_github_merge', 'recurring_payment', 'deny', 'owner_named_send', 'github_default'];
export function rule(v: unknown): asserts v is Rule {
  exact(v, ['id', 'mode', 'purposes', 'bots', 'resources', 'recipients', 'selections', 'adapters', 'operations', 'classes', 'expiresAt', 'recurrence'], ['github']); id(v.id);
  if (!ruleModes.includes(v.mode as RuleMode)) fail('invalid_rule');
  refs(v.purposes); refs(v.bots); refs(v.resources); refs(v.recipients); array(v.selections, selection, true); array(v.adapters, id, true); array(v.operations, id, true); array(v.classes, x => { if (!classes.includes(x as ActionClass)) fail('invalid_rule'); }, true); nat(v.expiresAt, true);
  if (!(v.purposes as Ref[]).length || !(v.bots as Ref[]).length) fail('invalid_rule');
  if (v.mode === 'recurring_payment') {
    exact(v.recurrence, ['payee', 'account', 'currency', 'minorUnit', 'amountCeilingMinor', 'minIntervalMs', 'maxPayments', 'totalCeilingMinor', 'startsAt']);
    const r = v.recurrence; ref(r.payee); ref(r.account); currency(r.currency); nat(r.minorUnit); if (r.minorUnit > 6) fail('invalid_rule'); minor(r.amountCeilingMinor); minor(r.totalCeilingMinor); nat(r.minIntervalMs, true); nat(r.maxPayments, true); nat(r.startsAt); if (BigInt(r.amountCeilingMinor) === 0n || BigInt(r.totalCeilingMinor) === 0n || !contains(v.resources as Ref[], r.account) || !contains(v.recipients as Ref[], r.payee)) fail('invalid_rule');
  } else if (v.recurrence !== null) fail('invalid_rule');
  if (v.mode === 'personal_github_publish' || v.mode === 'personal_github_merge') { exact(v.github, ['repository', 'target'], ['requiredChecks', 'requiredApprovals', 'requireCodeOwners']); if (v.github.requiredChecks !== undefined) { array(v.github.requiredChecks, x => { string(x); if (!x) fail('invalid_rule'); }); if (new Set(v.github.requiredChecks as string[]).size !== (v.github.requiredChecks as string[]).length) fail('invalid_rule'); } if (v.github.requiredApprovals !== undefined) nat(v.github.requiredApprovals); if (v.github.requireCodeOwners !== undefined && typeof v.github.requireCodeOwners !== 'boolean') fail('invalid_rule'); ref(v.github.repository); string(v.github.target); if (!v.github.target || !contains(v.resources as Ref[], v.github.repository)) fail('invalid_rule'); } else if (v.github !== undefined && v.github !== null) fail('invalid_rule');
}
export function policy(v: unknown): asserts v is PolicyInput {
  exact(v, ['purposes', 'bots', 'resources', 'recipients', 'selections', 'budget', 'rules', 'expiresAt'], ['interpretationPurpose']); refs(v.purposes); refs(v.bots); refs(v.resources); refs(v.recipients); array(v.selections, selection, true); array(v.rules, rule); if (new Set((v.rules as Rule[]).map(x => x.id)).size !== (v.rules as Rule[]).length) fail('invalid_rule'); nat(v.expiresAt, true);
  if (v.interpretationPurpose !== undefined && v.interpretationPurpose !== null) { ref(v.interpretationPurpose); if (!contains(v.purposes as Ref[], v.interpretationPurpose)) fail('outside_scope'); }
  if (v.budget !== null) { exact(v.budget, ['currency', 'startsAt', 'expiresAt', 'ceiling', 'concurrency']); currency(v.budget.currency); nat(v.budget.startsAt); nat(v.budget.expiresAt, true); vector(v.budget.ceiling); nat(v.budget.concurrency, true); if (v.budget.startsAt >= v.budget.expiresAt) fail('invalid_budget'); }
}
export function workRequest(v: unknown): asserts v is WorkRequest {
  exact(v, ['requestId', 'intent', 'purpose', 'bot', 'resources', 'recipients', 'selection', 'selectionPin', 'expiresAt'], ['subject', 'fences', 'access', 'readLimit', 'named']); id(v.requestId); if (!['inspect', 'execute', 'accept_obligation'].includes(v.intent as string)) fail('invalid_intent'); ref(v.purpose); ref(v.bot); refs(v.resources); refs(v.recipients); selection(v.selection); if (v.selectionPin !== null) selection(v.selectionPin); nat(v.expiresAt, true);
  if (v.readLimit !== undefined) nat(v.readLimit);
  if (v.named !== undefined) { refs(v.named); if (!(v.named as Ref[]).length || (v.named as Ref[]).some(x => !contains(v.recipients as Ref[], x))) fail('invalid_shape'); }
  if (v.access !== undefined && (!['read', 'reversible_write', 'effect'].includes(v.access as string) || (v.intent !== 'execute' && v.access !== 'read'))) fail('invalid_intent');
  if (v.fences !== undefined) fences(v.fences);
  if (v.subject !== undefined && v.subject !== null) { exact(v.subject, ['resource', 'issue']); ref(v.subject.resource); nat(v.subject.issue, true); }
}
export function draft(v: unknown): asserts v is ActionDraft {
  exact(v, ['operation', 'classes', 'resources', 'recipients', 'payload', 'fences', 'upperBound', 'expiresAt', 'transaction', 'github', 'impact'], ['snapshot', 'disclosure']); id(v.operation); array(v.classes, x => { if (!classes.includes(x as ActionClass)) fail('adapter_unproven'); }, true); refs(v.resources); refs(v.recipients); canonical(v.payload); fences(v.fences); if (v.snapshot !== undefined && v.snapshot !== null) fences([v.snapshot]); if (v.upperBound !== null) vector(v.upperBound); nat(v.expiresAt, true); if (!['reversible', 'major', 'unknown'].includes(v.impact as string)) fail('adapter_unproven');
  if (v.disclosure !== undefined) {
    const d = v.disclosure; exact(d, ['recipients', 'purpose', 'sources', 'dataClasses', 'exactBytes']); refs(d.recipients); ref(d.purpose);
    array(d.sources, s => { exact(s, ['ref', 'resource', 'classification']); ref(s.ref); ref(s.resource); if (!['public', 'private', 'personal', 'business'].includes(s.classification as string)) fail('classification_unknown'); });
    array(d.dataClasses, c => { if (!['public', 'private', 'personal', 'business'].includes(c as string)) fail('classification_unknown'); });
    exact(d.exactBytes, ['length', 'sha256']); nat(d.exactBytes.length); hash(d.exactBytes.sha256);
    const bytes = canonical(v.payload);
    if (!equal(d.recipients, v.recipients) || d.exactBytes.length !== Buffer.byteLength(bytes) || d.exactBytes.sha256 !== createHash('sha256').update(bytes).digest('hex')) fail('hash_mismatch');
  }
  const financial = (v.classes as string[]).includes('financial');
  if (financial !== (v.transaction !== null)) fail('adapter_unproven');
  if (v.transaction !== null) { const t = v.transaction; exact(t, ['payee', 'account', 'currency', 'minorUnit', 'amountMinor', 'quoteId', 'quoteVersion', 'quoteExpiresAt']); ref(t.payee); ref(t.account); currency(t.currency); nat(t.minorUnit); if (t.minorUnit > 6) fail('invalid_currency'); minor(t.amountMinor); if (BigInt(t.amountMinor) === 0n) fail('invalid_minor'); id(t.quoteId); string(t.quoteVersion); if (!t.quoteVersion) fail('invalid_quote'); nat(t.quoteExpiresAt, true); if (!contains(v.resources as Ref[], t.account) || !contains(v.recipients as Ref[], t.payee)) fail('adapter_unproven'); }
  const github = (v.classes as string[]).some(x => x === 'github_publish' || x === 'github_merge');
  if (github !== (v.github !== null)) fail('adapter_unproven');
  if (v.github !== null) { const g = v.github; exact(g, ['repository', 'issue', 'target', 'head', 'evidenceHash', 'checksPassed', 'reviewsPassed', 'acceptancePassed', 'production', 'deploymentFence']); ref(g.repository); nat(g.issue, true); string(g.target); if (!/^[a-f0-9]{40}$/.test(g.head as string)) fail('invalid_hash'); hash(g.evidenceHash); if ([g.checksPassed, g.reviewsPassed, g.acceptancePassed].some(x => typeof x !== 'boolean') || !['none', 'protected_gate', 'would_deploy', 'unknown'].includes(g.production as string)) fail('adapter_unproven'); if (g.deploymentFence !== null) { exact(g.deploymentFence, ['kind', 'ref']); if (g.deploymentFence.kind !== 'resource') fail('adapter_unproven'); ref(g.deploymentFence.ref); } if (!contains(v.resources as Ref[], g.repository)) fail('adapter_unproven'); }
  if (v.impact === 'major' && !(v.classes as string[]).includes('major_change')) fail('adapter_unproven');
}

export function fences(v: unknown): void { array(v, x => { exact(x, ['kind', 'ref']); if (!['purpose', 'bot', 'resource', 'recipient', 'route', 'model', 'lineage', 'vm', 'input'].includes(x.kind as string)) fail('invalid_shape'); ref(x.ref); }); }

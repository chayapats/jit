import { canonical, digest, fail, id, nat } from './validation';
import type { ActionRef, OwnerActor, Rule, S15PolicyService, StandingPolicy } from './types';

/** One frequency the protected payment adapter supports, as a minimum interval between claims. Never inferred. */
export interface RecurringFrequency { id: string; minIntervalMs: number }
/** Exact recurring-payment rule derived from one owner-visible payment slip. The hash binds every rule byte. */
export interface RecurringRuleProposal { contract: 's15-recurring-rule-proposal/v1'; source: ActionRef; expectedRevision: number; ownerGeneration: number; rule: Rule; proposalHash: string }
/** Protected configuration: adapter-supported frequencies and finite count/lifetime bounds. No amount is defaulted. */
export interface RecurringRuleOptions { frequencies: readonly RecurringFrequency[]; maxPayments: number; ruleLifetimeMs: number; now?: () => number }
/** Owner-only F13 seam over POLICY: propose from an exact payment, install the exact proposal, revoke by narrowing. */
export interface RecurringRules {
  frequencies(): RecurringFrequency[];
  propose(owner: OwnerActor, input: { action: ActionRef; amountCeilingMinor: string; frequencyId: string }): RecurringRuleProposal;
  install(owner: OwnerActor, requestId: string, proposalHash: string): StandingPolicy;
  revoke(owner: OwnerActor, requestId: string, ruleId: string): StandingPolicy;
}

/**
 * Derives a recurring-payment rule only from protected data: the exact payment action (payee, account, currency,
 * precision, adapter, operation, resources and recipients) and its live work authority (purpose, Bot, model
 * selection). The owner supplies only the amount ceiling and picks a configured frequency. The rule never
 * covers any class other than `financial`; installation still goes through POLICY's separate recurring
 * approval command, and revocation installs the current policy without that rule, which only narrows.
 */
export function createRecurringRules(host: S15PolicyService, options: RecurringRuleOptions): RecurringRules {
  nat(options.maxPayments, true); nat(options.ruleLifetimeMs, true);
  const frequencies = options.frequencies.map(f => { id(f.id); nat(f.minIntervalMs, true); return { id: f.id, minIntervalMs: f.minIntervalMs }; });
  if (new Set(frequencies.map(f => f.id)).size !== frequencies.length) fail('invalid_rule');
  const now = () => (options.now ?? Date.now)();
  const proposals = new Map<string, RecurringRuleProposal>();
  return {
    frequencies: () => frequencies.map(f => ({ ...f })),
    propose(owner, input) {
      const policy = host.owner.current(owner); if (!policy) fail('policy_match_required');
      const frequency = frequencies.find(f => f.id === input.frequencyId); if (!frequency) fail('frequency_unsupported');
      if (typeof input.amountCeilingMinor !== 'string' || !/^[1-9][0-9]{0,29}$/.test(input.amountCeilingMinor)) fail('invalid_amount');
      const slip = host.owner.actionSlip(owner, input.action), a = slip.action, t = a.transaction;
      if (!t || !a.classes.includes('financial') || a.classes.some(c => c !== 'financial')) fail('recurring_scope_unsupported');
      if (!['pending', 'approved', 'executing', 'succeeded'].includes(slip.state)) fail('stale_action');
      const work = host.work.guard(host.control.bindWork(a.workId)), at = now();
      const total = (BigInt(input.amountCeilingMinor) * BigInt(options.maxPayments)).toString();
      const rule: Rule = {
        id: `recurring_${digest('s15.policy.recurring.rule.v1', { payee: t.payee.id, account: t.account.id, currency: t.currency }).slice(0, 32)}`, mode: 'recurring_payment',
        purposes: [work.request.purpose], bots: [work.request.bot], resources: a.resources.map(r => ({ ...r })), recipients: a.recipients.map(r => ({ ...r })), selections: [work.request.selection],
        adapters: [a.adapter], operations: [a.operation], classes: ['financial'], expiresAt: Math.min(policy.expiresAt, at + options.ruleLifetimeMs),
        recurrence: { payee: { ...t.payee }, account: { ...t.account }, currency: t.currency, minorUnit: t.minorUnit, amountCeilingMinor: input.amountCeilingMinor, minIntervalMs: frequency.minIntervalMs, maxPayments: options.maxPayments, totalCeilingMinor: total, startsAt: at },
      };
      const body = { contract: 's15-recurring-rule-proposal/v1' as const, source: { id: a.id, revision: a.revision, actionHash: a.actionHash }, expectedRevision: policy.revision, ownerGeneration: policy.ownerGeneration, rule };
      const proposal: RecurringRuleProposal = { ...body, proposalHash: digest('s15.policy.recurring.proposal.v1', body) };
      proposals.set(proposal.proposalHash, JSON.parse(canonical(proposal)) as RecurringRuleProposal);
      if (proposals.size > 32) proposals.delete(proposals.keys().next().value!);
      return proposal;
    },
    install(owner, requestId, proposalHash) {
      const proposal = proposals.get(proposalHash); if (!proposal) fail('proposal_incomplete');
      const policy = host.owner.current(owner);
      if (!policy || policy.revision !== proposal.expectedRevision || policy.ownerGeneration !== proposal.ownerGeneration) fail('stale_policy');
      const installed = host.owner.approveRecurringRule(owner, requestId, proposal.expectedRevision, proposal.rule);
      proposals.delete(proposalHash);
      return installed;
    },
    revoke(owner, requestId, ruleId) {
      id(ruleId); const policy = host.owner.current(owner); if (!policy) fail('policy_match_required');
      if (!policy.rules.some(r => r.id === ruleId && r.mode === 'recurring_payment')) fail('authority_revoked');
      const { contract: _contract, revision, ownerGeneration: _generation, ...input } = policy;
      return host.owner.install(owner, requestId, revision, { ...input, rules: input.rules.filter(r => r.id !== ruleId) });
    },
  };
}

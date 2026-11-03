import { randomUUID } from 'node:crypto';
import { PolicyLedger } from './ledger';
import * as v from './validation';
import type * as T from './types';

type Claim = { action: T.ActionRef; reservationId: string; decision: Extract<T.Decision, { state: 'allow' }>; createdAt: number; recurring: { rule: T.Rule; deviations: string[] }[] };
const uid = () => randomUUID().replaceAll('-', '');
const clone = <T>(x: T): T => JSON.parse(v.canonical(x)) as T;
const actionRef = (a: T.PreparedAction): T.ActionRef => ({ id: a.id, revision: a.revision, actionHash: a.actionHash });
const parse = <T>(row: { json: string } | null): T | null => row ? JSON.parse(row.json) as T : null;
const paymentKey = (a: T.PreparedAction): string | null => a.transaction ? v.digest('s15.payment.intent.v1', { quote: a.transaction.quoteId }) : null;

/** Opens only an explicitly opted-in, protected S15 ledger. S14/legacy stores and runtime selection are untouched.
 * The caller retains owner/control ports outside agent/VM reach and injects verified catalogs and finite adapters.
 * All authority mutations/charges/claims use one synchronous SQLite writer transaction; no transaction spans an await.
 */
export function openPolicyService(options: T.PolicyOptions): T.S15PolicyService {
  if (options.runtime !== 's15') v.fail('s15_opt_in_required');
  v.id(options.installationId); v.nat(options.ownerGeneration(), true);
  const now = options.now ?? Date.now;
  const subscription = options.subscriptionModels;
  if (subscription) {
    v.exact(subscription, ['current', 'concurrency', 'perWork'], ['tools']); if (typeof subscription.current !== 'function') v.fail('invalid_shape'); v.nat(subscription.concurrency, true); v.exact(subscription.perWork, ['calls', 'steps', 'activeMs']); for (const value of Object.values(subscription.perWork)) v.nat(value, true);
    if (subscription.tools !== undefined) { v.exact(subscription.tools, ['attempts', 'steps', 'calls', 'reads', 'outputBytes', 'activeMs']); for (const value of Object.values(subscription.tools)) v.nat(value); }
  }
  const subscriptionBounds = subscription ? clone({ concurrency: subscription.concurrency, perWork: subscription.perWork, ...(subscription.tools ? { tools: subscription.tools } : {}) }) : null;
  /** POLICY15-02: the per-work read ceiling. A monetary budget supplies it; otherwise only the zero-spend tool bound does. */
  const readCeiling = (p: T.StandingPolicy): number => p.budget ? p.budget.ceiling.reads : subscriptionBounds?.tools?.reads ?? 0;
  const ledger = new PolicyLedger(options.path, options.create, options.installationId);
  try {
    if (options.initialReservations) {
      const initial = options.initialReservations;
      v.exact(initial, ['sourceHash', 'usage']); v.hash(initial.sourceHash);
      v.exact(initial.usage, ['attempts', 'steps', 'calls', 'reads', 'outputBytes']); Object.values(initial.usage).forEach(x => v.nat(x));
      const initialHash = v.digest('s15.inherited.reservations.v1', initial);
      ledger.tx(() => {
        const previous = ledger.meta<string>('initialReservations');
        if (previous !== null) { if (previous !== initialHash) v.fail('continuity_unavailable'); return; }
        if (!options.create || ledger.meta('policy') !== null) v.fail('continuity_unavailable');
        const charged = ledger.meta<T.BudgetVector>('charged')!;
        ledger.put('charged', { ...charged, ...initial.usage }); ledger.put('initialReservations', initialHash);
      });
    }
  } catch (error) { ledger.db.close(); throw error; }
  const owners = new WeakMap<T.OwnerActor, { proof: unknown; id: string; generation: number }>();
  const workers = new WeakMap<T.WorkActor, string>();
  const readHandlers = new Map((options.reads ?? []).map(h => { if (!['read', 'grep', 'find', 'ls', 'workspace_setup'].includes(h.operation)) v.fail('read_operation_unavailable'); return [h.operation, h] as const; }));
  if (readHandlers.size !== (options.reads ?? []).length) { ledger.db.close(); v.fail('read_operation_unavailable'); }
  const adapters = new Map(options.adapters.map(a => { v.id(a.id); v.nat(a.version, true); return [a.id, a] as const; }));
  if (adapters.size !== options.adapters.length) { ledger.db.close(); v.fail('adapter_unproven'); }
  let closed = false;
  const activeDispatches = new Set<string>();
  const modelInvocations = new Map<string, T.WorkActor>();
  const tx = <R>(fn: () => R): R => { if (closed) v.fail('service_closed'); return ledger.tx(fn); };
  const time = (): number => { const t = now(); v.nat(t); return t; };
  const getPolicy = (): T.StandingPolicy | null => ledger.meta('policy');
  function ownerAuth(actor: T.OwnerActor): T.AuthenticatedOwner {
    const registered = actor && owners.get(actor);
    if (!registered) v.fail('authentication_required');
    const principal = options.verifyOwner(registered.proof);
    if (!principal || principal.id !== registered.id || principal.generation !== registered.generation || principal.generation !== options.ownerGeneration() || principal.expiresAt <= time() || (ledger.meta<string>('ownerId') !== null && ledger.meta<string>('ownerId') !== principal.id)) v.fail('authentication_required');
    v.id(principal.id); v.nat(principal.generation, true); v.nat(principal.expiresAt, true); return principal;
  }
  function currentRef(kind: T.CatalogKind, r: T.Ref): void {
    const current = options.catalogs.current(kind, r.id);
    if (!current || !current.active) v.fail('authority_revoked');
    if (!v.equal(current.ref, r)) v.fail('stale_authority');
  }
  function usablePolicy(): T.StandingPolicy {
    const p = getPolicy(); if (!p) v.fail('policy_required');
    if (ledger.meta('policyRevoked') || p.ownerGeneration !== options.ownerGeneration()) v.fail('authority_revoked');
    if (time() >= p.expiresAt) v.fail('expired');
    return p;
  }
  function policyCurrent(): T.StandingPolicy {
    options.activityGuard?.();
    return usablePolicy();
  }
  function checkRequest(p: T.StandingPolicy, r: T.WorkRequest): void {
    if (!v.contains(p.purposes, r.purpose) || !v.contains(p.bots, r.bot) || !v.contains(p.selections, r.selection) || r.resources.some(x => !v.contains(p.resources, x)) || r.recipients.some(x => !v.contains(p.recipients, x)) || (r.subject && !v.contains(r.resources, r.subject.resource))) v.fail('outside_scope');
    currentRef('purpose', r.purpose); currentRef('bot', r.bot); currentRef('route', r.selection.route); currentRef('model', r.selection.model);
    r.resources.forEach(x => currentRef('resource', x)); r.recipients.forEach(x => currentRef('recipient', x)); r.fences?.forEach(x => currentRef(x.kind, x.ref));
    if (r.readLimit !== undefined && r.readLimit > readCeiling(p)) v.fail('outside_scope');
    if (r.selectionPin && !v.equal(r.selectionPin, r.selection)) v.fail('selection_pinned');
  }
  function currentWork(workId: string): T.WorkAuthority {
    const row = ledger.get<{ json: string; revoked: number }>('SELECT json,revoked FROM works WHERE id=?', workId);
    if (!row || row.revoked) v.fail('authority_revoked');
    const w = JSON.parse(row.json) as T.WorkAuthority; const p = policyCurrent();
    if (w.ownerGeneration !== options.ownerGeneration()) v.fail('authority_revoked');
    if (w.policyRevision !== p.revision || w.policyHash !== v.digest('s15.policy.v1', p)) v.fail('stale_authority');
    if (time() >= w.expiresAt) v.fail('expired');
    checkRequest(p, w.request);
    if (!options.catalogs.allows(clone(w), null)) v.fail('outside_scope');
    return w;
  }
  function workAuth(actor: T.WorkActor): T.WorkAuthority {
    const workId = actor && workers.get(actor); if (!workId) v.fail('authentication_required'); return currentWork(workId);
  }
  function receipt<R>(actor: T.OwnerActor, requestId: string, command: unknown, operation: () => R): R {
    const principal = ownerAuth(actor); v.id(requestId);
    options.requestGuard?.(requestId);
    const hash = v.digest('s15.command.v1', command);
    const previous = ledger.get<{ hash: string; json: string }>('SELECT hash,json FROM receipts WHERE id=?', requestId);
    if (previous) { if (previous.hash !== hash) v.fail('request_id_conflict'); return JSON.parse(previous.json) as R; }
    if (ledger.meta<string>('ownerId') === null) ledger.put('ownerId', principal.id);
    const result = operation();
    ledger.run('INSERT INTO receipts VALUES (?,?,?)', requestId, hash, v.canonical(result)); return result;
  }
  function loadAction(ref: T.ActionRef, historical = false): T.PreparedAction {
    v.exact(ref, ['id', 'revision', 'actionHash']); v.id(ref.id); v.nat(ref.revision, true); v.hash(ref.actionHash);
    const a = parse<T.PreparedAction>(ledger.get('SELECT json FROM actions WHERE id=? AND revision=?', ref.id, ref.revision));
    if (!a) v.fail('action_not_found');
    const { actionHash, ...body } = a;
    if (actionHash !== ref.actionHash || v.digest('s15.action.v1', body) !== actionHash || v.digest('s15.content.v1', a.payload) !== a.contentHash || v.digest('s15.recipients.v1', a.recipients) !== a.recipientHash || (a.transaction ? v.digest('s15.transaction.v1', a.transaction) : null) !== a.transactionHash) v.fail('hash_mismatch');
    const slot = ledger.get<{ revision: number }>('SELECT revision FROM slots WHERE effect_key=?', a.effectKey);
    if (!slot || (!historical && slot.revision !== a.revision)) v.fail('stale_action'); return a;
  }
  function claimed(a: T.PreparedAction): boolean {
    const key = paymentKey(a);
    return !!ledger.get('SELECT effect_key FROM claims WHERE effect_key=? OR (payment_key IS NOT NULL AND payment_key=?)', a.effectKey, key ?? '');
  }
  function checkAction(w: T.WorkAuthority, a: T.PreparedAction): void {
    if (w.id !== a.workId || a.policyRevision !== w.policyRevision || a.policyHash !== w.policyHash || a.ownerGeneration !== w.ownerGeneration) v.fail('stale_authority');
    if (w.request.intent !== 'execute' || w.request.access === 'read') v.fail('outside_scope');
    if (w.request.access === 'reversible_write' && (a.impact !== 'reversible' || a.classes.some(c => !['ordinary_edit', 'guest_local_admin', 'guest_system_admin'].includes(c)))) v.fail('outside_scope');
    if (time() >= a.expiresAt || (a.transaction && time() >= a.transaction.quoteExpiresAt)) v.fail('expired');
    const adapter = adapters.get(a.adapter); if (!adapter || adapter.version !== a.adapterVersion) v.fail('adapter_unproven');
    if (a.resources.some(x => !v.contains(w.request.resources, x)) || (a.recipients.some(x => !v.contains(w.request.recipients, x)) && !a.classes.some(c => c === 'new_egress' || c === 'disclosure'))) v.fail('outside_scope');
    a.resources.forEach(x => currentRef('resource', x)); a.recipients.forEach(x => currentRef('recipient', x)); a.fences.forEach(x => currentRef(x.kind, x.ref));
    if (!options.catalogs.allows(clone(w), clone(a))) v.fail('outside_scope');
  }
  const unsettled = (): number => ledger.all<{ json: string }>('SELECT json FROM reservations').filter(r => !(JSON.parse(r.json) as T.Reservation).transportSettled).length;
  const ordinaryUnsettled = (): number => ledger.all<{ json: string }>('SELECT r.json FROM reservations r WHERE NOT EXISTS (SELECT 1 FROM recovery_reads recovery WHERE recovery.reservation_id=r.id)').filter(r => !(JSON.parse(r.json) as T.Reservation).transportSettled).length;
  // Per-work sums of one reservation family: model reservations carry their selection, tool/read/effect ones do not.
  const workUsed = (workId: string, models: boolean): T.BudgetVector => ledger.all<{ json: string }>(`SELECT json FROM reservations WHERE json_extract(json,'$.workId')=? AND json_extract(json,'$.selection') IS ${models ? 'NOT ' : ''}NULL`, workId).reduce((total, row) => v.add(total, (JSON.parse(row.json) as T.Reservation).upperBound), v.zero());
  function budgetCheck(bound: T.BudgetVector | null, continuation: boolean, recovery = false, model?: { workId: string; selection: T.Selection }, work?: T.WorkAuthority): void {
    const budget = policyCurrent().budget;
    if (!budget && !model) {
      // POLICY15-02 (ADR 0073): with no monetary budget, a zero-spend tool/read/effect charge of a work whose own
      // selection is a current subscription route uses the registry's finite per-work tool bounds. It never spends money.
      const tools = subscriptionBounds?.tools;
      if (!tools || !subscription || !work || !subscription.current(clone(work.request.selection))) v.fail('finite_budget_required');
      if (!bound || bound.spendMinor !== '0') v.fail('cost_unknown');
      const used = workUsed(work.id, false), next = continuation ? used : v.add(used, bound);
      if (ledger.meta('budgetOverrun') || (['attempts', 'steps', 'calls', 'reads', 'outputBytes', 'activeMs'] as const).some(k => next[k] > tools[k])) v.fail('budget_exhausted');
      if (!continuation && !recovery && ordinaryUnsettled() >= subscriptionBounds!.concurrency) v.fail('capacity_busy');
      if (!continuation && recovery && ledger.get('SELECT reservation_id FROM recovery_reads WHERE active=1')) v.fail('recovery_busy');
      return;
    }
    if (!budget) {
      if (!model || !subscription || !subscriptionBounds || !subscription.current(clone(model.selection))) v.fail('finite_budget_required');
      if (!bound || bound.spendMinor !== '0' || bound.calls < 1 || bound.steps < 1 || bound.activeMs < 1 || bound.reads !== 0) v.fail('cost_unknown');
      const used = workUsed(model.workId, true);
      const next = continuation ? used : v.add(used, bound);
      if (ledger.meta('budgetOverrun') || next.calls > subscriptionBounds.perWork.calls || next.steps > subscriptionBounds.perWork.steps || next.activeMs > subscriptionBounds.perWork.activeMs) v.fail('budget_exhausted');
      if (!continuation && ordinaryUnsettled() >= subscriptionBounds.concurrency) v.fail('capacity_busy');
      return;
    }
    if (!bound) v.fail('cost_unknown');
    if (time() < budget.startsAt || time() >= budget.expiresAt) v.fail('expired');
    const charged = ledger.meta<T.BudgetVector>('charged'); if (!charged) v.fail('continuity_unavailable');
    if (ledger.meta('budgetOverrun') || !v.within(charged, budget.ceiling) || (!continuation && !v.within(v.add(charged, bound), budget.ceiling))) v.fail('budget_exhausted');
    if (!continuation && !recovery && ordinaryUnsettled() >= budget.concurrency) v.fail('capacity_busy');
    if (!continuation && recovery && ledger.get('SELECT reservation_id FROM recovery_reads WHERE active=1')) v.fail('recovery_busy');
  }
  function matching(r: T.Rule, w: T.WorkAuthority, a: T.PreparedAction): boolean {
    return time() < r.expiresAt && v.contains(r.purposes, w.request.purpose) && v.contains(r.bots, w.request.bot) && v.contains(r.selections, w.request.selection) && r.adapters.includes(a.adapter) && r.operations.includes(a.operation) && a.classes.every(x => r.classes.includes(x)) && a.resources.every(x => v.contains(r.resources, x)) && (a.recipients.every(x => v.contains(r.recipients, x)) || a.classes.some(c => c === 'new_egress' || c === 'disclosure')) && (!r.mode.startsWith('personal_github') || (!!r.github && !!a.github && v.equal(r.github.repository, a.github.repository) && r.github.target === a.github.target));
  }
  function recurringMatch(r: T.Rule, a: T.PreparedAction, continuation: boolean, identityOnly = false): boolean {
    const t = a.transaction, f = r.recurrence;
    if (!t || !f || !v.equal(t.account, f.account) || !v.equal(t.payee, f.payee) || t.currency !== f.currency || t.minorUnit !== f.minorUnit || BigInt(t.amountMinor) > BigInt(f.amountCeilingMinor) || time() < f.startsAt) return false;
    if (identityOnly) return true;
    const used = ledger.get<{ count: number; amount_minor: string; last_at: number }>('SELECT * FROM recurring_usage WHERE id=?', r.id);
    if (continuation) return !!used; // This exact claim already charged frequency and total under the writer lock.
    return (!used || (time() - used.last_at >= f.minIntervalMs && used.count < f.maxPayments)) && BigInt(used?.amount_minor ?? '0') + BigInt(t.amountMinor) <= BigInt(f.totalCeilingMinor);
  }
  function evaluate(w: T.WorkAuthority, a: T.PreparedAction, continuation = false): T.Decision {
    try {
      checkAction(w, a); if (!continuation && claimed(a)) v.fail('already_claimed');
      const approvals = ledger.all<{ json: string }>('SELECT json FROM approvals WHERE action_id=? AND revision=? ORDER BY rowid', a.id, a.revision).map(r => JSON.parse(r.json) as T.ApprovalInput & { id: string; ownerGeneration: number; policyHash: string });
      if (approvals.some(x => x.decision === 'deny')) v.fail('action_denied');
      const rules = policyCurrent().rules.filter(r => matching(r, w, a));
      if (rules.some(r => r.mode === 'deny')) v.fail('rule_denied');
      budgetCheck(a.upperBound, continuation, false, undefined, w);
      if (!rules.length) return { state: 'hold', code: 'policy_match_required' };
      if (a.impact === 'unknown') return { state: 'hold', code: 'owner_direction_required' };
      if (a.github?.production === 'unknown') return { state: 'hold', code: 'production_impact_required' };
      if (a.classes.includes('github_merge') && a.github && (!a.github.checksPassed || !a.github.reviewsPassed || !a.github.acceptancePassed)) return { state: 'hold', code: 'github_evidence_required' };
      const approved = approvals.findLast(x => x.decision === 'approve' && x.action.actionHash === a.actionHash && x.ownerGeneration === options.ownerGeneration() && x.policyHash === a.policyHash && time() < x.expiresAt);
      const selected = new Set<string>();
      for (const c of a.classes) {
        if (c === 'ordinary_edit' || c === 'guest_local_admin') { if (!rules.some(r => r.mode === 'ordinary')) return { state: 'hold', code: 'policy_match_required' }; continue; }
        if (c === 'guest_system_admin') {
          if (!a.snapshot || !a.fences.some(f => v.equal(f, a.snapshot)) || a.snapshot.kind !== 'lineage') return { state: 'hold', code: 'snapshot_required' };
          currentRef(a.snapshot.kind, a.snapshot.ref); if (!rules.some(r => r.mode === 'ordinary')) return { state: 'hold', code: 'policy_match_required' }; continue;
        }
        if (approved) continue;
        let candidates: T.Rule[] = [];
        if (c === 'communication') candidates = rules.filter(r => r.mode === 'communication' || (r.mode === 'personal_github_publish' && a.classes.includes('github_publish')));
        if (c === 'financial') { candidates = rules.filter(r => r.mode === 'recurring_payment' && recurringMatch(r, a, continuation, true)); if (candidates.length === 1 && !recurringMatch(candidates[0]!, a, continuation)) candidates = []; }
        if (c === 'github_publish' || c === 'github_merge') candidates = rules.filter(r => r.mode === (c === 'github_publish' ? 'personal_github_publish' : 'personal_github_merge'));
        if (c === 'github_publish' || c === 'github_merge' || (c === 'communication' && candidates.some(r => r.mode === 'personal_github_publish'))) {
          const g = a.github, subject = w.request.subject;
          if (!g || !subject || !v.equal(subject.resource, g.repository) || subject.issue !== g.issue || !g.checksPassed || !g.reviewsPassed || !g.acceptancePassed) candidates = [];
          if (g && g.production !== 'none') {
            if (g.production !== 'protected_gate' || !g.deploymentFence || !a.fences.some(f => v.equal(f, g.deploymentFence))) return { state: 'hold', code: 'production_approval_required' };
            currentRef(g.deploymentFence.kind, g.deploymentFence.ref);
          }
        }
        if (candidates.length !== 1) return { state: 'hold', code: candidates.length > 1 ? 'ambiguous_rule' : c === 'github_merge' ? 'merge_authority_required' : c === 'production' ? 'production_approval_required' : c === 'new_egress' ? 'egress_approval_required' : 'approval_required' };
        selected.add(candidates[0]!.id);
      }
      // A production consequence is a gate even if an adapter omitted the production class.
      if (a.github && a.github.production !== 'none' && a.github.production !== 'protected_gate' && !approved) return { state: 'hold', code: 'production_approval_required' };
      return { state: 'allow', rules: [...selected].sort(), approval: approved?.id ?? null };
    } catch (error) {
      if (!(error instanceof v.PolicyError)) throw error;
      const code = error.code;
      return { state: code === 'adapter_unproven' ? 'unsupported' : ['finite_budget_required', 'cost_unknown', 'capacity_busy'].includes(code) ? 'hold' : 'deny', code };
    }
  }
  function requireAllowed(decision: T.Decision): asserts decision is Extract<T.Decision, { state: 'allow' }> { if (decision.state !== 'allow') v.fail(decision.code); }
  function reserve(w: T.WorkAuthority, requestId: string, bound: T.BudgetVector, payload: unknown, recovery = false, modelSelection?: T.Selection): T.Reservation {
    const key = w.id + ':' + requestId, hash = v.digest('s15.reservation.v1', payload);
    const old = ledger.get<{ hash: string; json: string }>('SELECT hash,json FROM reservations WHERE dedupe=?', key);
    if (old) { if (old.hash !== hash) v.fail('request_id_conflict'); v.fail('reservation_already_claimed'); }
    budgetCheck(bound, false, recovery, modelSelection ? { workId: w.id, selection: modelSelection } : undefined, w);
    const result: T.Reservation = { id: uid(), workId: w.id, requestId, upperBound: clone(bound), actual: v.unknownUsage(), transportSettled: false, createdAt: time() };
    ledger.put('charged', v.add(ledger.meta<T.BudgetVector>('charged')!, bound));
    ledger.run('INSERT INTO reservations VALUES (?,?,?,?)', result.id, key, hash, v.canonical(result)); return result;
  }
  function mergeUsage(previous: T.Usage, next: T.Usage): T.Usage {
    const merged = clone(previous);
    for (const k of Object.keys(merged) as (keyof T.Usage)[]) {
      const value = next[k];
      if (value !== null && (merged[k] === null || BigInt(value) > BigInt(merged[k]!))) {
        if (k === 'spendMinor') merged[k] = value as string;
        else merged[k] = value as number;
      }
    }
    return merged;
  }
  function settleReservation(id: string, actual: T.Usage, settled: boolean, merge = false): void {
    v.id(id); v.usage(actual); if (typeof settled !== 'boolean') v.fail('invalid_shape');
    const r = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', id)); if (!r) v.fail('reservation_not_found');
    if (merge) { actual = mergeUsage(r.actual, actual); settled ||= r.transportSettled; }
    if (r.transportSettled && !settled) v.fail('settlement_conflict');
    // Keep measured facts monotonic and reject contradictory terminal settlement.
    if (!merge && r.transportSettled && !v.equal(r.actual, actual)) v.fail('settlement_conflict');
    for (const k of Object.keys(r.upperBound) as (keyof T.BudgetVector)[]) {
      const a = actual[k]; if (a !== null && BigInt(a) > BigInt(r.upperBound[k])) ledger.put('budgetOverrun', true);
      if (r.actual[k] !== null && (a === null || BigInt(a) < BigInt(r.actual[k]!))) v.fail('settlement_conflict');
    }
    r.actual = clone(actual); r.transportSettled = settled;
    ledger.run('UPDATE reservations SET json=? WHERE id=?', v.canonical(r), id);
    if (settled) ledger.run('UPDATE recovery_reads SET active=0 WHERE reservation_id=?', id);
  }
  function observe(a: T.PreparedAction, claim: Claim, observation: T.Observation): T.Observation {
    // Every caller rechecks under the writer lock. Late unknown results cannot erase conclusive evidence.
    const latest = observationFor(a);
    if (latest && latest.outcome !== 'unknown') return clone(latest);
    settleReservation(claim.reservationId, observation.actual, observation.transportSettled, true);
    const reservation = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', claim.reservationId))!;
    const merged = { ...clone(observation), actual: reservation.actual, transportSettled: reservation.transportSettled };
    if (!latest || !v.equal(latest, merged)) ledger.run('INSERT INTO observations(action_id,json) VALUES (?,?)', a.id, v.canonical(merged));
    return clone(merged);
  }
  function observationFor(a: T.PreparedAction): T.Observation | null {
    return parse<T.Observation>(ledger.get("SELECT json FROM observations WHERE action_id=? AND json_extract(json,'$.basis')!='owner_statement' ORDER BY seq DESC LIMIT 1", a.id)) ?? (claimed(a) ? { outcome: 'unknown', basis: 'uncertain', code: 'reconciliation_required', actual: v.unknownUsage(), transportSettled: false } : null);
  }
  // Dispatch/recovery are control paths. Private bodies remain only in guarded evidence projections.
  function controlObservation(observation: T.Observation): T.Observation { const { evidence: _, ...facts } = observation; return clone(facts); }
  function checkResult(result: T.AdapterResult): void { v.exact(result, ['outcome', 'actual', 'transportSettled'], ['evidence']); if (!['succeeded', 'failed', 'unknown'].includes(result.outcome) || typeof result.transportSettled !== 'boolean' || (result.outcome !== 'unknown' && !result.transportSettled)) v.fail('invalid_adapter_result'); v.usage(result.actual); if (result.evidence !== undefined) v.canonical(result.evidence); }
  function savePolicy(input: T.PolicyInput, expectedRevision: number, allowRecurring = false): T.StandingPolicy {
    v.policy(input); v.nat(expectedRevision);
    const old = getPolicy(); if ((old?.revision ?? 0) !== expectedRevision) v.fail('stale_policy');
    if (!allowRecurring && input.rules.some(r => r.mode === 'recurring_payment' && !old?.rules.some(x => v.equal(x, r)))) v.fail('recurring_approval_required');
    if (input.budget) { const currency = ledger.meta<string>('budgetCurrency'); if (currency !== null && currency !== input.budget.currency) v.fail('budget_currency_changed'); ledger.put('budgetCurrency', input.budget.currency); }
    const p: T.StandingPolicy = { ...clone(input), contract: 's15-standing-policy/v1', revision: expectedRevision + 1, ownerGeneration: options.ownerGeneration() };
    v.nat(p.revision, true); if (p.expiresAt <= time()) v.fail('expired');
    for (const r of p.rules) { if (!r.purposes.every(x => v.contains(p.purposes, x)) || !r.bots.every(x => v.contains(p.bots, x)) || !r.resources.every(x => v.contains(p.resources, x)) || !r.recipients.every(x => v.contains(p.recipients, x)) || !r.selections.every(x => v.contains(p.selections, x))) v.fail('outside_scope'); }
    ledger.run('INSERT INTO policies VALUES (?,?)', p.revision, v.canonical(p)); ledger.put('policy', p); ledger.put('policyRevoked', false); return p;
  }
  function readableAction(a: T.PreparedAction): void {
    const w = parse<T.WorkAuthority>(ledger.get('SELECT json FROM works WHERE id=?', a.workId));
    if (!w || !options.catalogs.allows(clone(w), clone(a))) v.fail('payload_withdrawn');
    for (const f of a.fences.filter(f => f.kind === 'lineage')) {
      const current = options.catalogs.current(f.kind, f.ref.id); if (!current?.active || !v.equal(current.ref, f.ref)) v.fail('lineage_withdrawn');
    }
  }
  function recurringProjection(a: T.PreparedAction, w: T.WorkAuthority, rules: T.Rule[]): { rule: T.Rule; deviations: string[] }[] {
    return rules.filter(r => r.mode === 'recurring_payment' && a.transaction && r.adapters.includes(a.adapter) && r.operations.includes(a.operation) && v.contains(r.purposes, w.request.purpose)).map(rule => {
      const t = a.transaction!, r = rule.recurrence!, deviations: string[] = [];
      if (!v.equal(t.payee, r.payee)) deviations.push('payee'); if (!v.equal(t.account, r.account)) deviations.push('account'); if (t.currency !== r.currency || t.minorUnit !== r.minorUnit) deviations.push('currency'); if (BigInt(t.amountMinor) > BigInt(r.amountCeilingMinor)) deviations.push('amount_ceiling');
      const used = ledger.get<{ count: number; amount_minor: string; last_at: number }>('SELECT * FROM recurring_usage WHERE id=?', rule.id);
      if (time() < r.startsAt || (used && time() - used.last_at < r.minIntervalMs)) deviations.push('frequency'); if (used && used.count >= r.maxPayments) deviations.push('count'); if (BigInt(used?.amount_minor ?? '0') + BigInt(t.amountMinor) > BigInt(r.totalCeilingMinor)) deviations.push('total'); if (time() >= rule.expiresAt) deviations.push('rule_expired');
      return { rule: clone(rule), deviations };
    });
  }
  function slip(ref: T.ActionRef): T.ActionSlip {
    const a = loadAction(ref, true); readableAction(a);
    const currentSlot = ledger.get<{ revision: number }>('SELECT revision FROM slots WHERE effect_key=?', a.effectKey)!;
    const currentAction = parse<T.PreparedAction>(ledger.get('SELECT json FROM actions WHERE id=? AND revision=?', a.id, currentSlot.revision))!;
    const changed = currentSlot.revision !== a.revision;
    const observed = changed ? null : observationFor(a);
    let decision: T.Decision;
    try { decision = evaluate(currentWork(a.workId), a); } catch (error) { if (!(error instanceof v.PolicyError)) throw error; decision = { state: 'deny', code: error.code }; }
    const reason = decision.state === 'allow' ? null : decision.code;
    let state: T.ActionSlip['state'];
    if (changed) state = 'changed';
    else if (activeDispatches.has(a.id)) state = 'executing';
    else if (observed) state = observed.outcome === 'not_dispatched' ? observed.code === 'expired' ? 'expired' : 'failed' : observed.outcome;
    else if (decision.state === 'unsupported') state = 'unsupported';
    else if (reason === 'expired') state = 'expired';
    else if (reason === 'stale_authority') state = 'stale_rules';
    else state = decision.state === 'deny' ? 'denied' : decision.state === 'hold' ? 'pending' : 'approved';
    const w = parse<T.WorkAuthority>(ledger.get('SELECT json FROM works WHERE id=?', a.workId))!;
    const originalPolicy = parse<T.StandingPolicy>(ledger.get('SELECT json FROM policies WHERE revision=?', a.policyRevision));
    const originalClaim = parse<Claim>(ledger.get('SELECT json FROM claims WHERE action_id=?', a.id));
    const recurring = !changed && originalClaim ? originalClaim.recurring : recurringProjection(a, w, originalPolicy?.rules ?? []);
    const statements = ledger.all<{ json: string }>("SELECT json FROM observations WHERE action_id=? AND json_extract(json,'$.basis')='owner_statement' ORDER BY seq", a.id).map(r => ({ outcome: (JSON.parse(r.json) as T.Observation).code as 'occurred' | 'did_not_occur' }));
    return { contract: 's15-action-slip/v1', action: clone(a), payloadBytesBase64: Buffer.from(v.canonical(a.payload)).toString('base64'), state, expiresAt: a.expiresAt, reasonCode: changed ? 'stale_action' : activeDispatches.has(a.id) ? null : observed ? observed.code : reason, canApprove: state === 'pending' && !['policy_match_required', 'snapshot_required', 'cost_unknown', 'finite_budget_required', 'owner_direction_required', 'production_impact_required', 'github_evidence_required'].includes(reason ?? ''), replacement: changed ? actionRef(currentAction) : null, observation: observed, recurring, statements };
  }
  function proposal(input: T.PolicyInput | null): T.PolicyProposal {
    if (input !== null) v.policy(input);
    const current = getPolicy();
    if (!current && input?.rules.some(r => r.mode.startsWith('personal_github'))) v.fail('personal_profile_separate');
    const budget = input?.budget;
    // POLICY15-02: no monetary budget is installable only when every selection is a current protected subscription
    // route and the registry supplies finite tool bounds; a metered selection always needs the owner's finite budget.
    const tools = subscriptionBounds?.tools;
    const subscriptionOnly = !!input && !budget && !!subscription && !!subscriptionBounds && !!tools && input.selections.every(s => subscription.current(clone(s)));
    const technical: T.PolicyProposal['fields'] = subscriptionOnly && subscriptionBounds && tools ? [
      { path: 'budget', value: null, status: 'provided' },
      { path: 'subscription.concurrency', value: subscriptionBounds.concurrency, status: 'provided' },
      ...(['calls', 'steps', 'activeMs'] as const).map(key => ({ path: 'subscription.perWork.' + key, value: subscriptionBounds.perWork[key], status: 'provided' as const })),
      ...(['attempts', 'steps', 'calls', 'reads', 'outputBytes', 'activeMs'] as const).map(key => ({ path: 'subscription.tools.' + key, value: tools[key], status: 'provided' as const })),
    ] : [];
    const body: Omit<T.PolicyProposal, 'proposalHash'> = {
      contract: 's15-policy-proposal/v1', ownerGeneration: options.ownerGeneration(), expectedRevision: current?.revision ?? 0, policy: clone(input),
      rows: [
        { id: 'ordinary', text: 'Requested research, reversible edits and work inside the expendable VM use current purpose, resource and model policy.', mode: 'ordinary' },
        { id: 'held', text: 'Communications, publication, payments, production, new private-data recipients and major changes require exact approval unless an eligible standing rule applies.', mode: 'approval_required' },
        { id: 'github_personal', text: input?.rules.some(r => r.mode.startsWith('personal_github')) ? 'Personal GitHub exceptions are explicitly configured in the exact rules below.' : 'Personal GitHub publication and merge exceptions are configured separately and start disabled.', mode: input?.rules.some(r => r.mode.startsWith('personal_github')) ? 'ordinary' : 'off' },
      ],
      fields: subscriptionOnly ? technical : [
        ...(['currency', 'startsAt', 'expiresAt'] as const).map(key => ({ path: 'budget.' + key, value: budget?.[key] ?? null, status: budget ? 'provided' as const : 'owner_required' as const })),
        ...(['attempts', 'steps', 'calls', 'reads', 'outputBytes', 'activeMs', 'spendMinor'] as const).map(key => ({ path: 'budget.ceiling.' + key, value: budget?.ceiling[key] ?? null, status: budget ? 'provided' as const : key === 'spendMinor' ? 'owner_required' as const : 'profile_required' as const })),
        { path: 'budget.concurrency', value: budget?.concurrency ?? null, status: budget ? 'provided' : 'profile_required' },
      ],
      installable: !!input && (budget ? time() < budget.expiresAt : subscriptionOnly) && time() < input.expiresAt && !input.rules.some(r => r.mode === 'recurring_payment' && !current?.rules.some(x => v.equal(x, r))),
    };
    return { ...body, proposalHash: v.digest('s15.policy.proposal.v1', body) };
  }
  const owner: T.OwnerPort = {
    authenticate(proof) { return tx(() => { const principal = options.verifyOwner(proof); if (!principal || principal.generation !== options.ownerGeneration() || principal.expiresAt <= time()) v.fail('authentication_required'); v.id(principal.id); v.nat(principal.generation, true); const actor = Object.freeze({}) as T.OwnerActor; owners.set(actor, { proof, id: principal.id, generation: principal.generation }); ownerAuth(actor); return actor; }); },
    current(actor, options) { return tx(() => {
      ownerAuth(actor);
      if (options !== undefined) { v.exact(options, ['requireUsable']); if (options.requireUsable !== true) v.fail('invalid_shape'); }
      return clone(options?.requireUsable ? usablePolicy() : getPolicy());
    }); },
    prepareInterpretation(actor, input) { return tx(() => {
      v.exact(input, ['requestId', 'selection', 'expiresAt']); v.id(input.requestId); v.selection(input.selection); v.nat(input.expiresAt, true);
      return receipt(actor, input.requestId, { kind: 'interpretation.prepare', input }, () => {
        const p = policyCurrent(); if (!p.interpretationPurpose) v.fail('interpretation_policy_required');
        const request: T.WorkRequest = { requestId: input.requestId, intent: 'inspect', access: 'read', purpose: clone(p.interpretationPurpose), bot: clone(p.bots[0] ?? v.fail('outside_scope')), resources: [], recipients: [], selection: clone(input.selection), selectionPin: clone(input.selection), expiresAt: input.expiresAt };
        checkRequest(p, request); if (time() >= input.expiresAt || input.expiresAt > p.expiresAt || (p.budget && input.expiresAt > p.budget.expiresAt)) v.fail('expired');
        const authority: T.WorkAuthority = { id: uid(), mode: 'interpretation', readLimit: 0, ownerGeneration: p.ownerGeneration, policyRevision: p.revision, policyHash: v.digest('s15.policy.v1', p), request, createdAt: time(), expiresAt: input.expiresAt };
        if (!options.catalogs.allows(clone(authority), null)) v.fail('outside_scope');
        ledger.run('INSERT INTO works(id,json) VALUES (?,?)', authority.id, v.canonical(authority)); return { authority, purposes: p.purposes.filter(r => !v.equal(r, p.interpretationPurpose)) };
      });
    }); },
    proposePolicy(actor, input) { return tx(() => { ownerAuth(actor); const p = proposal(input); if (p.installable) ledger.run('INSERT OR IGNORE INTO proposals VALUES (?,?)', p.proposalHash, v.canonical(p)); return clone(p); }); },
    installProposal(actor, requestId, proposalHash) { return tx(() => { v.hash(proposalHash); return receipt(actor, requestId, { kind: 'policy.install', proposalHash }, () => {
      const p = parse<T.PolicyProposal>(ledger.get('SELECT json FROM proposals WHERE hash=?', proposalHash)); if (!p || !p.installable || !p.policy) v.fail('proposal_incomplete');
      const { proposalHash: stored, ...body } = p; if (stored !== proposalHash || v.digest('s15.policy.proposal.v1', body) !== stored) v.fail('hash_mismatch');
      if (p.ownerGeneration !== options.ownerGeneration()) v.fail('stale_authority'); return savePolicy(p.policy, p.expectedRevision);
    }); }); },
    actionSlip(actor, action) { return tx(() => { ownerAuth(actor); return slip(action); }); },
    decidePending(actor, input) { tx(() => {
      ownerAuth(actor); v.exact(input, ['requestId', 'workIds', 'seen', 'decision', 'expiresAt']); v.id(input.requestId); v.nat(input.expiresAt, true);
      if (ledger.get('SELECT id FROM receipts WHERE id=?', input.requestId)) { owner.decide(actor, { requestId: input.requestId, action: input.seen, decision: input.decision, expiresAt: input.expiresAt }); return; }
      if (!Array.isArray(input.workIds) || input.workIds.length > 64 || !input.workIds.length) v.fail('approval_reference_required'); input.workIds.forEach(v.id); if (new Set(input.workIds).size !== input.workIds.length) v.fail('invalid_shape');
      const pending = ledger.all<{ json: string }>('SELECT a.json FROM actions a JOIN slots s ON a.id=s.action_id AND a.revision=s.revision').map(r => JSON.parse(r.json) as T.PreparedAction).filter(a => input.workIds.includes(a.workId)).flatMap(a => {
        try { return [slip(actionRef(a))]; }
        catch (error) {
          // Withdrawn historical payloads are not selectable pending items. The selected action is
          // still checked by decide below; corrupt state and other failures are never suppressed.
          if (error instanceof v.PolicyError && ['lineage_withdrawn', 'payload_withdrawn'].includes(error.code)) return [];
          throw error;
        }
      }).filter(s => s.state === 'pending' && s.canApprove);
      if (pending.length !== 1) v.fail('approval_reference_required'); const only = pending[0]!; if (!v.equal(actionRef(only.action), input.seen)) v.fail('stale_action');
      owner.decide(actor, { requestId: input.requestId, action: input.seen, decision: input.decision, expiresAt: input.expiresAt });
    }); },
    install(actor, requestId, expectedRevision, input) { return tx(() => { v.policy(input); return receipt(actor, requestId, { kind: 'policy.install', expectedRevision, input }, () => savePolicy(input, expectedRevision)); }); },
    admit(actor, request) { return tx(() => { v.workRequest(request); return receipt(actor, request.requestId, { kind: 'work.request', request }, () => {
      const p = policyCurrent(); checkRequest(p, request); if (p.interpretationPurpose && v.equal(p.interpretationPurpose, request.purpose)) v.fail('outside_scope');
      if (time() >= request.expiresAt || request.expiresAt > p.expiresAt || (p.budget && request.expiresAt > p.budget.expiresAt)) v.fail('expired');
      if (request.intent === 'accept_obligation') return { work: null, receiptId: request.requestId };
      const w: T.WorkAuthority = { id: uid(), mode: 'work', readLimit: request.readLimit ?? readCeiling(p), ownerGeneration: p.ownerGeneration, policyRevision: p.revision, policyHash: v.digest('s15.policy.v1', p), request: clone(request), createdAt: time(), expiresAt: request.expiresAt };
      if (!options.catalogs.allows(clone(w), null)) v.fail('outside_scope');
      ledger.run('INSERT INTO works(id,json) VALUES (?,?)', w.id, v.canonical(w)); return { work: w, receiptId: request.requestId };
    }); }); },
    decide(actor, input) { tx(() => { v.exact(input, ['requestId', 'action', 'decision', 'expiresAt']); v.id(input.requestId); v.nat(input.expiresAt, true); if (!['approve', 'deny'].includes(input.decision)) v.fail('invalid_shape'); receipt(actor, input.requestId, { kind: 'action.decide', input }, () => {
      const a = loadAction(input.action), w = currentWork(a.workId); checkAction(w, a); if (claimed(a)) v.fail('already_claimed');
      if (input.expiresAt > a.expiresAt || input.expiresAt <= time()) v.fail('expired');
      // Denial only narrows authority: the owner may veto any unclaimed revision, even one that cannot be approved.
      const evaluated = input.decision === 'deny' ? null : evaluate(w, a); if (evaluated && (evaluated.state === 'deny' || evaluated.state === 'unsupported' || (evaluated.state === 'hold' && ['policy_match_required', 'snapshot_required', 'cost_unknown', 'finite_budget_required', 'production_impact_required', 'github_evidence_required'].includes(evaluated.code)))) v.fail(evaluated.code);
      const approved = { ...clone(input), id: uid(), ownerGeneration: w.ownerGeneration, policyHash: w.policyHash };
      ledger.run('INSERT INTO approvals VALUES (?,?,?,?)', approved.id, a.id, a.revision, v.canonical(approved)); return { recorded: true };
    }); }); },
    approveRecurringRule(actor, requestId, expectedRevision, rule) { return tx(() => { v.rule(rule); if (rule.mode !== 'recurring_payment') v.fail('invalid_rule'); return receipt(actor, requestId, { kind: 'recurring.approve', expectedRevision, rule }, () => {
      const p = policyCurrent(); const { contract, revision, ownerGeneration, ...input } = p;
      input.rules = [...input.rules.filter(r => r.id !== rule.id), clone(rule)]; return savePolicy(input, expectedRevision, true);
    }); }); },
    revoke(actor, requestId, scope) { tx(() => { if (scope.kind === 'policy') v.exact(scope, ['kind']); else { v.exact(scope, ['kind', 'id']); if (scope.kind !== 'work') v.fail('invalid_shape'); v.id(scope.id); } receipt(actor, requestId, { kind: 'authority.revoke', scope }, () => {
      if (scope.kind === 'policy') ledger.put('policyRevoked', true); else { if (!ledger.get('SELECT id FROM works WHERE id=?', scope.id)) v.fail('authority_revoked'); ledger.run('UPDATE works SET revoked=1 WHERE id=?', scope.id); } return { recorded: true };
    }); }); },
    inspect(actor, ref) { return tx(() => { ownerAuth(actor); const a = loadAction(ref); readableAction(a); return { action: clone(a), observation: observationFor(a) }; }); },
    actionScope(actor, ref) { return tx(() => { ownerAuth(actor); const a = loadAction(ref); readableAction(a); const w = parse<T.WorkAuthority>(ledger.get('SELECT json FROM works WHERE id=?', a.workId)); if (!w) v.fail('authority_revoked'); return { purpose: clone(w.request.purpose), bot: clone(w.request.bot), selection: clone(w.request.selection) }; }); },
    async reconcile(actor, ref, requestId) {
      const start = tx(() => {
        ownerAuth(actor); v.id(requestId); const a = loadAction(ref); const claim = parse<Claim>(ledger.get('SELECT json FROM claims WHERE action_id=?', a.id)); if (!claim) v.fail('reconciliation_required');
        const adapter = adapters.get(a.adapter); if (!adapter?.reconcile) v.fail('adapter_unproven');
        const existing = observationFor(a); if (existing && existing.outcome !== 'unknown') return { a, claim, adapter, result: existing, reservation: null };
        const w = parse<T.WorkAuthority>(ledger.get('SELECT json FROM works WHERE id=?', a.workId)); if (!w) v.fail('authority_revoked');
        const p = policyCurrent(); checkRequest(p, w.request);
        a.resources.forEach(r => { if (!v.contains(p.resources, r)) v.fail('outside_scope'); currentRef('resource', r); });
        a.recipients.forEach(r => { if (!v.contains(p.recipients, r)) v.fail('outside_scope'); currentRef('recipient', r); });
        if (!options.catalogs.allows(clone(w), clone(a))) v.fail('outside_scope');
        const bound = clone(adapter.reconcileUpperBound ?? { ...v.zero(), calls: 1, reads: 1 });
        v.vector(bound); if (bound.calls < 1 || bound.reads < 1) v.fail('cost_unknown');
        // One durable recovery lane is independent of ordinary capacity, but shares its finite cost ceiling.
        const reservation = reserve(w, 'reconcile_' + requestId, bound, { kind: 'reconcile', action: ref }, true);
        ledger.run('INSERT INTO recovery_reads(reservation_id,action_id,active) VALUES (?,?,1)', reservation.id, a.id);
        return { a, claim, adapter, result: null, reservation };
      });
      if (start.result) return controlObservation(start.result);
      let result: T.AdapterResult, readSettled = false, readCalls = 0, recoveryLive = true;
      try {
        result = await start.adapter.reconcile!(clone(start.a), { beforeRead() { tx(() => {
          if (!recoveryLive) v.fail('already_claimed');
          ownerAuth(actor);
          const current = loadAction(ref), work = parse<T.WorkAuthority>(ledger.get('SELECT json FROM works WHERE id=?', current.workId));
          if (!work) v.fail('authority_revoked');
          const p = policyCurrent(); checkRequest(p, work.request);
          current.resources.forEach(r => { if (!v.contains(p.resources, r)) v.fail('outside_scope'); currentRef('resource', r); });
          current.recipients.forEach(r => { if (!v.contains(p.recipients, r)) v.fail('outside_scope'); currentRef('recipient', r); });
          current.fences.forEach(f => currentRef(f.kind, f.ref));
          if (!options.catalogs.allows(clone(work), clone(current))) v.fail('outside_scope');
          budgetCheck(start.reservation!.upperBound, true, true, undefined, work);
          if (readCalls >= Math.min(start.reservation!.upperBound.calls, start.reservation!.upperBound.reads)) v.fail('read_bound_exhausted');
          readCalls++;
        }); } });
        // A fulfilled read-back has finished its own transport even when the effect is still unknown.
        readSettled = true; checkResult(result);
      } catch { result = { outcome: 'unknown', actual: v.unknownUsage(), transportSettled: false }; }
      finally { recoveryLive = false; }
      const observed: T.Observation = { ...clone(result), basis: result.outcome === 'unknown' ? 'uncertain' : 'remote_verified', code: result.outcome === 'unknown' ? 'reconciliation_required' : null };
      // Commit read settlement independently: an obsolete/conflicting effect observation cannot retain a finished read's capacity.
      tx(() => {
        const readUsage = readSettled ? { ...v.unknownUsage(), calls: readCalls || 1, reads: readCalls || 1 } : v.unknownUsage();
        settleReservation(start.reservation!.id, readUsage, readSettled, true);
        ledger.run('UPDATE recovery_reads SET observation=? WHERE reservation_id=?', v.canonical(observed), start.reservation!.id);
      });
      return tx(() => controlObservation(observe(start.a, start.claim, observed)));
    },
    recordStatement(actor, ref, requestId, outcome) { tx(() => { if (!['occurred', 'did_not_occur'].includes(outcome)) v.fail('invalid_shape'); receipt(actor, requestId, { kind: 'effect.statement', ref, outcome }, () => { const a = loadAction(ref); if (!claimed(a)) v.fail('reconciliation_required'); ledger.run('INSERT INTO observations(action_id,json) VALUES (?,?)', a.id, v.canonical({ outcome: 'unknown', basis: 'owner_statement', code: outcome, actual: v.unknownUsage(), transportSettled: false })); return { recorded: true }; }); }); },
  };
  function readClaim(id: string): { claim: T.ReadClaim; dispatched: number; observation: T.Observation | null; resultHash: string | null } {
    v.id(id); const row = ledger.get<{ json: string; dispatched: number; observation: string | null; result_hash: string | null }>('SELECT * FROM read_claims WHERE id=?', id); if (!row) v.fail('read_claim_not_found');
    const claim = JSON.parse(row.json) as T.ReadClaim, { claimHash, ...body } = claim;
    if (v.digest('s15.read.claim.v1', body) !== claimHash || v.digest('s15.read.payload.v1', claim.input.exactPayload) !== claim.payloadHash) v.fail('hash_mismatch');
    return { claim, dispatched: row.dispatched, observation: row.observation ? JSON.parse(row.observation) as T.Observation : null, resultHash: row.result_hash };
  }
  function checkRead(w: T.WorkAuthority, input: T.ReadInput): void {
    if (w.mode !== 'work' || !['inspect', 'execute'].includes(w.request.intent) || !v.contains(w.request.resources, input.resource)) v.fail('outside_scope');
    const handler = readHandlers.get(input.operation); if (!handler) v.fail('read_operation_unavailable');
    currentRef('resource', input.resource); input.fences.forEach(f => currentRef(f.kind, f.ref));
    if (policyCurrent().rules.some(r => r.mode === 'deny' && time() < r.expiresAt && r.operations.includes(input.operation) && v.contains(r.purposes, w.request.purpose) && v.contains(r.bots, w.request.bot) && v.contains(r.selections, w.request.selection) && v.contains(r.resources, input.resource))) v.fail('rule_denied');
    handler.validate(clone(input.exactPayload), { work: clone(w), resource: clone(input.resource) });
  }
  function guardReadClaim(actor: T.WorkActor, id: string, consume: boolean): T.ReadClaim {
    const w = workAuth(actor), row = readClaim(id), c = row.claim;
    if (c.workId !== w.id || c.policyHash !== w.policyHash || c.ownerGeneration !== options.ownerGeneration()) v.fail('outside_scope');
    if (time() >= c.expiresAt) v.fail('expired'); checkRead(w, c.input);
    if (consume) {
      if (row.dispatched || row.observation) v.fail('already_claimed');
      budgetCheck(c.input.upperBound, true, false, undefined, w);
      const reservation = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', c.reservationId));
      if (!reservation || reservation.transportSettled || !v.equal(reservation.upperBound, c.input.upperBound)) v.fail('reservation_not_found');
      ledger.run('UPDATE read_claims SET dispatched=1 WHERE id=?', id);
    }
    return clone(c);
  }
  const work: T.WorkPort = {
    reserveRead(actor, input) { try { return tx(() => {
        v.exact(input, ['requestId', 'resource', 'operation', 'exactPayload', 'upperBound', 'fences']); v.id(input.requestId); v.ref(input.resource); v.vector(input.upperBound); v.fences(input.fences); v.canonical(input.exactPayload);
        if (!['read', 'grep', 'find', 'ls', 'workspace_setup'].includes(input.operation)) v.fail('read_operation_unavailable');
        if (input.upperBound.reads < 1) v.fail('cost_unknown');
        const w = workAuth(actor); checkRead(w, input);
        const previous = ledger.get<{ json: string }>('SELECT json FROM read_claims WHERE work_id=? AND request_id=?', w.id, input.requestId);
        if (previous) { const old = JSON.parse(previous.json) as T.ReadClaim; if (!v.equal(old.input, input)) v.fail('request_id_conflict'); v.fail('already_claimed'); }
        const used = ledger.all<{ json: string }>('SELECT json FROM read_claims WHERE work_id=?', w.id).reduce((sum, r) => { const count = sum + (JSON.parse(r.json) as T.ReadClaim).input.upperBound.reads; v.nat(count); return count; }, 0);
        if (used + input.upperBound.reads > w.readLimit) v.fail('read_bound_exhausted');
        const reservation = reserve(w, 'read_' + input.requestId, input.upperBound, { kind: 'read', input });
        const body: Omit<T.ReadClaim, 'claimHash'> = { id: uid(), workId: w.id, input: clone(input), payloadHash: v.digest('s15.read.payload.v1', input.exactPayload), policyHash: w.policyHash, ownerGeneration: w.ownerGeneration, reservationId: reservation.id, expiresAt: Math.min(w.expiresAt, policyCurrent().budget?.expiresAt ?? w.expiresAt), createdAt: time() };
        const claim: T.ReadClaim = { ...body, claimHash: v.digest('s15.read.claim.v1', body) };
        ledger.run('INSERT INTO read_claims(id,work_id,request_id,json) VALUES (?,?,?,?)', claim.id, w.id, input.requestId, v.canonical(claim)); return { state: 'allow', claim };
    }); } catch (error) { if (!(error instanceof v.PolicyError)) throw error; return { state: ['finite_budget_required', 'cost_unknown', 'capacity_busy'].includes(error.code) ? 'hold' : 'deny', code: error.code }; } },
    guardRead(actor, claimId) { return tx(() => guardReadClaim(actor, claimId, true)); },
    guard(actor) { return tx(() => clone(workAuth(actor))); },
    modelSelections(actor) { return tx(() => {
      const w = workAuth(actor), p = policyCurrent();
      return p.selections.filter(selection => {
        if (w.request.selectionPin && !v.equal(w.request.selectionPin, selection)) return false;
        try { currentRef('route', selection.route); currentRef('model', selection.model); }
        catch (error) { if (error instanceof v.PolicyError) return false; throw error; }
        return options.catalogs.allows({ ...clone(w), request: { ...clone(w.request), selection: clone(selection) } }, null);
      }).map(clone);
    }); },
    reserveModelCall(actor, input) {
      const reservation = tx(() => {
        v.exact(input, ['requestId', 'selection', 'upperBound']); v.id(input.requestId); v.selection(input.selection); v.vector(input.upperBound);
        if (input.upperBound.calls < 1) v.fail('cost_unknown');
        const w = workAuth(actor), p = policyCurrent();
        if (w.mode === 'interpretation' && (input.upperBound.calls !== 1 || input.upperBound.reads !== 0 || ledger.get("SELECT id FROM reservations WHERE json_extract(json,'$.workId')=?", w.id))) v.fail('interpretation_call_claimed');
        if (!v.contains(p.selections, input.selection) || (w.request.selectionPin && !v.equal(w.request.selectionPin, input.selection))) v.fail('selection_pinned');
        currentRef('route', input.selection.route); currentRef('model', input.selection.model);
        if (!options.catalogs.allows({ ...clone(w), request: { ...clone(w.request), selection: clone(input.selection) } }, null)) v.fail('outside_scope');
        if (options.catalogs.allowsModel && !options.catalogs.allowsModel(clone(w), clone(input.selection))) v.fail('recipient_unapproved');
        const r = reserve(w, input.requestId, input.upperBound, input, false, input.selection); r.selection = clone(input.selection); r.billing = p.budget ? 'metered' : 'subscription';
        ledger.run('UPDATE reservations SET json=? WHERE id=?', v.canonical(r), r.id); return clone(r);
      });
      modelInvocations.set(reservation.id, actor); return reservation;
    },
    guardReservation(actor, reservationId) { const reservation = tx(() => {
      const w = workAuth(actor); v.id(reservationId); const r = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', reservationId));
      if (!r || r.workId !== w.id || r.transportSettled || !r.selection) v.fail('reservation_not_found');
      if (ledger.get('SELECT reservation_id FROM model_dispatches WHERE reservation_id=?', reservationId)) v.fail('already_claimed');
      if (modelInvocations.get(reservationId) !== actor) v.fail('reconciliation_required');
      const p = policyCurrent(); if (!v.contains(p.selections, r.selection) || (w.request.selectionPin && !v.equal(w.request.selectionPin, r.selection))) v.fail('selection_pinned');
      currentRef('route', r.selection.route); currentRef('model', r.selection.model); budgetCheck(r.upperBound, true, false, { workId: w.id, selection: r.selection });
      if (!options.catalogs.allows({ ...clone(w), request: { ...clone(w.request), selection: clone(r.selection) } }, null)) v.fail('outside_scope');
      if (options.catalogs.allowsModel && !options.catalogs.allowsModel(clone(w), clone(r.selection))) v.fail('recipient_unapproved');
      ledger.run('INSERT INTO model_dispatches VALUES (?,?)', reservationId, time()); return clone(r);
    }); modelInvocations.delete(reservationId); return reservation; },
    prepare(actor, input) { return tx(() => {
      v.exact(input, ['slot', 'adapter', 'proposal']); v.id(input.slot); v.id(input.adapter); v.canonical(input.proposal);
      const w = workAuth(actor); if (w.request.intent !== 'execute') v.fail('outside_scope');
      const adapter = adapters.get(input.adapter); if (!adapter) v.fail('adapter_unproven');
      const proposed = clone(adapter.prepare(clone(input.proposal), { work: clone(w), now: time() })); v.draft(proposed);
      const effectKey = v.digest('s15.effect.slot.v1', { work: w.id, slot: input.slot });
      const old = ledger.get<{ action_id: string; revision: number; proposal_hash: string }>('SELECT * FROM slots WHERE effect_key=?', effectKey);
      const proposalHash = v.digest('s15.proposal.v1', { adapter: adapter.id, version: adapter.version, proposed });
      if (old) {
        const previous = parse<T.PreparedAction>(ledger.get('SELECT json FROM actions WHERE id=? AND revision=?', old.action_id, old.revision))!;
        if (claimed(previous)) v.fail('already_claimed');
        if (old.proposal_hash === proposalHash) return { action: clone(previous), decision: evaluate(w, previous) };
      }
      const body: Omit<T.PreparedAction, 'actionHash'> = { ...proposed, id: old?.action_id ?? uid(), revision: (old?.revision ?? 0) + 1, effectKey, adapter: adapter.id, adapterVersion: adapter.version, workId: w.id, ownerGeneration: w.ownerGeneration, policyRevision: w.policyRevision, policyHash: w.policyHash, createdAt: time(), contentHash: v.digest('s15.content.v1', proposed.payload), recipientHash: v.digest('s15.recipients.v1', proposed.recipients), transactionHash: proposed.transaction ? v.digest('s15.transaction.v1', proposed.transaction) : null, expiresAt: Math.min(proposed.expiresAt, w.expiresAt, policyCurrent().expiresAt, policyCurrent().budget?.expiresAt ?? w.expiresAt) };
      const a: T.PreparedAction = { ...body, actionHash: v.digest('s15.action.v1', body) }; checkAction(w, a); if (claimed(a)) v.fail('already_claimed');
      ledger.run('INSERT INTO actions VALUES (?,?,?,?)', a.id, a.revision, effectKey, v.canonical(a));
      ledger.run('INSERT INTO slots VALUES (?,?,?,?) ON CONFLICT(effect_key) DO UPDATE SET revision=excluded.revision,proposal_hash=excluded.proposal_hash', effectKey, a.id, a.revision, proposalHash);
      return { action: clone(a), decision: evaluate(w, a) };
    }); },
    evaluate(actor, ref) { return tx(() => evaluate(workAuth(actor), loadAction(ref))); },
    guardBeforeDispatch(actor, ref) { return tx(() => { const w = workAuth(actor), a = loadAction(ref); requireAllowed(evaluate(w, a)); return clone(a); }); },
    async dispatch(actor, ref) {
      const { a, claim, adapter } = tx(() => {
        const w = workAuth(actor), a = loadAction(ref); const decision = evaluate(w, a); requireAllowed(decision);
        const reservation = reserve(w, 'effect_' + a.effectKey, a.upperBound!, { action: ref });
        const claim: Claim = { action: actionRef(a), reservationId: reservation.id, decision, createdAt: time(), recurring: recurringProjection(a, w, policyCurrent().rules) };
        ledger.run('INSERT INTO claims VALUES (?,?,?,?,?)', a.effectKey, a.id, paymentKey(a), reservation.id, v.canonical(claim));
        // Exact one-time overrides still consume the related recurring cadence/total; they never create an extra automatic slot.
        for (const { rule } of claim.recurring) {
          const f = rule.recurrence!, t = a.transaction!;
          if (!v.equal(f.payee, t.payee) || !v.equal(f.account, t.account) || f.currency !== t.currency || f.minorUnit !== t.minorUnit) continue;
          const used = ledger.get<{ count: number; amount_minor: string }>('SELECT * FROM recurring_usage WHERE id=?', rule.id);
          const count = (used?.count ?? 0) + 1; v.nat(count, true); const amount = (BigInt(used?.amount_minor ?? '0') + BigInt(t.amountMinor)).toString(); v.minor(amount);
          ledger.run('INSERT INTO recurring_usage VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET count=excluded.count,amount_minor=excluded.amount_minor,last_at=excluded.last_at', rule.id, count, amount, time());
        }
        return { a, claim, adapter: adapters.get(a.adapter)! };
      });
      activeDispatches.add(a.id);
      let consumed = false, started = false, live = true, pending: Promise<T.AdapterResult> | null = null;
      const context: T.DispatchContext = Object.freeze({ guard() {
        if (!live || !started) v.fail('context_lost');
        tx(() => {
          const decision = evaluate(workAuth(actor), loadAction(ref), true); requireAllowed(decision);
          if (!v.equal(decision, claim.decision)) v.fail('stale_authority');
          const stored = parse<Claim>(ledger.get('SELECT json FROM claims WHERE action_id=?', a.id));
          const reservation = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', claim.reservationId));
          if (!stored || !v.equal(stored, claim) || !reservation || reservation.transportSettled) v.fail('context_lost');
        });
      }, commit(finalPayload: T.JsonValue, send: () => Promise<T.AdapterResult>): Promise<T.AdapterResult> {
        if (consumed) v.fail('already_claimed'); consumed = true; if (typeof send !== 'function') v.fail('adapter_unproven');
        tx(() => {
          const w = workAuth(actor), current = loadAction(ref); const decision = evaluate(w, current, true); requireAllowed(decision);
          if (!v.equal(decision, claim.decision)) v.fail('stale_authority');
          const stored = parse<Claim>(ledger.get('SELECT json FROM claims WHERE action_id=?', a.id)); if (!stored || !v.equal(stored, claim)) v.fail('continuity_unavailable');
          const reservation = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', claim.reservationId)); if (!reservation || reservation.transportSettled || !v.equal(reservation.upperBound, a.upperBound)) v.fail('reservation_not_found');
          if (v.digest('s15.content.v1', finalPayload) !== a.contentHash) v.fail('hash_mismatch');
          // The durable claim committed earlier. Invocation under this writer fence orders revocation before/after the irreversible send.
          started = true; pending = send(); if (!(pending instanceof Promise)) v.fail('invalid_adapter_result'); void pending.catch(() => {});
        });
        return pending!;
      } });
      let result: T.AdapterResult;
      try {
        result = await adapter.perform(clone(a), context);
        if (!started || !pending) v.fail('adapter_unproven');
        const actualResult = await pending; checkResult(actualResult); checkResult(result);
        if (!v.equal(actualResult, result)) v.fail('invalid_adapter_result');
      } catch (error) {
        if (!started) {
          const safe: T.Observation = { outcome: 'not_dispatched', basis: 'local_guard', code: error instanceof v.PolicyError ? error.code : 'adapter_unproven', actual: v.unknownUsage(), transportSettled: true };
          return tx(() => controlObservation(observe(a, claim, safe)));
        }
        result = { outcome: 'unknown', actual: v.unknownUsage(), transportSettled: false };
      } finally { consumed = true; live = false; activeDispatches.delete(a.id); }
      const observed: T.Observation = { ...clone(result), basis: result.outcome === 'unknown' ? 'uncertain' : 'remote_verified', code: result.outcome === 'unknown' ? 'reconciliation_required' : null };
      return tx(() => controlObservation(observe(a, claim, observed)));
    },
  };
  const control: T.ControlPort = {
    policyForWork(workId) { return tx(() => { v.id(workId); currentWork(workId); return clone(policyCurrent()); }); },
    settleRead(claimId, observation, resultHash) { tx(() => {
      const row = readClaim(claimId); v.exact(observation, ['outcome', 'basis', 'code', 'actual', 'transportSettled']); v.usage(observation.actual);
      if (!['not_dispatched', 'succeeded', 'failed', 'unknown'].includes(observation.outcome) || !['local_guard', 'remote_verified', 'uncertain'].includes(observation.basis) || typeof observation.transportSettled !== 'boolean') v.fail('invalid_read_result');
      if (observation.code !== null) v.id(observation.code); if (resultHash !== null) v.hash(resultHash);
      if (observation.outcome === 'not_dispatched' && (row.dispatched || observation.basis !== 'local_guard' || !observation.transportSettled)) v.fail('invalid_read_result');
      if (['succeeded', 'failed'].includes(observation.outcome) && (!row.dispatched || !observation.transportSettled || observation.basis !== 'remote_verified')) v.fail('invalid_read_result');
      if ((observation.outcome === 'succeeded') !== (resultHash !== null)) v.fail('invalid_read_result');
      if (row.observation && row.observation.outcome !== 'unknown' && (!v.equal(row.observation, observation) || row.resultHash !== resultHash)) v.fail('settlement_conflict');
      settleReservation(row.claim.reservationId, observation.actual, observation.transportSettled);
      ledger.run('UPDATE read_claims SET observation=?,result_hash=? WHERE id=?', v.canonical(observation), resultHash, claimId);
    }); },
    publishRead(actor, claimId) { return tx(() => { guardReadClaim(actor, claimId, false); const row = readClaim(claimId); if (!row.observation) v.fail('observation_required'); return { observation: clone(row.observation), resultHash: row.resultHash }; }); },

    bindWork(workId) { return tx(() => { v.id(workId); currentWork(workId); const actor = Object.freeze({}) as T.WorkActor; workers.set(actor, workId); return actor; }); },
    settleReservation(id, usage, transportSettled) { tx(() => settleReservation(id, usage, transportSettled)); },
    publishable(actor, ref) { return tx(() => { const w = workAuth(actor), a = loadAction(ref); checkAction(w, a); const result = observationFor(a); if (!result) v.fail('observation_required'); return clone(result); }); },
    usage() { return tx(() => ({ charged: clone(ledger.meta<T.BudgetVector>('charged')!), unsettled: unsettled() })); },
    reservations(workId) { return tx(() => { if (workId !== undefined) v.id(workId); return ledger.all<{ json: string }>('SELECT json FROM reservations').map(row => JSON.parse(row.json) as T.Reservation).filter(row => workId === undefined || row.workId === workId).map(clone); }); },
    subscriptionLimits() { return tx(() => clone(subscriptionBounds)); },
    close() { if (!closed) { closed = true; ledger.db.close(); } },
  };
  return Object.freeze({ owner: Object.freeze(owner), work: Object.freeze(work), control: Object.freeze(control) });
}

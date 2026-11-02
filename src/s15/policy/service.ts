import { randomUUID } from 'node:crypto';
import { PolicyLedger } from './ledger';
import * as v from './validation';
import type * as T from './types';

type Claim = { action: T.ActionRef; reservationId: string; decision: Extract<T.Decision, { state: 'allow' }>; createdAt: number };
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
  const ledger = new PolicyLedger(options.path, options.create, options.installationId);
  const owners = new WeakMap<T.OwnerActor, { proof: unknown; id: string; generation: number }>();
  const workers = new WeakMap<T.WorkActor, string>();
  const adapters = new Map(options.adapters.map(a => { v.id(a.id); v.nat(a.version, true); return [a.id, a] as const; }));
  if (adapters.size !== options.adapters.length) { ledger.db.close(); v.fail('adapter_unproven'); }
  let closed = false;
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
  function policyCurrent(): T.StandingPolicy {
    const p = getPolicy(); if (!p) v.fail('policy_required');
    if (ledger.meta('policyRevoked') || p.ownerGeneration !== options.ownerGeneration()) v.fail('authority_revoked');
    if (time() >= p.expiresAt) v.fail('expired');
    return p;
  }
  function checkRequest(p: T.StandingPolicy, r: T.WorkRequest): void {
    if (!v.contains(p.purposes, r.purpose) || !v.contains(p.bots, r.bot) || !v.contains(p.selections, r.selection) || r.resources.some(x => !v.contains(p.resources, x)) || r.recipients.some(x => !v.contains(p.recipients, x)) || (r.subject && !v.contains(r.resources, r.subject.resource))) v.fail('outside_scope');
    currentRef('purpose', r.purpose); currentRef('bot', r.bot); currentRef('route', r.selection.route); currentRef('model', r.selection.model);
    r.resources.forEach(x => currentRef('resource', x)); r.recipients.forEach(x => currentRef('recipient', x)); r.fences?.forEach(x => currentRef(x.kind, x.ref));
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
    const hash = v.digest('s15.command.v1', command);
    const previous = ledger.get<{ hash: string; json: string }>('SELECT hash,json FROM receipts WHERE id=?', requestId);
    if (previous) { if (previous.hash !== hash) v.fail('request_id_conflict'); return JSON.parse(previous.json) as R; }
    if (ledger.meta<string>('ownerId') === null) ledger.put('ownerId', principal.id);
    const result = operation();
    ledger.run('INSERT INTO receipts VALUES (?,?,?)', requestId, hash, v.canonical(result)); return result;
  }
  function loadAction(ref: T.ActionRef): T.PreparedAction {
    v.exact(ref, ['id', 'revision', 'actionHash']); v.id(ref.id); v.nat(ref.revision, true); v.hash(ref.actionHash);
    const a = parse<T.PreparedAction>(ledger.get('SELECT json FROM actions WHERE id=? AND revision=?', ref.id, ref.revision));
    if (!a) v.fail('action_not_found');
    const { actionHash, ...body } = a;
    if (actionHash !== ref.actionHash || v.digest('s15.action.v1', body) !== actionHash || v.digest('s15.content.v1', a.payload) !== a.contentHash || v.digest('s15.recipients.v1', a.recipients) !== a.recipientHash || (a.transaction ? v.digest('s15.transaction.v1', a.transaction) : null) !== a.transactionHash) v.fail('hash_mismatch');
    const slot = ledger.get<{ revision: number }>('SELECT revision FROM slots WHERE effect_key=?', a.effectKey);
    if (!slot || slot.revision !== a.revision) v.fail('stale_action'); return a;
  }
  function claimed(a: T.PreparedAction): boolean {
    const key = paymentKey(a);
    return !!ledger.get('SELECT effect_key FROM claims WHERE effect_key=? OR (payment_key IS NOT NULL AND payment_key=?)', a.effectKey, key ?? '');
  }
  function checkAction(w: T.WorkAuthority, a: T.PreparedAction): void {
    if (w.id !== a.workId || a.policyRevision !== w.policyRevision || a.policyHash !== w.policyHash || a.ownerGeneration !== w.ownerGeneration) v.fail('stale_authority');
    if (w.request.intent !== 'execute') v.fail('outside_scope');
    if (time() >= a.expiresAt || (a.transaction && time() >= a.transaction.quoteExpiresAt)) v.fail('expired');
    const adapter = adapters.get(a.adapter); if (!adapter || adapter.version !== a.adapterVersion) v.fail('adapter_unproven');
    if (a.resources.some(x => !v.contains(w.request.resources, x)) || (a.recipients.some(x => !v.contains(w.request.recipients, x)) && !a.classes.some(c => c === 'new_egress' || c === 'disclosure'))) v.fail('outside_scope');
    a.resources.forEach(x => currentRef('resource', x)); a.recipients.forEach(x => currentRef('recipient', x)); a.fences.forEach(x => currentRef(x.kind, x.ref));
    if (!options.catalogs.allows(clone(w), clone(a))) v.fail('outside_scope');
  }
  const unsettled = (): number => ledger.all<{ json: string }>('SELECT json FROM reservations').filter(r => !(JSON.parse(r.json) as T.Reservation).transportSettled).length;
  function budgetCheck(bound: T.BudgetVector | null, continuation: boolean): void {
    const budget = policyCurrent().budget;
    if (!budget) v.fail('finite_budget_required'); if (!bound) v.fail('cost_unknown');
    if (time() < budget.startsAt || time() >= budget.expiresAt) v.fail('expired');
    const charged = ledger.meta<T.BudgetVector>('charged'); if (!charged) v.fail('continuity_unavailable');
    if (ledger.meta('budgetOverrun') || !v.within(charged, budget.ceiling) || (!continuation && !v.within(v.add(charged, bound), budget.ceiling))) v.fail('budget_exhausted');
    if (!continuation && unsettled() >= budget.concurrency) v.fail('capacity_busy');
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
      budgetCheck(a.upperBound, continuation);
      if (!rules.length) return { state: 'hold', code: 'policy_match_required' };
      if (a.impact === 'unknown') return { state: 'hold', code: 'owner_direction_required' };
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
  function reserve(w: T.WorkAuthority, requestId: string, bound: T.BudgetVector, payload: unknown): T.Reservation {
    const key = w.id + ':' + requestId, hash = v.digest('s15.reservation.v1', payload);
    const old = ledger.get<{ hash: string; json: string }>('SELECT hash,json FROM reservations WHERE dedupe=?', key);
    if (old) { if (old.hash !== hash) v.fail('request_id_conflict'); v.fail('reservation_already_claimed'); }
    budgetCheck(bound, false);
    const result: T.Reservation = { id: uid(), workId: w.id, requestId, upperBound: clone(bound), actual: v.unknownUsage(), transportSettled: false, createdAt: time() };
    ledger.put('charged', v.add(ledger.meta<T.BudgetVector>('charged')!, bound));
    ledger.run('INSERT INTO reservations VALUES (?,?,?,?)', result.id, key, hash, v.canonical(result)); return result;
  }
  function settleReservation(id: string, actual: T.Usage, settled: boolean): void {
    v.id(id); v.usage(actual); if (typeof settled !== 'boolean') v.fail('invalid_shape');
    const r = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', id)); if (!r) v.fail('reservation_not_found');
    if (r.transportSettled && !settled) v.fail('settlement_conflict');
    // Keep measured facts monotonic and reject contradictory terminal settlement.
    if (r.transportSettled && !v.equal(r.actual, actual)) v.fail('settlement_conflict');
    for (const k of Object.keys(r.upperBound) as (keyof T.BudgetVector)[]) {
      const a = actual[k]; if (a !== null && BigInt(a) > BigInt(r.upperBound[k])) ledger.put('budgetOverrun', true);
      if (r.actual[k] !== null && (a === null || BigInt(a) < BigInt(r.actual[k]!))) v.fail('settlement_conflict');
    }
    r.actual = clone(actual); r.transportSettled = settled;
    ledger.run('UPDATE reservations SET json=? WHERE id=?', v.canonical(r), id);
  }
  function observe(a: T.PreparedAction, claim: Claim, observation: T.Observation): T.Observation {
    settleReservation(claim.reservationId, observation.actual, observation.transportSettled);
    ledger.run('INSERT INTO observations(action_id,json) VALUES (?,?)', a.id, v.canonical(observation)); return clone(observation);
  }
  function observation(a: T.PreparedAction): T.Observation | null {
    return parse<T.Observation>(ledger.get("SELECT json FROM observations WHERE action_id=? AND json_extract(json,'$.basis')!='owner_statement' ORDER BY seq DESC LIMIT 1", a.id)) ?? (claimed(a) ? { outcome: 'unknown', basis: 'uncertain', code: 'reconciliation_required', actual: v.unknownUsage(), transportSettled: false } : null);
  }
  function checkResult(result: T.AdapterResult): void { v.exact(result, ['outcome', 'actual', 'transportSettled']); if (!['succeeded', 'failed', 'unknown'].includes(result.outcome) || typeof result.transportSettled !== 'boolean' || (result.outcome !== 'unknown' && !result.transportSettled)) v.fail('invalid_adapter_result'); v.usage(result.actual); }
  function savePolicy(input: T.PolicyInput, expectedRevision: number, allowRecurring = false): T.StandingPolicy {
    v.policy(input); v.nat(expectedRevision);
    const old = getPolicy(); if ((old?.revision ?? 0) !== expectedRevision) v.fail('stale_policy');
    if (!allowRecurring && input.rules.some(r => r.mode === 'recurring_payment' && !old?.rules.some(x => v.equal(x, r)))) v.fail('recurring_approval_required');
    if (input.budget) { const currency = ledger.meta<string>('budgetCurrency'); if (currency !== null && currency !== input.budget.currency) v.fail('budget_currency_changed'); ledger.put('budgetCurrency', input.budget.currency); }
    const p: T.StandingPolicy = { ...clone(input), contract: 's15-standing-policy/v1', revision: expectedRevision + 1, ownerGeneration: options.ownerGeneration() };
    v.nat(p.revision, true); if (p.expiresAt <= time()) v.fail('expired');
    for (const r of p.rules) { if (!r.purposes.every(x => v.contains(p.purposes, x)) || !r.bots.every(x => v.contains(p.bots, x)) || !r.resources.every(x => v.contains(p.resources, x)) || !r.recipients.every(x => v.contains(p.recipients, x)) || !r.selections.every(x => v.contains(p.selections, x))) v.fail('outside_scope'); }
    ledger.put('policy', p); ledger.put('policyRevoked', false); return p;
  }
  const owner: T.OwnerPort = {
    authenticate(proof) { return tx(() => { const principal = options.verifyOwner(proof); if (!principal || principal.generation !== options.ownerGeneration() || principal.expiresAt <= time()) v.fail('authentication_required'); v.id(principal.id); v.nat(principal.generation, true); const actor = Object.freeze({}) as T.OwnerActor; owners.set(actor, { proof, id: principal.id, generation: principal.generation }); ownerAuth(actor); return actor; }); },
    current(actor) { return tx(() => { ownerAuth(actor); return clone(getPolicy()); }); },
    install(actor, requestId, expectedRevision, input) { return tx(() => { v.policy(input); return receipt(actor, requestId, { kind: 'policy.install', expectedRevision, input }, () => savePolicy(input, expectedRevision)); }); },
    admit(actor, request) { return tx(() => { v.workRequest(request); return receipt(actor, request.requestId, { kind: 'work.request', request }, () => {
      const p = policyCurrent(); checkRequest(p, request);
      if (time() >= request.expiresAt || request.expiresAt > p.expiresAt || (p.budget && request.expiresAt > p.budget.expiresAt)) v.fail('expired');
      if (request.intent === 'accept_obligation') return { work: null, receiptId: request.requestId };
      const w: T.WorkAuthority = { id: uid(), ownerGeneration: p.ownerGeneration, policyRevision: p.revision, policyHash: v.digest('s15.policy.v1', p), request: clone(request), createdAt: time(), expiresAt: request.expiresAt };
      if (!options.catalogs.allows(clone(w), null)) v.fail('outside_scope');
      ledger.run('INSERT INTO works(id,json) VALUES (?,?)', w.id, v.canonical(w)); return { work: w, receiptId: request.requestId };
    }); }); },
    decide(actor, input) { tx(() => { v.exact(input, ['requestId', 'action', 'decision', 'expiresAt']); v.id(input.requestId); v.nat(input.expiresAt, true); if (!['approve', 'deny'].includes(input.decision)) v.fail('invalid_shape'); receipt(actor, input.requestId, { kind: 'action.decide', input }, () => {
      const a = loadAction(input.action), w = currentWork(a.workId); checkAction(w, a); if (claimed(a)) v.fail('already_claimed');
      if (input.expiresAt > a.expiresAt || input.expiresAt <= time()) v.fail('expired');
      const evaluated = evaluate(w, a); if (evaluated.state === 'deny' || evaluated.state === 'unsupported' || (evaluated.state === 'hold' && ['policy_match_required', 'snapshot_required', 'cost_unknown', 'finite_budget_required'].includes(evaluated.code))) v.fail(evaluated.code);
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
    inspect(actor, ref) { return tx(() => { ownerAuth(actor); const a = loadAction(ref); return { action: clone(a), observation: observation(a) }; }); },
    async reconcile(actor, ref, requestId) {
      const start = tx(() => {
        ownerAuth(actor); const a = loadAction(ref); const claim = parse<Claim>(ledger.get('SELECT json FROM claims WHERE action_id=?', a.id)); if (!claim) v.fail('reconciliation_required');
        const adapter = adapters.get(a.adapter); if (!adapter?.reconcile) v.fail('adapter_unproven');
        const existing = observation(a); if (existing && existing.outcome !== 'unknown') return { a, claim, adapter, result: existing, reservation: null };
        const w = parse<T.WorkAuthority>(ledger.get('SELECT json FROM works WHERE id=?', a.workId)); if (!w) v.fail('authority_revoked');
        const p = policyCurrent(); checkRequest(p, w.request);
        a.resources.forEach(r => { if (!v.contains(p.resources, r)) v.fail('outside_scope'); currentRef('resource', r); });
        a.recipients.forEach(r => { if (!v.contains(p.recipients, r)) v.fail('outside_scope'); currentRef('recipient', r); });
        if (!options.catalogs.allows(clone(w), clone(a))) v.fail('outside_scope');
        const bound = { ...v.zero(), calls: 1, reads: 1 };
        const reservation = reserve(w, requestId, bound, { kind: 'reconcile', action: ref });
        return { a, claim, adapter, result: null, reservation };
      });
      if (start.result) return start.result;
      let result: T.AdapterResult;
      try { result = await start.adapter.reconcile!(clone(start.a)); checkResult(result); } catch { result = { outcome: 'unknown', actual: v.unknownUsage(), transportSettled: false }; }
      const observed: T.Observation = { ...clone(result), basis: result.outcome === 'unknown' ? 'uncertain' : 'remote_verified', code: result.outcome === 'unknown' ? 'reconciliation_required' : null };
      return tx(() => { settleReservation(start.reservation!.id, result.actual, result.transportSettled); return observe(start.a, start.claim, observed); });
    },
    recordStatement(actor, ref, requestId, outcome) { tx(() => { if (!['occurred', 'did_not_occur'].includes(outcome)) v.fail('invalid_shape'); receipt(actor, requestId, { kind: 'effect.statement', ref, outcome }, () => { const a = loadAction(ref); if (!claimed(a)) v.fail('reconciliation_required'); ledger.run('INSERT INTO observations(action_id,json) VALUES (?,?)', a.id, v.canonical({ outcome: 'unknown', basis: 'owner_statement', code: outcome, actual: v.unknownUsage(), transportSettled: false })); return { recorded: true }; }); }); },
  };
  const work: T.WorkPort = {
    guard(actor) { return tx(() => clone(workAuth(actor))); },
    reserveModelCall(actor, input) { return tx(() => { v.exact(input, ['requestId', 'selection', 'upperBound']); v.id(input.requestId); v.selection(input.selection); v.vector(input.upperBound); if (input.upperBound.calls < 1) v.fail('cost_unknown'); const w = workAuth(actor), p = policyCurrent(); if (!v.contains(p.selections, input.selection) || (w.request.selectionPin && !v.equal(w.request.selectionPin, input.selection))) v.fail('selection_pinned'); currentRef('route', input.selection.route); currentRef('model', input.selection.model); if (!options.catalogs.allows({ ...clone(w), request: { ...clone(w.request), selection: clone(input.selection) } }, null)) v.fail('outside_scope'); const r = reserve(w, input.requestId, input.upperBound, input); r.selection = clone(input.selection); ledger.run('UPDATE reservations SET json=? WHERE id=?', v.canonical(r), r.id); return clone(r); }); },
    guardReservation(actor, reservationId) { return tx(() => {
      const w = workAuth(actor); v.id(reservationId); const r = parse<T.Reservation>(ledger.get('SELECT json FROM reservations WHERE id=?', reservationId));
      if (!r || r.workId !== w.id || r.transportSettled || !r.selection) v.fail('reservation_not_found');
      const p = policyCurrent(); if (!v.contains(p.selections, r.selection) || (w.request.selectionPin && !v.equal(w.request.selectionPin, r.selection))) v.fail('selection_pinned');
      currentRef('route', r.selection.route); currentRef('model', r.selection.model); budgetCheck(r.upperBound, true);
      if (!options.catalogs.allows({ ...clone(w), request: { ...clone(w.request), selection: clone(r.selection) } }, null)) v.fail('outside_scope'); return clone(r);
    }); },
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
        const claim: Claim = { action: actionRef(a), reservationId: reservation.id, decision, createdAt: time() };
        ledger.run('INSERT INTO claims VALUES (?,?,?,?,?)', a.effectKey, a.id, paymentKey(a), reservation.id, v.canonical(claim));
        for (const ruleId of decision.rules) { const rule = policyCurrent().rules.find(r => r.id === ruleId)!; if (rule.mode === 'recurring_payment') { const used = ledger.get<{ count: number; amount_minor: string }>('SELECT * FROM recurring_usage WHERE id=?', ruleId); ledger.run('INSERT INTO recurring_usage VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET count=excluded.count,amount_minor=excluded.amount_minor,last_at=excluded.last_at', ruleId, (used?.count ?? 0) + 1, (BigInt(used?.amount_minor ?? '0') + BigInt(a.transaction!.amountMinor)).toString(), time()); } }
        return { a, claim, adapter: adapters.get(a.adapter)! };
      });
      let consumed = false, started = false, pending: Promise<T.AdapterResult> | null = null;
      const context: T.DispatchContext = Object.freeze({ commit(finalPayload: T.JsonValue, send: () => Promise<T.AdapterResult>): Promise<T.AdapterResult> {
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
          return tx(() => observe(a, claim, safe));
        }
        result = { outcome: 'unknown', actual: v.unknownUsage(), transportSettled: false };
      } finally { consumed = true; }
      const observed: T.Observation = { ...clone(result), basis: result.outcome === 'unknown' ? 'uncertain' : 'remote_verified', code: result.outcome === 'unknown' ? 'reconciliation_required' : null };
      return tx(() => observe(a, claim, observed));
    },
  };
  const control: T.ControlPort = {
    bindWork(workId) { return tx(() => { v.id(workId); currentWork(workId); const actor = Object.freeze({}) as T.WorkActor; workers.set(actor, workId); return actor; }); },
    settleReservation(id, usage, transportSettled) { tx(() => settleReservation(id, usage, transportSettled)); },
    publishable(actor, ref) { return tx(() => { const w = workAuth(actor), a = loadAction(ref); checkAction(w, a); const result = observation(a); if (!result) v.fail('observation_required'); return clone(result); }); },
    usage() { return tx(() => ({ charged: clone(ledger.meta<T.BudgetVector>('charged')!), unsettled: unsettled() })); },
    close() { if (!closed) { closed = true; ledger.db.close(); } },
  };
  return Object.freeze({ owner: Object.freeze(owner), work: Object.freeze(work), control: Object.freeze(control) });
}

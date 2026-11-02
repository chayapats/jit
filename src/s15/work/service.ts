import { DurableJournal } from '../durable-journal';
import { summarizeReservations } from '../model/usage';
import { canonical, digest, exact, fail, id, nat, string, usage } from '../policy/validation';
import type { OwnerActor, WorkAuthority } from '../policy';
import type { AttemptHandle, AttemptSettlement, Responsibility, ResponsibilityEvent, ResponsibilityPort, ResponsibilityProjection, StallReport, WorkAttempt, WorkOptions } from './types';

const clone = <T>(v: T): T => JSON.parse(canonical(v)) as T;
const kinds = ['ci', 'review', 'owner', 'schedule', 'assigned'];
function evidence(refs: string[]): void { if (!Array.isArray(refs) || refs.length > 64 || new Set(refs).size !== refs.length) fail('invalid_shape'); refs.forEach(id); }
function observation(o: AttemptSettlement): void {
  exact(o, ['transportSettled', 'executionSettled', 'effects', 'progress', 'evidenceRefs', 'recommendation', 'usage'], ['complete', 'basis']);
  if (o.basis !== undefined && !['remote_verified', 'owner_statement', 'uncertain'].includes(o.basis)) fail('invalid_shape');
  if (typeof o.transportSettled !== 'boolean' || typeof o.executionSettled !== 'boolean' || !['known', 'unknown'].includes(o.effects) || !['none', 'made'].includes(o.progress) || (o.complete !== undefined && typeof o.complete !== 'boolean')) fail('invalid_shape');
  evidence(o.evidenceRefs); string(o.recommendation, 4096); if (!o.recommendation) fail('recommendation_required'); usage(o.usage);
  if (o.progress === 'made' && !o.evidenceRefs.length) fail('progress_evidence_required');
  if (o.complete && (!o.transportSettled || !o.executionSettled || o.effects !== 'known' || o.progress !== 'made')) fail('completion_evidence_required');
}

/** Opens a fresh opt-in protected responsibility journal. Waiting never creates a host/session.
 * Reopening converts only active attempts to unknown; durable waits and settled evidence survive.
 * POLICY and owning transports retain actual effect/VM capacity independently of these projections. */
export function openWorkService(options: WorkOptions): ResponsibilityPort & { list(owner: OwnerActor): ResponsibilityProjection[]; close(): void } {
  if (options.runtime !== 's15') fail('s15_opt_in_required');
  const journal = new DurableJournal(options.path, options.installationId, options.create, 0x4a575135);
  const now = () => { const value = (options.now ?? Date.now)(); nat(value); return value; };
  const handles = new WeakMap<AttemptHandle, { responsibilityId: string; attemptId: string; controller: AbortController }>();
  const running = new Map<string, AbortController>();
  function current(r: Responsibility): WorkAuthority {
    if (r.stopRequested) fail('stopped');
    if (!r.workId) fail('execution_not_authorized');
    return options.policy.work.guard(options.policy.control.bindWork(r.workId));
  }
  function save(r: Responsibility): Responsibility { r.updatedAt = Math.max(r.updatedAt, now()); journal.put(r.id, r); return clone(r); }
  function ownerCheck(owner: Parameters<ResponsibilityPort['project']>[0], r: Responsibility): void {
    const p = options.policy.owner.current(owner);
    if (!p || p.ownerGeneration !== r.ownerGeneration) fail('authentication_required');
  }
  function held(r: Responsibility): boolean { return r.attempts.some(a => a.capacityHeld || a.state === 'unknown'); }
  function pause(r: Responsibility, code: StallReport['code'], recommendation: string): void {
    r.state = 'paused'; r.wait = null;
    r.report = { code, at: Math.max(now(), r.updatedAt), attempts: r.attempts.map(a => ({ id: a.id, approach: a.approach, evidenceRefs: [...a.evidenceRefs], progress: a.progress })), recommendation, otherAuthorizedWorkContinues: true };
  }
  function stall(r: Responsibility, recommendation: string): void {
    let count = new Set<string>();
    for (const a of r.attempts.slice(r.stallCheckpoint)) { if (a.progress === 'made') count = new Set(); else if (a.progress === 'none' && a.state === 'settled') count.add(a.approach); }
    const remaining = r.workId ? options.remainingCalls(r.workId) : null;
    if (remaining !== null) nat(remaining);
    if (count.size >= r.stallPolicy.noProgressApproaches) pause(r, 'no_progress', recommendation);
    else if (r.attempts.length >= r.stallPolicy.maxAttempts) pause(r, 'attempt_limit', recommendation);
    else if (remaining !== null && remaining <= r.stallPolicy.reserveCalls) pause(r, 'budget_headroom', recommendation);
  }
  journal.tx(() => {
    for (const r of journal.all<Responsibility>()) {
      for (const a of r.attempts) if (a.state === 'active') { a.state = 'unknown'; a.publicationFenced = true; }
      if (r.state === 'working') r.state = r.stopRequested ? 'stopping' : 'reconcile_only';
      r.resumedAfterRestart = true; save(r);
    }
  });
  function settle(r: Responsibility, a: WorkAttempt, o: AttemptSettlement, recovered: boolean): Responsibility {
    observation(o);
    if (recovered) {
      const basis = o.basis ?? 'uncertain';
      if (basis === 'remote_verified' && !o.evidenceRefs.length) fail('reconciliation_evidence_required');
      a.reconciliation = { basis, at: now(), effects: o.effects, complete: o.complete === true, evidenceRefs: [...o.evidenceRefs] };
      a.publicationFenced = true;
      if (basis !== 'remote_verified') {
        // Retain the labelled statement without upgrading remote/settlement/progress facts.
        r.state = r.stopRequested ? 'stopping' : 'reconcile_only'; return save(r);
      }
    }
    if (a.state === 'settled') {
      if (canonical({ progress: a.progress, evidenceRefs: a.evidenceRefs, recommendation: a.recommendation, usage: a.usage }) !== canonical({ progress: o.progress, evidenceRefs: o.evidenceRefs, recommendation: o.recommendation, usage: o.usage })) fail('settlement_conflict');
      return clone(r);
    }
    // Facts may advance after stop/revoke; neither current authority nor a new dispatch is required.
    for (const k of Object.keys(a.usage) as (keyof typeof a.usage)[]) if (a.usage[k] !== null && (o.usage[k] === null || BigInt(o.usage[k]!) < BigInt(a.usage[k]!))) fail('settlement_conflict');
    if ((a.transportSettled && !o.transportSettled) || (a.executionSettled && !o.executionSettled) || (a.effects === 'known' && o.effects !== 'known') || (a.progress === 'made' && o.progress !== 'made')) fail('settlement_conflict');
    a.transportSettled = o.transportSettled; a.executionSettled = o.executionSettled; a.effects = o.effects;
    a.capacityHeld = !o.transportSettled || !o.executionSettled; a.endedAt = Math.max(a.startedAt, now()); a.usage = clone(o.usage);
    a.state = !a.capacityHeld && o.effects === 'known' ? 'settled' : 'unknown';
    a.progress = o.progress; a.evidenceRefs = [...new Set([...a.evidenceRefs, ...o.evidenceRefs])]; a.recommendation = o.recommendation;
    a.publicationFenced ||= recovered || r.stopRequested || a.state === 'unknown';
    if (r.stopRequested) r.state = held(r) ? 'stopping' : 'stopped';
    else if (held(r)) r.state = 'reconcile_only';
    // Closing a verified historical obligation is independent of execution/publication authority.
    else if (recovered && o.basis === 'remote_verified' && o.complete) r.state = 'completed';
    else {
      try { current(r); }
      catch { a.publicationFenced = true; r.state = 'paused'; return save(r); }
      r.state = o.complete && !a.publicationFenced ? 'completed' : 'ready';
      if (r.state !== 'completed') stall(r, o.recommendation);
    }
    return save(r);
  }
  const service: ResponsibilityPort & { list(owner: OwnerActor): ResponsibilityProjection[]; close(): void } = {
    assign(owner, input) { return journal.tx(() => {
      options.policy.owner.current(owner); exact(input, ['requestId', 'sourceRequestId', 'completion', 'triggers', 'stallPolicy']);
      id(input.requestId); id(input.sourceRequestId); string(input.completion); if (!input.completion) fail('completion_required');
      exact(input.stallPolicy, ['noProgressApproaches', 'reserveCalls', 'maxAttempts']);
      nat(input.stallPolicy.noProgressApproaches, true); nat(input.stallPolicy.reserveCalls, true); nat(input.stallPolicy.maxAttempts, true);
      if (input.stallPolicy.noProgressApproaches < 2 || input.stallPolicy.maxAttempts > 64 || input.stallPolicy.noProgressApproaches > input.stallPolicy.maxAttempts) fail('invalid_stall_policy');
      if (!Array.isArray(input.triggers) || input.triggers.some(k => !kinds.includes(k)) || input.triggers.length > 5 || new Set(input.triggers).size !== input.triggers.length) fail('invalid_shape');
      const source = options.conversation.view(owner, input.sourceRequestId);
      if (!['accept', 'inspect', 'execute'].includes(source.intent.kind) || source.state === 'stopped') fail('execution_not_authorized');
      if (source.intent.kind !== 'accept' && !source.authority) fail('execution_not_authorized');
      if (source.authority && source.state !== 'completed') fail('source_reconciliation_required');
      return journal.once(input.requestId, digest('s15.work.assign.v1', input), () => {
        if (journal.all<Responsibility>().some(r => r.sourceRequestId === source.receipt.rootRequestId)) fail('responsibility_exists');
        const work = source.authority ? options.policy.work.guard(options.policy.control.bindWork(source.authority.id)) : null;
        if (work && journal.all<Responsibility>().some(r => r.workId === work.id)) fail('responsibility_exists');
        const r: Responsibility = { contract: 's15-responsibility/v1', id: digest('s15.work.source.v1', source.receipt.rootRequestId), sourceRequestId: source.receipt.rootRequestId, conversationId: source.receipt.conversationId, originalText: source.command.text,
          ownerGeneration: source.owner.generation, workId: work?.id ?? null, purpose: work?.request.purpose ?? null, resources: clone(work?.request.resources ?? []), subject: source.intent.subject, completion: input.completion,
          triggers: [...input.triggers], stallPolicy: clone(input.stallPolicy), state: work ? 'ready' : 'accepted', wait: null, attempts: [], report: null, proposals: [], readyEventId: source.receipt.rootRequestId,
          stallCheckpoint: 0, stopRequested: false, resumedAfterRestart: false, createdAt: now(), updatedAt: now() };
        return save(r);
      });
    }); },
    beginAttempt(responsibilityId, input) { const handle = journal.tx(() => {
      exact(input, ['eventId', 'approach']); id(input.eventId); string(input.approach); if (!input.approach) fail('approach_required');
      const r = journal.get<Responsibility>(responsibilityId); current(r);
      if (r.state !== 'ready' || held(r) || r.readyEventId !== input.eventId || r.attempts.some(a => a.eventId === input.eventId)) fail('attempt_not_ready');
      stall(r, 'Review the recorded approaches and choose a materially different next step.');
      if (r.state !== 'ready') { save(r); return null; }
      const a: WorkAttempt = { id: digest('s15.work.attempt.v1', { responsibilityId, eventId: input.eventId }), eventId: input.eventId, approach: input.approach, startedAt: now(), endedAt: null, state: 'active', capacityHeld: true, transportSettled: false, executionSettled: false, effects: 'unknown', publicationFenced: false, progress: 'unknown', evidenceRefs: [], recommendation: null, usage: { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null }, reconciliation: null };
      r.attempts.push(a); r.state = 'working'; r.wait = null; r.readyEventId = null; save(r);
      const handle = Object.freeze({}) as AttemptHandle, controller = new AbortController(); handles.set(handle, { responsibilityId, attemptId: a.id, controller }); running.set(a.id, controller); return handle;
    }); if (!handle) fail('work_paused'); return handle; },
    wait(responsibilityId, input) { return journal.tx(() => {
      exact(input, ['requestId', 'kind', 'key', 'evidenceRefs']); id(input.requestId); id(input.key); evidence(input.evidenceRefs);
      if (!['ci', 'review', 'owner', 'schedule'].includes(input.kind)) fail('invalid_shape');
      const r = journal.get<Responsibility>(responsibilityId); current(r);
      return journal.once(input.requestId, digest('s15.work.wait.v1', { responsibilityId, input }), () => {
        if (held(r) || !['ready', 'waiting'].includes(r.state)) fail('settlement_required');
        r.wait = { kind: input.kind, key: input.key, evidenceRefs: [...input.evidenceRefs], since: now() }; r.state = 'waiting'; r.readyEventId = null; return save(r);
      });
    }); },
    observeEvent(responsibilityId, input) { return journal.tx(() => {
      exact(input, ['eventId', 'kind', 'key', 'purposeId', 'resourceIds', 'subject', 'evidenceRefs']); id(input.eventId); id(input.key); id(input.purposeId); evidence(input.resourceIds); evidence(input.evidenceRefs); if (input.subject !== null) string(input.subject);
      if (!kinds.includes(input.kind)) fail('invalid_shape'); const r = journal.get<Responsibility>(responsibilityId);
      if (r.stopRequested) fail('stopped');
      return journal.once('ev_' + digest('s15.work.event.id.v1', { responsibilityId, eventId: input.eventId }), digest('s15.work.event.v1', input), () => {
        if (input.purposeId !== r.purpose?.id || input.subject !== r.subject || input.resourceIds.some(resource => !r.resources.some(ref => ref.id === resource))) {
          r.proposals.push({ eventId: input.eventId, code: 'outside_purpose', evidenceRefs: [...input.evidenceRefs] }); return save(r);
        }
        current(r);
        if (!r.triggers.includes(input.kind)) fail('trigger_not_authorized');
        if (r.state === 'waiting' && r.wait?.kind === input.kind && r.wait.key === input.key) { r.state = 'ready'; r.wait = null; r.readyEventId = input.eventId; }
        else if (r.state === 'ready' && r.readyEventId === null) r.readyEventId = input.eventId;
        // Paused work requires an authenticated owner resume, not a CI/review or model instruction.
        return save(r);
      });
    }); },
    settle(handle, o) { return journal.tx(() => { const h = handle && handles.get(handle); if (!h) fail('attempt_context_lost'); const r = journal.get<Responsibility>(h.responsibilityId), a = r.attempts.find(a => a.id === h.attemptId); if (!a) fail('attempt_context_lost'); const result = settle(r, a, o, false); if (!a.capacityHeld) running.delete(a.id); return result; }); },
    reconcile(responsibilityId, attemptId, o) { return journal.tx(() => { id(attemptId); const r = journal.get<Responsibility>(responsibilityId), a = r.attempts.find(a => a.id === attemptId); if (!a || a.state !== 'unknown') fail('reconciliation_required'); return settle(r, a, o, true); }); },
    stop(owner, responsibilityId, requestId) { return journal.tx(() => {
      id(requestId); const r = journal.get<Responsibility>(responsibilityId); ownerCheck(owner, r);
      // Revoke before committing the projection; crash in between leaves policy fenced, never live work.
      if (r.workId) options.policy.owner.revoke(owner, 'ws_' + digest('s15.work.stop.v1', { responsibilityId, requestId }), { kind: 'work', id: r.workId });
      r.stopRequested = true; r.wait = null; r.readyEventId = null; r.attempts.forEach(a => { a.publicationFenced = true; }); r.state = held(r) ? 'stopping' : 'stopped'; return save(r);
    }); },
    resume(owner, responsibilityId, sourceRequestId) { return journal.tx(() => {
      id(sourceRequestId); const r = journal.get<Responsibility>(responsibilityId); ownerCheck(owner, r); current(r);
      const source = options.conversation.view(owner, sourceRequestId);
      const scope = source.intent.scope;
      if (r.state !== 'paused' || held(r) || source.intent.kind !== 'execute' || source.receipt.conversationId !== r.conversationId || source.intent.subject !== r.subject || !scope || scope.purposeId !== r.purpose?.id || scope.resourceIds.some(id => !r.resources.some(ref => ref.id === id))) fail('outside_scope');
      if (sourceRequestId === r.sourceRequestId || !r.report || source.receipt.receivedAt <= r.report.at) fail('fresh_instruction_required');
      if (source.state !== 'completed' || source.code !== null || !source.authority || source.owner.generation !== r.ownerGeneration) fail('execution_not_authorized');
      options.policy.work.guard(options.policy.control.bindWork(source.authority.id));
      return journal.once('rs_' + digest('s15.work.resume.id.v1', { responsibilityId, sourceRequestId }), digest('s15.work.resume.v1', { responsibilityId, sourceRequestId }), () => {
        r.state = 'ready'; r.stallCheckpoint = r.attempts.length; r.readyEventId = sourceRequestId; r.updatedAt = Math.max(r.updatedAt, source.receipt.receivedAt); return save(r);
      });
    }); },
    guard(handle) { journal.tx(() => {
      const h = handle && handles.get(handle); if (!h) fail('attempt_context_lost'); const r = journal.get<Responsibility>(h.responsibilityId), a = r.attempts.find(a => a.id === h.attemptId);
      current(r); if (!a || a.state !== 'active' || a.publicationFenced || r.state !== 'working') fail('attempt_not_active');
    }); },
    signal(handle) { const h = handle && handles.get(handle); if (!h) fail('attempt_context_lost'); return h.controller.signal; },
    publish(handle, consume) { journal.tx(() => {
      const h = handle && handles.get(handle); if (!h) fail('attempt_context_lost'); const r = journal.get<Responsibility>(h.responsibilityId), a = r.attempts.find(a => a.id === h.attemptId);
      current(r); if (!a || a.state !== 'settled' || a.publicationFenced || a.capacityHeld) fail('publication_withheld'); consume(clone(a));
    }); },
    project(owner, responsibilityId): ResponsibilityProjection { return journal.tx(() => {
      const r = journal.get<Responsibility>(responsibilityId); ownerCheck(owner, r);
      const totals = summarizeReservations(r.workId ? options.policy.control.reservations(r.workId) : []);
      return { ...clone(r), budget: { ...totals, charged: { ...totals.charged, spendMinor: options.policy.owner.current(owner)?.budget ? totals.charged.spendMinor : null } }, stopImpact: { responsibilityIds: [r.id], heldAttempts: r.attempts.filter(a => a.capacityHeld).map(a => a.id), otherResponsibilities: journal.all<Responsibility>().filter(other => other.id !== r.id && !['stopped', 'completed'].includes(other.state)).length } };
    }); },
    list(owner): ResponsibilityProjection[] {
      const p = journal.tx(() => options.policy.owner.current(owner));
      if (!p) fail('authentication_required');
      // Newest first, bounded; other owner generations are never listed and the read starts nothing.
      const ids = journal.tx(() => journal.all<Responsibility>().filter(r => r.ownerGeneration === p.ownerGeneration).map(r => r.id)).reverse().slice(0, 64);
      return ids.map(id => service.project(owner, id));
    },
    close() { for (const controller of running.values()) controller.abort(); running.clear(); journal.close(); },
  };
  const stop = service.stop;
  service.stop = (owner, responsibilityId, requestId) => {
    const result = stop(owner, responsibilityId, requestId);
    // Dispatch of abort listeners follows the durable stop fence and never holds the journal writer lock.
    for (const attempt of result.attempts) running.get(attempt.id)?.abort();
    return result;
  };
  return service;
}

import type { WorkingVmPort, VmSession } from '../vm';
import type { VmStore } from '../vm/store';
import type { WorkActor } from '../policy';
import type { TeamService } from './service';
import type { TeamLeaseSubject } from './types';

type VmSubject = Extract<TeamLeaseSubject, { kind: 'vm_session' }>;

/**
 * Protected stop proof for a linked working-VM subject, read only from the VM service's own journal.
 * A session counts as stopped when it is closed and every claim carries `vm_stopped` (hypervisor stop
 * recorded by protected recovery) or `guest_scope_empty` over a closed transport.
 * A closed session with no claim never dispatched guest work. With no session id yet, every session of
 * the exact attempt must be proven; an attempt that never opened a session holds nothing. Open, stopping
 * or unknown sessions are never proof, so unproven cleanup never releases the lease.
 */
export function vmSessionStopped(store: VmStore, subject: VmSubject): boolean {
  const rows = subject.sessionId
    ? store.db.query<{ id: string; state: string; generation: number }, [string, string, string, string]>('SELECT id,state,generation FROM vm_sessions WHERE id=? AND vm_id=? AND work_id=? AND attempt_id=?').all(subject.sessionId, subject.vmId, subject.workId, subject.attemptId)
    : store.db.query<{ id: string; state: string; generation: number }, [string, string, string]>('SELECT id,state,generation FROM vm_sessions WHERE vm_id=? AND work_id=? AND attempt_id=?').all(subject.vmId, subject.workId, subject.attemptId);
  if (subject.sessionId && rows.length !== 1) return false;
  return rows.every(row => {
    if (row.state !== 'closed') return false;
    return store.evidence(row.id).every(e => e.execution === 'vm_stopped' || e.execution === 'guest_scope_empty' && e.transport === 'closed');
  });
}

/** Protected reconciliation pass for every unknown TEAM lease linked to a working-VM session. */
export function reconcileVmLeases(team: TeamService, store: VmStore): string[] {
  return team.reconcileSubjects('vm_session', subject => vmSessionStopped(store, subject));
}

/** Hold the TEAM workspace coordination fence for an entire real VM session, including background
 * process cleanup. A returned tool/model message cannot release the lock. The lease is durably linked to
 * its VM attempt/session, so unknown cleanup stays fenced until the VM journal holds protected stop proof
 * (guest scope empty, or hypervisor stop from owner recovery), including after restart. */
export function coordinateWorkingVm(vm: WorkingVmPort, team: TeamService, resourceId: string, store: VmStore): WorkingVmPort {
  return { async openAttempt(actor, input) {
    const context = team.bind(actor as WorkActor);
    if (input.access === 'inspect') { team.resource(context, resourceId, 'read'); return vm.openAttempt(actor, input); }
    const lease = team.acquire(context, [resourceId], 'write', 3600000);
    const ready = Promise.withResolvers<VmSession>(), closed = Promise.withResolvers<void>();
    const subject: VmSubject = { kind: 'vm_session', vmId: input.vmId, workId: input.workId, attemptId: input.attemptId, sessionId: null };
    const lifecycle = team.dispatch(lease, async () => {
      let session: VmSession;
      // Linked before any VM I/O: a crash from here on is reconciled against the VM journal.
      team.link(lease, subject);
      try { session = await vm.openAttempt(actor, input); team.link(lease, { ...subject, sessionId: session.id }); ready.resolve(session); }
      catch (error) { ready.reject(error); throw error; }
      await closed.promise;
      return { value: undefined, settled: vmSessionStopped(store, { ...subject, sessionId: session.id }) };
    });
    // Retention is intentional; a failed open/cleanup is visible in TEAM's protected journal until the
    // VM journal itself proves the session stopped.
    void lifecycle.catch(() => { try { reconcileVmLeases(team, store); } catch { /* Stays fenced. */ } });
    const session = await ready.promise;
    let closing: Promise<void> | null = null;
    return { ...session, definitions: session.definitions.map(definition => ({ ...definition, async execute(value, call) { team.guardLease(lease); const result = await definition.execute(value, call); team.guardLease(lease); return result; } })),
      cancel: () => session.cancel(), close: () => closing ??= (async () => { try { await session.close(); } finally { closed.resolve(); } await lifecycle; })() };
  } };
}

import type { WorkingVmPort, VmSession } from '../vm';
import type { WorkActor } from '../policy';
import type { TeamService } from './service';

/** Hold the TEAM workspace coordination fence for an entire real VM session, including background
 * process cleanup. A returned tool/model message cannot release the lock. Unknown cleanup remains
 * durable and requires protected reconciliation; expiry/restart never silently steals the lease. */
export function coordinateWorkingVm(vm: WorkingVmPort, team: TeamService, resourceId: string): WorkingVmPort {
  return { async openAttempt(actor, input) {
    const context = team.bind(actor as WorkActor);
    if (input.access === 'inspect') { team.resource(context, resourceId, 'read'); return vm.openAttempt(actor, input); }
    const lease = team.acquire(context, [resourceId], 'write', 3600000);
    const ready = Promise.withResolvers<VmSession>(), closed = Promise.withResolvers<void>();
    const lifecycle = team.dispatch(lease, async () => {
      let session: VmSession;
      try { session = await vm.openAttempt(actor, input); ready.resolve(session); }
      catch (error) { ready.reject(error); throw error; }
      await closed.promise;
      const evidence = session.evidence();
      return { value: undefined, settled: evidence.length > 0 && evidence.every(row => row.execution === 'guest_scope_empty' && row.transport === 'closed') };
    });
    // Retention is intentional; a failed open/cleanup is visible in TEAM's protected journal.
    void lifecycle.catch(() => {});
    const session = await ready.promise;
    let closing: Promise<void> | null = null;
    return { ...session, definitions: session.definitions.map(definition => ({ ...definition, async execute(value, call) { team.guardLease(lease); const result = await definition.execute(value, call); team.guardLease(lease); return result; } })),
      cancel: () => session.cancel(), close: () => closing ??= (async () => { try { await session.close(); } finally { closed.resolve(); } await lifecycle; })() };
  } };
}

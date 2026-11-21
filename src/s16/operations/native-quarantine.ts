import { createHost, MAX_SNAPSHOT_SESSIONS, type HostRuntime, type HostSessionSnapshot } from 'schway/host';
import { AppError } from '../../errors';
import { canonical } from '../../s15/conversation/validation';

/** Trusted owning guard must bind original private scratch inodes and authenticated snapshot provenance. */
export interface S16NativeQuarantineOptions {
  workspaceRoot: string; homeDirectory: string; sessionDirectory: string; snapshot: HostSessionSnapshot;
  guard(): void; retain(host: HostRuntime): void; release(host: HostRuntime): Promise<void>; beforeRestore?(): void;
}
/** Verifies opaque saved ancestry through public APIs in original scratch, allowing identical partial retry. */
export async function verifyS16NativeQuarantine(options: S16NativeQuarantineOptions): Promise<void> {
  const guard = () => { if ((options.guard() as unknown) !== undefined) throw new AppError('s16_ops_guard_invalid', 409); }; guard();
  const { snapshot } = options, host = await createHost({ workspaceRoot: options.workspaceRoot, homeDirectory: options.homeDirectory, sessionDirectory: options.sessionDirectory,
    context: { policy: 'strict', systemPrompt: 'Protected native quarantine verification only.', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' },
    limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } });
  // Register the actual returned handle before any caller hook, guard or opaque restore can fail.
  options.retain(host);
  try {
    guard(); if ((options.beforeRestore?.() as unknown) !== undefined) throw new AppError('s16_ops_guard_invalid', 409); guard();
    const result = await host.restoreSessionSnapshot(snapshot, { excludeRetired: false }); guard();
    if (result.status !== 'restored' || canonical([...result.sessions].sort((a, b) => a.id.localeCompare(b.id))) !== canonical(snapshot.sessions.map(session => ({ id: session.id, branchId: session.branchId })).sort((a, b) => a.id.localeCompare(b.id)))) throw new AppError('s16_ops_native_quarantined', 409);
    const actual = await host.listSessions({ limit: MAX_SNAPSHOT_SESSIONS }); guard();
    if (actual.next !== undefined || actual.sessions.length !== snapshot.sessions.length || actual.sessions.some(row => !snapshot.sessions.some(session => session.id === row.reference.id && row.state === (session.retired ? 'retired' : 'active')))) throw new AppError('s16_ops_native_quarantined', 409);
  } finally { await options.release(host); }
  guard();
}

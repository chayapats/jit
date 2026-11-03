import { credentialReferenceForRoute, HostError, type HostAuthRoute, type HostCredentialLifecycle, type HostCredentialWriteGuard } from 'schway/host';
import { fail } from '../policy/validation';

/**
 * Credential write fence for every S15 route host, renewal and listing. It checks credential OWNERSHIP only: the
 * write must target exactly the credential identity of the route this host serves. It never consults work
 * authority, cancellation or service shutdown. A renewal whose response arrives after its work was cancelled, or
 * while the service is closing, must still store the provider's rotated refresh token; refusing it would make
 * Schway discard that token and force a new sign-in. Work fencing stays at the call sites and in `authorizeDispatch`.
 */
export function routeCredentialGuard(route: HostAuthRoute): HostCredentialWriteGuard {
  const expected = credentialReferenceForRoute(route);
  return identity => { if (identity.account !== expected.account || identity.label !== expected.label) fail('credential_owner_mismatch'); };
}

/** Upper bound for closing a credential lifecycle at shutdown. It covers Schway's 30-second refresher timeout and
 * the store write, and stays well below the S15 unit's `TimeoutStopSec=60` (ops/package/installer/s15.ts) so the
 * rest of shutdown still fits before systemd sends SIGKILL. */
export const CREDENTIAL_CLOSE_BOUND_MS = 35_000;

/** Durable shutdown log line for a lifecycle that could not close in time; it carries no credential data. */
export const reportCredentialClose = (code: 'credential_close_incomplete'): void => { console.error(JSON.stringify({ event: code, contract: 's15-model-selection/v1' })); };

/**
 * Close a credential lifecycle its creator owns. `busy` means a renewal whose caller stopped waiting is still storing
 * a possibly rotated token, so the close is retried (bounded by `boundMs`, total, backoff included) instead of
 * abandoning that token. Never rejects, so shutdown continues. Resolves `closed`, or `credential_close_incomplete`
 * (reported through `report`) when it gave up still busy or the close failed otherwise.
 */
export async function closeCredentialLifecycle(lifecycle: HostCredentialLifecycle, boundMs = CREDENTIAL_CLOSE_BOUND_MS,
  report: typeof reportCredentialClose = reportCredentialClose): Promise<'closed' | 'credential_close_incomplete'> {
  const started = performance.now();
  for (let wait = 25; ; wait = Math.min(wait * 2, 1000)) {
    try { await lifecycle.close(); return 'closed'; }
    catch (error) {
      const remaining = boundMs - (performance.now() - started);
      if (!(error instanceof HostError && error.code === 'busy') || remaining <= 0) { report('credential_close_incomplete'); return 'credential_close_incomplete'; }
      await new Promise(resolve => setTimeout(resolve, Math.min(wait, remaining)));
    }
  }
}

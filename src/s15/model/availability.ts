import { checkAuthReadiness, type HostAuthReadiness } from 'schway/host';
import type { ApprovedModelRoute } from './types';

/** Reads one subscription route's local credential readiness (no network, no inference). */
export type RouteReadinessCheck = (route: ApprovedModelRoute) => Promise<Pick<HostAuthReadiness, 'status'>>;
const defaultCheck: RouteReadinessCheck = route => checkAuthReadiness({ route: route.provider, model: route.modelId }, { deadlineMs: 5000 });

/**
 * Live availability for approved subscription routes. A route configured `available` is an approval to use it
 * once the service identity is signed in; its effective availability follows that identity's local Schway
 * credential readiness: a stored, unexpired or renewable credential (`configured-unverified`) is `available`,
 * `quota-exceeded` is `quota`, and anything else (no login yet, a locked or invalid store) is `unavailable`.
 * The owner's Web device login therefore makes the route usable without any configuration edit, and a logout
 * withdraws it again. A route configured `unavailable` or `quota` stays exactly as configured (an explicit hold),
 * and metered routes are unchanged. Before the first check completes every live route is `unavailable`.
 * Dispatch still lists the account catalog afresh, so readiness alone never proves live access.
 */
export function liveRouteAvailability(check: RouteReadinessCheck = defaultCheck) {
  const live = new Map<ApprovedModelRoute['provider'], ApprovedModelRoute['availability']>();
  const subject = (route: ApprovedModelRoute) => route.charge === 'subscription' && route.availability === 'available';
  return {
    /** The route as dispatch and the Web see it now; never widens a configured hold. */
    apply(route: ApprovedModelRoute): ApprovedModelRoute {
      if (!subject(route)) return route;
      const availability = live.get(route.provider) ?? 'unavailable';
      return availability === route.availability ? route : { ...route, availability };
    },
    /** Re-reads readiness once per provider; a failed or timed-out read is `unavailable`. */
    async refresh(routes: readonly ApprovedModelRoute[]): Promise<void> {
      const providers = new Map(routes.filter(subject).map(route => [route.provider, route] as const));
      await Promise.all([...providers].map(async ([provider, route]) => {
        let status: HostAuthReadiness['status'] | null = null;
        try { status = (await check(route)).status; } catch { /* Unreadable store: unavailable. */ }
        live.set(provider, status === 'configured-unverified' ? 'available' : status === 'quota-exceeded' ? 'quota' : 'unavailable');
      }));
    },
  };
}

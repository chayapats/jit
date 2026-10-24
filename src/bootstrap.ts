import { quarantineLegacyPrAlerts } from "./pr/alerts";
import type { TransactionStore } from "./store";

/** What pre-listen state preparation changed; IDs only, never payload text. */
export interface ServiceBootstrapResult {
  quarantinedLegacyAlerts: string[];
}

/**
 * Pre-listen state preparation for `serve`. `main.ts` calls this on the opened store before the job
 * queue, delivery work or HTTP server exist, so nothing can send or export stale/credential-bearing
 * pre-guard `pr-alert/` intents first. Runs in one transaction.
 */
export function prepareServiceState(store: TransactionStore, now: number): ServiceBootstrapResult {
  return store.transaction(tx => ({ quarantinedLegacyAlerts: quarantineLegacyPrAlerts(tx, now) }));
}

import type { TransactionStore } from "../../src/store";

/**
 * Test scaffolding for suites about other pages: an installation whose owner finished app.setup/v1 earlier, so the
 * workspace home renders instead of redirecting to setup. It records only the finished marker. It does not create a
 * General space, save a language or touch the persona, so those suites keep their own expectations. The setup flow
 * itself, through its public commands, is covered by tests/setup.test.ts.
 */
export function markSetupComplete(store: TransactionStore, at = 1): void {
  const record = { done: { wake: at, connect: at, know: at, personality: at }, personalitySkipped: true, check: null };
  store.transaction(tx => tx.run("INSERT OR REPLACE INTO setup_state (id, revision, record_json, completed_at) VALUES (1, 1, ?, ?)", JSON.stringify(record), at));
}

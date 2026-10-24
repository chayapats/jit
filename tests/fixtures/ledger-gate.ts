import { readFileSync } from "node:fs";
import type { LedgerGate } from "../../src/ops/lifecycle";

/**
 * TEST FIXTURE ONLY. Stands in for the OPS02 (#33) ledger checkpoint
 * verification: trusts a configured `jit.deletion.ledger/v1` file when present,
 * so lifecycle tests exercise activation and the missing-ledger quarantine.
 * Production uses `defaultLedgerGate`, which blocks every installed profile
 * until the real checkpoint writer is integrated.
 */
export const fixtureLedgerGate: LedgerGate = ({ ledgerPath }) => {
  if (ledgerPath === null) return { trusted: true, detail: "development profile" };
  try {
    const raw = JSON.parse(readFileSync(ledgerPath, "utf8")) as { ledger?: unknown; revision?: unknown };
    if (raw.ledger === "jit.deletion.ledger/v1" && Number.isSafeInteger(raw.revision)) return { trusted: true, detail: "fixture ledger checkpoint" };
  } catch { /* Fall through. */ }
  return { trusted: false, reason: "missing deletion ledger; restore stays quarantined", nextAction: "inspect-quarantine-and-ledger" };
};

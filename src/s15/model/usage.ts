import type { BudgetVector, Reservation, Usage } from '../policy';
import { add, unknownUsage, zero } from '../policy/validation';

/** Charged upper bounds and measured subtotals are independent. An unknown component is never
 * replaced by zero; known subtotals may coexist with unknown calls in the explicit unknown list. */
export function summarizeReservations(rows: readonly Reservation[]): { charged: BudgetVector; measured: Usage; unknown: (keyof Usage)[] } {
  const charged = rows.reduce((sum, row) => add(sum, row.upperBound), zero());
  const measured = unknownUsage(), unknown: (keyof Usage)[] = [];
  for (const key of Object.keys(measured) as (keyof Usage)[]) {
    const known = rows.map(row => row.actual[key]).filter(value => value !== null);
    if (rows.some(row => row.actual[key] === null)) unknown.push(key);
    if (known.length) {
      const total = known.reduce<bigint>((sum, value) => sum + BigInt(value), 0n);
      if (key === 'spendMinor') measured[key] = total.toString();
      else { if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('usage_overflow'); measured[key] = Number(total); }
    }
  }
  return { charged, measured, unknown };
}

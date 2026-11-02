import type { ActionAdapter, AdapterResult, BudgetVector, JsonValue, Ref, Transaction } from '../policy';
import { canonical, currency, equal, exact, fail, id, nat, ref, string, unknownUsage, vector } from '../policy/validation';

/** Explicit trusted currency precision. No exchange rate, provider support or spend allowance is implied. */
export interface PaymentCurrency { currency: string; minorUnit: number }
/** Fixture-only final quote. id identifies one protected logical obligation across revisions/work/restarts. Never create a new id to retry an unknown payment. */
export interface PaymentQuote { id: string; version: string; purpose: Ref; account: Ref; payee: Ref; currency: string; amount: string; memo: string; expiresAt: number }
/** Deterministic fixture transport behavior. lost_response records a remote success but loses its reply. */
export type PaymentScript = 'succeed' | 'reject' | 'unknown' | 'lost_response';
/** This port has no network/provider/credential capability. Mutation and read counts are observable test evidence only. */
export class FixturePaymentPort {
  #quotes = new Map<string, PaymentQuote>();
  #results = new Map<string, AdapterResult>();
  #scripts: PaymentScript[];
  mutationCalls = 0;
  reconcileReads = 0;
  constructor(quotes: readonly PaymentQuote[], scripts: readonly PaymentScript[] = []) { this.#scripts = [...scripts]; for (const q of quotes) this.setQuote(q); }
  /** Protected fixture setup, not an agent tool. Changing a quote invalidates the final dispatch precondition. */
  setQuote(q: PaymentQuote): void {
    exact(q, ['id', 'version', 'purpose', 'account', 'payee', 'currency', 'amount', 'memo', 'expiresAt']); id(q.id); string(q.version); if (!q.version) fail('invalid_quote'); ref(q.purpose); ref(q.account); ref(q.payee); currency(q.currency); string(q.amount); string(q.memo); nat(q.expiresAt, true);
    this.#quotes.set(q.id, JSON.parse(canonical(q)) as PaymentQuote);
  }
  /** A defensive copy of the current protected quote, never a client-asserted version. */
  quote(id: string): PaymentQuote { const q = this.#quotes.get(id); if (!q) fail('quote_unavailable'); return JSON.parse(canonical(q)) as PaymentQuote; }
  /** Single fixture send. The policy service commits its claim before invoking this method; this port also refuses duplicate obligation IDs. */
  async pay(q: PaymentQuote): Promise<AdapterResult> {
    if (!equal(this.quote(q.id), q)) fail('stale_quote');
    const key = q.account.id + ':' + q.id;
    if (this.#results.has(key)) fail('payment_already_submitted');
    this.mutationCalls++;
    const script = this.#scripts.shift() ?? 'succeed';
    const result: AdapterResult = { outcome: script === 'reject' ? 'failed' : script === 'unknown' ? 'unknown' : 'succeeded', actual: unknownUsage(), transportSettled: script !== 'unknown' };
    this.#results.set(key, result);
    if (script === 'lost_response') throw new Error('fixture_response_lost');
    return structuredClone(result);
  }
  /** Read-only fixture reconciliation; never calls pay, even for absent/ambiguous results. */
  async reconcile(t: Transaction): Promise<AdapterResult> { this.reconcileReads++; return structuredClone(this.#results.get(t.account.id + ':' + t.quoteId) ?? { outcome: 'unknown', actual: unknownUsage(), transportSettled: false }); }
}
/** Exact decimal parsing using trusted currency precision. Rejects floats, exponent/negative/leading-zero forms and excess precision. */
export function parsePaymentAmount(amount: unknown, minorUnit: number): string {
  nat(minorUnit); if (minorUnit > 6 || typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,23})(\.[0-9]+)?$/.test(amount)) fail('invalid_amount');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > minorUnit || (minorUnit === 0 && amount.includes('.'))) fail('amount_precision');
  const result = (BigInt(whole!) * (10n ** BigInt(minorUnit)) + BigInt(fraction.padEnd(minorUnit, '0') || '0')).toString();
  if (result === '0' || result.length > 30) fail('invalid_amount'); return result;
}
/** Fixture-only adapter registration. The protected composition supplies currency metadata and explicit operating bounds; no real money can move. */
export function createFixturePaymentAdapter(options: { port: FixturePaymentPort; currencies: readonly PaymentCurrency[]; upperBound: BudgetVector; beforeDispatch?: () => Promise<void> }): ActionAdapter {
  vector(options.upperBound);
  const precisions = new Map<string, number>();
  for (const c of options.currencies) { exact(c, ['currency', 'minorUnit']); currency(c.currency); nat(c.minorUnit); if (c.minorUnit > 6 || precisions.has(c.currency)) fail('invalid_currency'); precisions.set(c.currency, c.minorUnit); }
  const bound = structuredClone(options.upperBound);
  function transaction(q: PaymentQuote): Transaction {
    const precision = precisions.get(q.currency); if (precision === undefined) fail('currency_unsupported');
    return { payee: q.payee, account: q.account, currency: q.currency, minorUnit: precision, amountMinor: parsePaymentAmount(q.amount, precision), quoteId: q.id, quoteVersion: q.version, quoteExpiresAt: q.expiresAt };
  }
  const payload = (q: PaymentQuote): JsonValue => JSON.parse(canonical({ transaction: transaction(q), memo: q.memo, purpose: q.purpose })) as JsonValue;
  return Object.freeze({
    id: 'fixture_payment', version: 1,
    prepare(proposal, context) {
      exact(proposal, ['quoteId', 'quoteVersion']); id(proposal.quoteId); string(proposal.quoteVersion);
      const q = options.port.quote(proposal.quoteId);
      if (q.version !== proposal.quoteVersion) fail('stale_quote');
      if (!equal(q.purpose, context.work.request.purpose)) fail('outside_scope');
      if (context.now >= q.expiresAt) fail('expired');
      return { operation: 'pay', classes: ['financial'], resources: [q.account], recipients: [q.payee], payload: payload(q), fences: [], upperBound: structuredClone(bound), expiresAt: q.expiresAt, transaction: transaction(q), github: null, impact: 'reversible' };
    },
    async perform(action, context) {
      await options.beforeDispatch?.();
      if (!action.transaction) fail('invalid_quote');
      const q = options.port.quote(action.transaction.quoteId);
      if (!equal(transaction(q), action.transaction)) fail('stale_quote');
      return context.commit(payload(q), () => options.port.pay(q));
    },
    async reconcile(action) { if (!action.transaction) fail('invalid_quote'); return options.port.reconcile(action.transaction); },
  } satisfies ActionAdapter);
}

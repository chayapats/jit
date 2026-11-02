import { fixture, type Fixture } from './s15-policy';
import type { ActionRef, ModelCallInput, ReadInput } from '../../src/s15/policy';
import { createFixturePaymentAdapter, FixturePaymentPort, type PaymentQuote } from '../../src/s15/payments';
import { bound } from './s15-policy';
const input = JSON.parse(Buffer.from(process.argv[2]!, 'base64').toString()) as { path: string; workId: string; mode: 'reserve' | 'reserve_read' | 'dispatch' | 'crash_before' | 'crash_after'; action?: ActionRef; model?: ModelCallInput; read?: ReadInput; quotes?: PaymentQuote[] };
let waitForCrash: () => Promise<unknown>;
class CrashPort extends FixturePaymentPort { override async pay(q: PaymentQuote) { const result = await super.pay(q); process.stdout.write('sent:' + this.mutationCalls + '\n'); await waitForCrash(); return result; } }
const port = input.mode === 'crash_after' ? new CrashPort(input.quotes ?? []) : new FixturePaymentPort(input.quotes ?? []);
const f: Fixture = fixture({ path: input.path, create: false, reads: [{ operation: 'read', validate() {} }], adapters: [createFixturePaymentAdapter({ port, currencies: [{ currency: 'USD', minorUnit: 2 }], upperBound: bound() })] });
const actor = f.service.control.bindWork(input.workId);
if (input.mode === 'crash_before') f.before = async () => { process.stdout.write('claimed\n'); await waitForCrash(); };
process.stdout.write('ready\n');
const reader = Bun.stdin.stream().getReader(); waitForCrash = () => reader.read(); await reader.read();
try {
  if (input.mode === 'reserve_read') { const result = f.service.work.reserveRead(actor, input.read!); process.stdout.write(JSON.stringify({ state: result.state === 'allow' ? 'reserved' : result.code }) + '\n'); }
  else if (input.mode === 'reserve') { f.service.work.reserveModelCall(actor, input.model!); process.stdout.write(JSON.stringify({ state: 'reserved' }) + '\n'); }
  else { const observation = await f.service.work.dispatch(actor, input.action!); process.stdout.write(JSON.stringify({ state: observation.outcome, calls: f.calls + port.mutationCalls }) + '\n'); }
} catch (error) { process.stdout.write(JSON.stringify({ state: error instanceof Error ? error.message : 'error', calls: f.calls + port.mutationCalls }) + '\n'); }
finally { f.cleanup(); }

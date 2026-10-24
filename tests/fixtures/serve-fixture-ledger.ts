/**
 * TEST HARNESS ONLY. Runs a packaged release's real `serve` path
 * (`<release>/src/ops/serve.ts`) with the fixture ledger gate, standing in for
 * the OPS02 checkpoint writer that this build does not yet integrate. The fake
 * supervisor substitutes it for `<release>/src/main.ts` in the rendered
 * ExecStart; everything else (config file, environment, boot, HTTP) is real.
 * Usage: bun serve-fixture-ledger.ts <release> serve --service-config <path>
 */
import { join } from "node:path";
import { fixtureLedgerGate } from "./ledger-gate";

const [release, command, ...args] = process.argv.slice(2);
if (!release || command !== "serve") { console.error("usage: <release> serve [--service-config <path>]"); process.exit(2); }
const { readConfig } = await import(join(release, "src", "config.ts")) as typeof import("../../src/config");
const { serveCommand } = await import(join(release, "src", "ops", "serve.ts")) as typeof import("../../src/ops/serve");
await serveCommand(readConfig(), args, { ledgerGate: fixtureLedgerGate });

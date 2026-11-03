// Separate-process participant for the OS-released fence lock tests (OPS15-01).
// argv: mode databasePath id signalPath [goPath]. Signals with files; never touches another test's paths.
import { existsSync, writeFileSync } from "node:fs";
import { AppError } from "../src/errors";
import { clearUpgradeFence, withUpgradeFenceLock, writeUpgradeFence } from "../src/ops/upgrade-fence";

const [mode, databasePath, id, signal, go] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const waitFor = (path: string) => { const deadline = Date.now() + 20_000; while (!existsSync(path) && Date.now() < deadline) Bun.sleepSync(5); };
try {
  if (mode === "clear-paused") clearUpgradeFence(databasePath, id, { afterRead: () => { writeFileSync(signal, "read"); waitFor(go!); } });
  else if (mode === "clear") { writeFileSync(signal, "started"); clearUpgradeFence(databasePath, id); }
  else if (mode === "acquire") { writeFileSync(signal, "started"); writeUpgradeFence(databasePath, id, 2); }
  else if (mode === "hold") withUpgradeFenceLock(databasePath, () => { writeFileSync(signal, "held"); for (;;) Bun.sleepSync(50); });
  else throw new Error("unknown_mode");
  console.log(JSON.stringify({ id, ok: true }));
} catch (error) {
  console.log(JSON.stringify({ id, ok: false, code: error instanceof AppError ? error.code : "error" }));
}

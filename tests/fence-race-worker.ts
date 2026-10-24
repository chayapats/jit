// Separate-process contender for the shared ops.schema_migrations/v1 fence (OPS02 race test).
// argv: databasePath id holder barrierPath. Waits for the barrier file, then tries one exclusive acquisition.
import { existsSync } from "node:fs";
import { AppError } from "../src/errors";
import { writeUpgradeFence } from "../src/ops/upgrade-fence";

const [databasePath, id, holder, barrier] = process.argv.slice(2) as [string, string, "upgrade" | "restore", string];
const deadline = Date.now() + 10_000;
while (!existsSync(barrier) && Date.now() < deadline) { /* Busy-wait so both contenders start together. */ }
try {
  writeUpgradeFence(databasePath, id, 1, holder);
  console.log(JSON.stringify({ id, won: true }));
} catch (error) {
  console.log(JSON.stringify({ id, won: false, code: error instanceof AppError ? error.code : "error" }));
}

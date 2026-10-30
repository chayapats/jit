import { AppError } from "../../src/errors";
import { acquireS14RuntimeLock } from "../../src/s14/runtime-lock";

console.log("ready");
await Bun.stdin.text(); // Both contenders wait for the parent's explicit start barrier.
try {
  const release = acquireS14RuntimeLock(process.argv[2]!);
  process.once("exit", release);
  console.log("held");
  setInterval(() => {}, 60000); // Keep ownership alive until the test terminates this process.
} catch (e) {
  console.log(e instanceof AppError ? e.code : String(e));
}

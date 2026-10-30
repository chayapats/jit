import { runS14 } from "../../src/s14/main";

// Exercise real serve composition and output without binding a network port or keeping a process alive.
Bun.serve = (() => ({ stop() {} })) as unknown as typeof Bun.serve;
await runS14(["serve", "--s14"]);
process.emit("SIGTERM");

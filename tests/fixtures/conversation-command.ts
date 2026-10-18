import { Application } from "../../src/application";
import { readConfig } from "../../src/config";
import { TransactionStore } from "../../src/store";
import { AppError } from "../../src/errors";
import type { ConversationCommand } from "../../src/conversation";

const input = await Bun.stdin.json() as { path: string; token: string; command: ConversationCommand;
  now: number; crash?: "topic" | "message" | "receipt" };
const store = new TransactionStore(input.path);
const app = new Application(store, readConfig({ JIT_DATABASE: input.path }), {
  now: () => input.now,
  beforeCommit: stage => { if (stage === input.crash) process.kill(process.pid, "SIGKILL"); },
});
try { console.log(JSON.stringify(app.execute(app.authenticate(input.token).actor, input.command))); }
catch (error) { console.log(JSON.stringify({ error: error instanceof AppError ? error.code : "storage_unavailable" })); }
finally { store.close(); }

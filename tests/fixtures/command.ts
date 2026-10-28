import { Application, type CreateProjectCommand } from "../../src/application";
import { readConfig } from "../../src/config";
import { TransactionStore } from "../../src/store";
import { AppError } from "../../src/errors";

const input = await Bun.stdin.json() as { path: string; token: string; command: CreateProjectCommand; crash?: "project" | "receipt" };
const config = readConfig({ JIT_DATABASE: input.path });
const store = new TransactionStore(input.path);
const app = new Application(store, config, { beforeCommit: stage => {
  if (stage === input.crash) process.kill(process.pid, "SIGKILL");
} });
try {
  const result = app.execute(app.authenticate(input.token).actor, input.command);
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof AppError ? error.code : "storage_unavailable" }));
} finally { store.close(); }

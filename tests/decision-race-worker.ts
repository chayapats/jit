import { parentPort, workerData } from "node:worker_threads";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import type { DecisionCommand } from "../src/team/types";

const data = workerData as { path: string; token: string; command: DecisionCommand };
const store = new TransactionStore(data.path);
const app = new Application(store, readConfig({ JIT_DATABASE: data.path }));
parentPort!.on("message", () => {
  try {
    const actor = app.authenticate(data.token).actor;
    const receipt = app.execute(actor, data.command);
    store.close();
    parentPort!.postMessage({ ok: true, conclusion: receipt.decision?.conclusion ?? null, id: receipt.decision?.id ?? null });
  } catch (error) {
    store.close();
    parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : "failed" });
  }
});
parentPort!.postMessage({ ready: true });

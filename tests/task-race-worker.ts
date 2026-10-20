import { parentPort, workerData } from "node:worker_threads";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import type { TaskChannel, TaskCommand } from "../src/tasks";

const data = workerData as { path: string; token: string; channel: TaskChannel; command: TaskCommand };
const store = new TransactionStore(data.path);
const app = new Application(store, readConfig({ JIT_DATABASE: data.path }));
parentPort!.on("message", () => {
  try {
    const actor = app.issueAdapterActor(data.token, data.channel);
    const receipt = app.execute(actor, data.command);
    store.close();
    parentPort!.postMessage({ ok: true, state: receipt.task.state, id: receipt.task.id });
  } catch (error) {
    store.close();
    parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : "failed" });
  }
});
parentPort!.postMessage({ ready: true });

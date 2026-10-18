import { Application } from "../../src/application";
import { readConfig } from "../../src/config";
import { TransactionStore } from "../../src/store";
import { JobQueue } from "../../src/jobs/queue";
import { projectStateWork } from "../../src/jobs/project-state";
import type { EnqueueJobCommand } from "../../src/jobs/types";

const args = JSON.parse(await Bun.stdin.text()) as { path: string; token: string; now: number; command: EnqueueJobCommand; mode: string };
const config = readConfig({ JIT_DATABASE: args.path }), store = new TransactionStore(args.path);
let queue: JobQueue | undefined;
try {
  const definition = projectStateWork(store);
  if (args.mode === "admitted-crash") definition.run = () => new Promise(() => {});
  queue = new JobQueue(store, config.jobs, [definition], { now: () => args.now });
  const app = new Application(store, config, { jobs: queue, now: () => args.now, beforeCommit: stage => {
    if (args.mode === `crash-${stage}`) process.kill(process.pid, "SIGKILL");
  } });
  const receipt = app.execute(app.authenticate(args.token).actor, args.command);
  if (args.mode === "admitted-crash") queue.pump();
  await Bun.write(Bun.stdout, JSON.stringify(receipt) + "\n");
  if (args.mode === "queued-crash" || args.mode === "admitted-crash") process.kill(process.pid, "SIGKILL");
} catch (error) { console.log(JSON.stringify({ error: (error as { code?: string }).code ?? "failed" })); process.exitCode = 2; }
finally { queue?.close(); store.close(); }

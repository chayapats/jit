import type { Model } from "schway/host";
import type { S14Application } from "./application";
import type { Attempt, WorkOutput } from "./authority-types";
import { schwayResearch } from "./research";

/** Runs granted local report tools and optional public reads with sourced memory under one fenced work attempt. */
export async function runComputerWork(app: S14Application, directory: string, attempt: Attempt, signal: AbortSignal, model?: Model): Promise<WorkOutput> {
  app.store.read(tx => app.authority.assertTool(tx, attempt.id, "computer"));
  return schwayResearch(directory, app, model).run(attempt, signal);
}

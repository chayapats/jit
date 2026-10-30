import type { Attempt } from "./authority-types";
import type { ReplayClass } from "./recovery-types";
import { canonical, digest } from "./validation";

const handlers = new Map([ ["research", "research-read/v1"], ["synthesis", "synthesis/v1"] ]);
const readTools = new Set(["web_search", "web_fetch"]);

/** Classifies only registered handlers and exact service tools; model intent/readOnlyHint is never consulted. */
export function replayPolicy(attempt: Attempt): { replay: ReplayClass; handlerVersion: string } {
  const handlerVersion = handlers.get(attempt.step?.handler ?? "") ?? "unregistered/v1";
  if (attempt.snapshot.tools.includes("computer")) return { replay: "never_auto", handlerVersion };
  if (handlerVersion === "unregistered/v1" || attempt.snapshot.tools.some(tool => !readTools.has(tool))) return { replay: "reconcile_only", handlerVersion };
  return { replay: "replay_safe", handlerVersion };
}

/** Pins exact admitted input/config/route/authority and committed dependency identities independently of native history. */
export function checkpointFingerprint(attempt: Attempt, graph: unknown): string {
  return digest(canonical({ snapshot: attempt.snapshot, step: attempt.step ?? null, graph }));
}

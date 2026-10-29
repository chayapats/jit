import type { CommandRunner } from "./podman-runtime";

/** Page-only availability projection; checking never blocks the owner's controls. */
export type ReadinessView<T> = T | { state: "checking"; reason: null };
type Status = { state: "ready" | "unavailable"; reason: unknown };
interface Entry { value?: Status | undefined; expires: number; flight?: Promise<void> | undefined; generation: number }
const entries = new WeakMap<object, Entry>();

/** Reads stale readiness immediately and starts at most one background probe per runtime. TTL starts at completion. */
export function cachedReadiness<T extends Status>(runtime: object, probe: () => Promise<T>, now = Date.now): ReadinessView<T> {
  let entry = entries.get(runtime);
  if (!entry) { entry = { expires: 0, generation: 0 }; entries.set(runtime, entry); }
  const current = entry;
  if (!current.flight && (!current.value || now() >= current.expires)) {
    const generation = current.generation;
    current.flight = Promise.resolve().then(probe).then(value => {
      if (generation !== current.generation) return;
      current.value = value;
      current.expires = now() + (value.state === "ready" ? 30_000 : 5_000);
    }, () => {
      if (generation !== current.generation) return;
      current.value = { state: "unavailable", reason: "runtime" };
      current.expires = now() + 5_000;
    }).finally(() => { current.flight = undefined; });
  }
  return (current.value as T | undefined) ?? { state: "checking", reason: null };
}

/** Drops stale readiness after a real-use failure; an older probe cannot publish over the invalidation. */
export function invalidateReadiness(runtime: object): void {
  const entry = entries.get(runtime);
  if (entry) { entry.value = undefined; entry.expires = 0; entry.generation++; }
}

/** Observes real commands only (probes use the raw runner), retaining explicit Podman client selection. */
export function readinessCommands<T extends CommandRunner>(runtime: object, run: T): T {
  return Object.assign(async (...args: Parameters<CommandRunner>) => {
    try { const result = await run(...args); if (result.exitCode !== 0) invalidateReadiness(runtime); return result; }
    catch (error) { invalidateReadiness(runtime); throw error; }
  }, { client: run.client }) as T;
}

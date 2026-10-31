/** Independent committed-service lanes; work retains chat-before-graph admission ordering. */
export interface S14PumpPorts {
  busy(): boolean;
  tick(): void;
  replies(): Promise<void>;
  work(): Promise<void>;
  repliesQueued(): boolean;
  git(): Promise<void>;
  attention(): Promise<void>;
  personal(): Promise<void>;
  personalEffects(): Promise<void>;
  botLifecycle(): Promise<void>;
}

/** Starts independent single-flight lanes after boot; stop/idle join every admitted lane before store disposal. */
export function createS14Pump(ports: S14PumpPorts) {
  const flights = new Map<string, Promise<void>>();
  let closing = false;
  const run = (name: string, operation: () => Promise<void>): Promise<void> => {
    const owned = flights.get(name);
    if (owned) return owned;
    // Publish ownership before invoking reentrant or synchronously throwing ports.
    const pending = Promise.resolve().then(() => {
      if (!closing && !ports.busy()) return operation();
    }).finally(() => { if (flights.get(name) === pending) flights.delete(name); });
    flights.set(name, pending);
    return pending;
  };
  const join = async (pending: Promise<void>[]): Promise<void> => {
    const outcomes = await Promise.allSettled(pending);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  return {
    drain(): Promise<void> {
      if (closing || ports.busy()) return Promise.resolve();
      ports.tick();
      return join([
        run("work", async () => {
          do {
            // Preserve interactive-chat priority before graph admission. Authority also
            // rechecks queued chat between admissions and owns its transport capacity.
            await ports.replies();
            if (closing || ports.busy()) return;
            await ports.work();
          } while (!closing && !ports.busy() && ports.repliesQueued());
        }),
        // These lanes consume committed state and enforce their own current-authority
        // checks. None requires all model transports (or another lane) to settle first.
        run("git", ports.git), run("attention", ports.attention),
        run("personal", ports.personal), run("personalEffects", ports.personalEffects),
        run("botLifecycle", ports.botLifecycle),
      ]);
    },
    stop(): void { closing = true; },
    async idle(): Promise<void> { await join([...flights.values()]); },
  };
}

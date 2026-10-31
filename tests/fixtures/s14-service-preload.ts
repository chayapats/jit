// Deterministic service composition: replace only the listener, then stop through the real shutdown path.
Bun.serve = (() => {
  setTimeout(() => process.emit("SIGTERM"), 0);
  return { stop() {} };
}) as unknown as typeof Bun.serve;

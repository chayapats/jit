import { expect, test } from "bun:test";
import { cachedReadiness, invalidateReadiness, readinessCommands } from "../src/exec/readiness-cache";
import type { PodmanReadiness } from "../src/exec/podman-client";
import { PodmanAttachmentSanitizer } from "../src/attachments/sanitizer-runtime";
import { readConfig } from "../src/config";
const ready: PodmanReadiness = { state: "ready", reason: null };
const unavailable: PodmanReadiness = { state: "unavailable", reason: "socket" };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("readiness TTL uses completion time; concurrent readers share one refresh and retain stale data", async () => {
  const runtime = {}; let now = 0, calls = 0;
  let finish!: (value: PodmanReadiness) => void;
  const probe = () => { calls++; return new Promise<PodmanReadiness>(resolve => { finish = resolve; }); };
  const read = () => cachedReadiness(runtime, probe, () => now);
  expect(read().state).toBe("checking");
  for (let i = 0; i < 20; i++) read();
  await flush(); expect(calls).toBe(1);
  now = 100_000; finish(ready); await flush();
  now += 29_999; expect(read()).toEqual(ready); await flush(); expect(calls).toBe(1);
  now++; for (let i = 0; i < 20; i++) expect(read()).toEqual(ready);
  await flush(); expect(calls).toBe(2);
  finish(unavailable); await flush();
  now += 4999; expect(read()).toEqual(unavailable); await flush(); expect(calls).toBe(2);
  now++; read(); read(); await flush(); expect(calls).toBe(3);
  finish(ready); await flush();
});

test("real command failures discard ready data; late probes cannot overwrite invalidation", async () => {
  const runtime = {}; const probe = async () => ready;
  cachedReadiness(runtime, probe); await flush();
  const run = readinessCommands(runtime, async () => ({ exitCode: 125, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  await run(); expect(cachedReadiness(runtime, probe).state).toBe("checking");
  invalidateReadiness(runtime); await flush();
  expect(cachedReadiness(runtime, probe).state).toBe("checking"); await flush();
  expect(cachedReadiness(runtime, probe)).toEqual(ready);
  const throwing = readinessCommands(runtime, async () => { throw Error("private runtime diagnostic"); });
  await expect(throwing()).rejects.toThrow();
  expect(cachedReadiness(runtime, async () => { throw Error("private"); }).state).toBe("checking");
  await flush(); expect(cachedReadiness<PodmanReadiness>(runtime, probe)).toEqual({ state: "unavailable", reason: "runtime" });
});

test("sanitizer real-use cleanup failure invalidates the same cached runtime", async () => {
  const runtime = new PodmanAttachmentSanitizer(`base@sha256:${"a".repeat(64)}`, "test", readConfig({}).attachments,
    async () => ({ exitCode: 125, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  cachedReadiness(runtime, async () => ready); await flush();
  await expect(runtime.reset()).rejects.toThrow("sanitizer_cleanup_failed");
  expect(cachedReadiness(runtime, async () => unavailable).state).toBe("checking"); await flush();
  expect(cachedReadiness<PodmanReadiness>(runtime, async () => ready)).toEqual(unavailable);
});

test("an ordinary negative answer (exit 1) keeps readiness; only engine failures (125) or spawn errors invalidate it", async () => {
  const runtime = {};
  let probes = 0;
  const probe = async () => { probes++; return ready; };
  cachedReadiness(runtime, probe); await flush();
  expect(cachedReadiness(runtime, probe)).toEqual(ready);
  // `image exists` for a missing image and `container inspect` for a missing container exit 1 (#224 live finding).
  const negative = readinessCommands(runtime, async () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  await negative(["image", "exists", "missing"], { timeoutMs: 1000 });
  expect(cachedReadiness(runtime, probe)).toEqual(ready);
  expect(probes).toBe(1);
  const engine = readinessCommands(runtime, async () => ({ exitCode: 125, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  await engine(["info"], { timeoutMs: 1000 });
  expect(cachedReadiness(runtime, probe)).toEqual({ state: "checking", reason: null });
});

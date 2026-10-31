import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { domainFixture, type DomainFixture } from "./fixtures/s14-domain";
import type { OpsControl } from "../src/s14/ops-types";

const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function capture(failure: string | null) {
  const f = await domainFixture(); fixtures.push(f); f.store.close();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-ops-fsync.ts")], {
    stdin: new Blob([JSON.stringify({ path: f.path, token: f.token, failure, options: { policy: f.options.policy }, now: f.clock.now })]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, stderr).toBe(0);
  return JSON.parse(stdout) as { state: string; injected: boolean; events: { kind: string; path: string; directory: boolean }[]; control: OpsControl };
}

test("complete backup flushes every new directory and parent, and every component before registration", async () => {
  const { state, events, control } = await capture(null);
  expect(state).toBe("complete");
  const created = events.map((event, index) => ({ ...event, index })).filter(event => event.kind === "mkdir");
  expect(created.some(event => event.path.endsWith(`/backups/${control.backups[0]}`))).toBe(true);
  for (const event of created) {
    const later = events.slice(event.index + 1);
    expect(later.some(next => next.kind === "sync" && next.directory && next.path === event.path)).toBe(true);
    expect(later.some(next => next.kind === "sync" && next.directory && next.path === dirname(event.path))).toBe(true);
  }
  const image = events.findIndex(event => event.kind === "sync" && !event.directory && event.path.endsWith("/application.sqlite"));
  const manifest = events.findIndex(event => event.kind === "sync" && !event.directory && event.path.endsWith("/manifest.json"));
  const registry = events.findIndex((event, index) => index > manifest && event.kind === "sync" && !event.directory && event.path.includes("/control.json.tmp-"));
  expect(image).toBeGreaterThan(-1); expect(manifest).toBeGreaterThan(image); expect(registry).toBeGreaterThan(manifest);
  for (const event of created) {
    const nextCreate = events.findIndex((next, index) => index > event.index && next.kind === "mkdir" && dirname(next.path) === event.path);
    if (nextCreate < 0) continue;
    expect(events.slice(event.index + 1, nextCreate).some(next => next.kind === "sync" && next.path === dirname(event.path))).toBe(true);
  }
});

test.each(["directory", "parent", "contents"])("a %s fsync failure cannot report or register a complete backup", async failure => {
  const result = await capture(failure);
  expect(result.injected).toBe(true);
  expect(result.state).toBe("failed");
  expect(result.control.backups).toEqual([]);
  expect(result.control.receipts).toEqual([]);
});

test("S14 atomic journal propagates directory fsync failures swallowed by the shared helper", async () => {
  const result = await capture("atomic");
  expect(result.injected).toBe(true);
  expect(result.state).toBe("failed");
});

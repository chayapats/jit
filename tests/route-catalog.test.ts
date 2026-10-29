import { expect, test } from "bun:test";
import { RouteCatalog } from "../src/team/route-catalog";
import type { HostAuthFetch, HostCredentialStore } from "schway/host";

const store: HostCredentialStore = {
  get: async () => JSON.stringify({ accessToken: "fixture-catalog-token", expiresAt: 9_000_000_000_000, accountId: "fixture-account" }),
  set: async () => { throw new Error("catalog must not write"); }, delete: async () => { throw new Error("catalog must not delete"); },
};
const payload = { models: [{ slug: "gpt-fixture-other", visibility: "list" }, { slug: "gpt-fixture-best", visibility: "list", recommended: true }] };

test("public host catalog uses only GETs, caches per provider for ten minutes and invalidates", async () => {
  const calls: string[] = [];
  const fetch: HostAuthFetch = async (input, init) => { expect(init?.method).toBe("GET"); calls.push(String(input)); return Response.json(payload); };
  const catalog = new RouteCatalog({ store, fetch });
  let time = 1;
  const read = () => catalog.readRouteModels("codex", { now: () => time });
  const [first, second] = await Promise.all([read(), read()]);
  expect(first).toEqual(second);
  expect(first.models?.[0]).toMatchObject({ id: "gpt-fixture-best", recommended: true });
  expect(calls).toHaveLength(1); expect(calls[0]).toContain("/codex/models");
  time += 599_999; await read(); expect(calls).toHaveLength(1);
  time++; await read(); expect(calls).toHaveLength(2);
  catalog.invalidate("codex"); await read(); expect(calls).toHaveLength(3);
});

test("missing capability skips all host/store reads", async () => {
  const catalog = new RouteCatalog({ capability: () => undefined, store: { ...store, get: async () => { throw new Error("unexpected read"); } }, fetch: async () => { throw new Error("unexpected fetch"); } });
  expect(await catalog.readRouteModels("codex")).toEqual({ models: null, status: null });
});

for (const status of [401, 429]) test(`catalog HTTP ${status} stays safe and cacheable`, async () => {
  let calls = 0;
  const catalog = new RouteCatalog({ store, fetch: async () => { calls++; return Response.json({ error: { message: "fixture failure" } }, { status }); } });
  const result = await catalog.readRouteModels("codex");
  expect(result).toEqual({ models: null, status: status === 401 ? "rejected" : "quota-exceeded" });
  await catalog.readRouteModels("codex"); expect(calls).toBe(1);
});

test("missing login returns status without transport", async () => {
  const catalog = new RouteCatalog({ store: { ...store, get: async () => null }, fetch: async () => { throw new Error("unexpected fetch"); } });
  expect(await catalog.readRouteModels("codex")).toEqual({ models: null, status: "needs-login" });
});

test("cancellation bounds an uncooperative fixture transport and invalidation permits retry", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const catalog = new RouteCatalog({ store, fetch: async () => { entered(); return new Promise(() => {}); } });
  const result = catalog.readRouteModels("codex", { signal: controller.signal });
  await started; controller.abort();
  expect(await result).toEqual({ models: null, status: "integration-unavailable" });
  catalog.invalidate("codex");
});

test("five-second deadline bounds an uncooperative credential store with a fake clock", async () => {
  let advance!: () => void;
  const catalog = new RouteCatalog({ store: { ...store, get: () => new Promise(() => {}) },
    clock: { now: () => 0, sleep: (ms) => { expect(ms).toBe(5000); return new Promise(resolve => { advance = resolve; }); } },
    fetch: async () => { throw new Error("unexpected fetch"); } });
  const result = catalog.readRouteModels("codex"); advance();
  expect(await result).toEqual({ models: null, status: "integration-unavailable" });
});

test("five-second deadline also bounds a fixture fetch that ignores abort", async () => {
  let advance!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const catalog = new RouteCatalog({ store,
    clock: { now: () => 0, sleep: ms => { expect(ms).toBe(5000); return new Promise(resolve => { advance = resolve; }); } },
    fetch: async (_input, init) => { expect(init?.method).toBe("GET"); entered(); return new Promise(() => {}); } });
  const result = catalog.readRouteModels("codex"); await started; advance();
  expect(await result).toEqual({ models: null, status: "integration-unavailable" });
});

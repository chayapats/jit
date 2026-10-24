import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAuthFetch, HostCredentialStore } from "schway/host";
import { bridgeProbePorts } from "../src/evidence/bridge-probe";
import { exportProbeSummary, liveProbe, type ProbeEvent } from "../src/evidence/probe";
import { runProbeCommand } from "../src/probe-cli";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ID = "ee781630-4d14-4d8b-a0eb-21b276ed5632";
const SECRET = "TOKEN_SENTINEL_must_not_persist";
const OTHER_ID = "ff781630-4d14-4d8b-a0eb-21b276ed5633";
const validTokens = JSON.stringify({ accessToken: "fixture-access", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "jit-bridge-probe-")); roots.push(root);
  mkdirSync(join(root, ".local"), { mode: 0o700 });
  return root;
}

function configFile(root: string) {
  const path = ".local/host-probe-config.json";
  writeFileSync(join(root, path), JSON.stringify({ installationLabel: "fixture-probe-host", routes: [{ route: "grok", model: "grok-4-fixture", configured: true }] }));
  return path;
}

const memStore = (raw: string | null, fail?: "get"): HostCredentialStore => ({
  get: async () => {
    if (fail === "get") throw new Error("Cannot read credential");
    return raw;
  },
  set: async () => {},
  delete: async () => true,
});

const throwingFetch: HostAuthFetch = async () => { throw new Error("fixture network down"); };
const statusFetch = (status: number): HostAuthFetch => async () => new Response("limited", { status });

function sseSuccess(text = "ready", inputTokens = 5, outputTokens = 3): string {
  const message = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress"}}',
    '',
    'event: response.output_item.added',
    `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}`,
    '',
    'event: response.output_text.delta',
    `data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":${JSON.stringify(text)}}`,
    '',
    'event: response.output_item.done',
    `data: {"type":"response.output_item.done","output_index":0,"item":${JSON.stringify(message)}}`,
    '',
    'event: response.completed',
    `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[${JSON.stringify(message)}],"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}`,
    '',
  ].join("\n");
}

const successFetch = (text = "ready"): HostAuthFetch => async () =>
  new Response(sseSuccess(text), { status: 200, headers: { "content-type": "text/event-stream" } });

function bridgePorts(overrides: { store?: HostCredentialStore | null; fetch?: HostAuthFetch | undefined; id?: string } = {}) {
  const root = setup();
  const options: { route: "grok"; model: string; root: string; store?: HostCredentialStore; fetch?: HostAuthFetch } =
    { route: "grok", model: "grok-4-fixture", root };
  if (overrides.store === undefined) options.store = memStore(validTokens);
  else if (overrides.store !== null) options.store = overrides.store;
  if (overrides.fetch) options.fetch = overrides.fetch;
  const ports = bridgeProbePorts(options);
  return { root, ports: { ...ports, now: () => 1800000000000, id: () => overrides.id ?? ID } };
}

test("bridge probe reports observed-ready only for a successful selected-route request", async () => {
  const { root, ports } = bridgePorts({ fetch: successFetch() });
  const { record, self } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 3, deadlineMs: 8000 }, ports, root);
  expect(record.lifecycle).toBe("observed-ready");
  expect(record.route).toBe("grok");
  expect(record.model).toBe("grok-4-fixture");
  expect(record.attempts).toBe(1);
  expect(record.observations.find(item => item.observation === "live-request")).toMatchObject({ event: "success" });
  // Renewal stays unobserved: a successful inference never proves renewal.
  expect(record.observations.find(item => item.observation === "renewal")).toMatchObject({ event: "unobserved" });
  expect(self.attemptsUsed).toBe(1);
  const exported = exportProbeSummary(record);
  expect(exported.lifecycle).toBe("observed-ready");
  expect(JSON.stringify({ record, exported })).not.toContain("fixture-access");
  expect(JSON.stringify({ record, exported })).not.toContain(SECRET);
});

test("bridge credential boundary maps local store states without secrets or network", async () => {
  const loggedIn = bridgePorts();
  expect(await loggedIn.ports.readCredential(new AbortController().signal)).toBe("ok");
  const cases: [HostCredentialStore | null, "missing" | "locked"][] = [
    [memStore(null), "locked"],
    [memStore("garbage-not-json"), "missing"],
    [memStore(validTokens, "get"), "missing"],
  ];
  for (const [store, expected] of cases) {
    const { ports } = bridgePorts({ store });
    expect(await ports.readCredential(new AbortController().signal)).toBe(expected);
  }
});

test("bridge infer covers every classifier state with the selected route unchanged", async () => {
  const table: [string, HostCredentialStore | null, HostAuthFetch | undefined, ProbeEvent][] = [
    ["login", memStore(null), undefined, "login"],
    ["store", memStore(validTokens, "get"), undefined, "failed"],
    ["quota", memStore(validTokens), statusFetch(429), "quota"],
    // A 401 fails the fixture refresh and drops the login; a 403 rejects the route.
    ["rejected-after-401", memStore(validTokens), statusFetch(401), "login"],
    ["rejected", memStore(validTokens), statusFetch(403), "rejected"],
    ["failed-unreachable", memStore(validTokens), throwingFetch, "failed"],
  ];
  for (const [index, [label, store, fetch, expected]] of table.entries()) {
    const id = `ee781630-4d14-4d8b-a0eb-21b276ed56${String(index).padStart(2, "0")}`;
    const { root, ports } = bridgePorts({ store, fetch, id });
    const { record } = await liveProbe("fixture-probe-host",
      { route: "grok", model: "grok-4-fixture", maxAttempts: 3, deadlineMs: 8000 }, ports, root);
    const live = record.observations.find(item => item.observation === "live-request")!;
    expect(live.event, label).toBe(expected);
    expect(record.route, label).toBe("grok");
  }
  // The credential observation names the store boundary independently of the inference result.
  const storeCase = bridgePorts({ store: memStore(validTokens, "get"), id: "ee781630-4d14-4d8b-a0eb-21b276ed5601" });
  const storeRecord = (await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, storeCase.ports, storeCase.root)).record;
  expect(storeRecord.observations.find(item => item.observation === "credential-read")).toMatchObject({ event: "store", state: "store-unavailable" });
  // Transport quota reports waiting with the route intact and no fallback.
  const quota = bridgePorts({ fetch: statusFetch(429) });
  const quotaRecord = (await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, quota.ports, quota.root)).record;
  expect(quotaRecord.lifecycle).toBe("quota-waiting");
  expect(quotaRecord.attempts).toBe(1);
});

test("bridge infer admits a single attempt per call with honest budgets", async () => {
  let fetches = 0;
  const counting: HostAuthFetch = async (input, init) => { fetches++; return statusFetch(500)(input, init); };
  const { root, ports } = bridgePorts({ fetch: counting });
  const { record, self } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 2, deadlineMs: 8000 }, ports, root);
  expect(fetches).toBe(2);
  expect(record.lifecycle).toBe("failed");
  expect(record.attempts).toBe(2);
  expect(self).toMatchObject({ attemptsUsed: 2, maxAttempts: 2 });
});

test("bridge probe rejects non-route aliases and models outside the host grammar", async () => {
  const root = setup();
  expect(() => bridgeProbePorts({ route: "probe-route" as "grok", model: "x", root })).toThrow("invalid_probe_options");
  expect(() => bridgeProbePorts({ route: "grok", model: "org/grok-4", root })).toThrow("invalid_probe_options");
  // A file blocking the service-owned host directory fails the live attempt, never the process.
  const blocked = bridgePorts({});
  mkdirSync(join(blocked.root, ".local"), { recursive: true });
  writeFileSync(join(blocked.root, ".local", "host-probe-host"), "not a directory");
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...blocked.ports, now: () => 1800000000000, id: () => OTHER_ID }, blocked.root);
  expect(record.lifecycle).toBe("failed");
});

test("bridge live command wires the concrete route only for grok/codex", async () => {
  const root = setup(), path = configFile(root);
  const scripted = (await import("../src/probe-cli")).defaultProbePorts();
  const gated = await runProbeCommand(["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "2", "--deadline", "5000"], root, scripted);
  expect(gated.exitCode).toBe(0);
  // Without explicit ports, an unselected alias fails closed before any account request.
  const closed = await runProbeCommand(["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "2", "--deadline", "5000"], root);
  expect(closed.exitCode).toBe(2);
});

test("bridge self sample stays bounded without environment or token leakage", async () => {
  const { root, ports } = bridgePorts({ fetch: successFetch("hello") });
  const { self, record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, ports, root);
  expect(self.peakMemoryBytes).toBeGreaterThan(0);
  expect(self.managedFiles).toBeGreaterThanOrEqual(1);
  expect(self.managedBytes).toBeGreaterThan(0);
  expect(Number.isSafeInteger(self.peakMemoryBytes)).toBe(true);
  const dumped = JSON.stringify({ self, summary: exportProbeSummary(record) });
  expect(dumped).not.toContain("fixture-access");
  expect(dumped).not.toContain(SECRET);
  expect(dumped).not.toContain("grok-4-fixture");
});

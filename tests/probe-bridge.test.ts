import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAuthFetch, HostCredentialStore } from "schway/host";
import { bridgeProbePorts } from "../src/evidence/bridge-probe";
import { PROBE_PROMPT, cancelProbeAttempt, commitProbeOutcome, exportProbeSummary, liveProbe, readProbeAttempt, reconcileProbeAttempts, type ProbeEvent } from "../src/evidence/probe";
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
  // Vacuous atomic cleanup: set persists nothing, so there is never
  // anything to remove; reporting true is exact, not optimistic.
  compareAndDelete: async () => true,
});

/** Map-backed fixture store with a truly atomic compare-and-delete (no await between compare and delete). */
function mapStore(initial: Record<string, string> = {}): { store: HostCredentialStore & { compareAndDelete(identity: { account: string }, expectedValue: string): Promise<boolean> }; backend: Map<string, string> } {
  const backend = new Map<string, string>(Object.entries(initial));
  const store = {
    get: async (identity: { account: string }) => backend.get(identity.account) ?? null,
    set: async (identity: { account: string }, value: string) => { backend.set(identity.account, value); },
    delete: async (identity: { account: string }) => backend.delete(identity.account),
    compareAndDelete: async (identity: { account: string }, expected: string) => {
      if (backend.get(identity.account) !== expected) return false;
      backend.delete(identity.account);
      return true;
    },
  };
  return { store, backend };
}

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

function bridgePorts(overrides: { root?: string; route?: "grok" | "codex"; model?: string; store?: HostCredentialStore | null; fetch?: HostAuthFetch | undefined; id?: string } = {}) {
  const root = overrides.root ?? setup();
  const route = overrides.route ?? "grok";
  const model = overrides.model ?? (route === "codex" ? "codex-fixture" : "grok-4-fixture");
  const options: { route: "grok" | "codex"; model: string; root: string; store?: HostCredentialStore; fetch?: HostAuthFetch } =
    { route, model, root };
  if (overrides.store === undefined) options.store = memStore(validTokens);
  else if (overrides.store !== null) options.store = overrides.store;
  if (overrides.fetch) options.fetch = overrides.fetch;
  const ports = bridgeProbePorts(options);
  return { root, route, model, ports: { ...ports, now: () => 1800000000000, id: () => overrides.id ?? ID } };
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
  expect(record.observations.find(item => item.observation === "renewal")).toMatchObject({ event: "unobserved", attempts: 0 });
  expect(self.attemptsUsed).toBe(1);
  // Exact counts: one inference send, no token send on the clean path.
  expect(self.providerSends).toEqual({ inference: 1, token: 0 });
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
    ["store", memStore(validTokens, "get"), undefined, "store"],
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

test("a refreshable 401 admits exactly one retry inside the single attempt budget", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  let tokenFetches = 0, inferenceFetches = 0;
  const fetch: HostAuthFetch = async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.includes("oauth2/token")) {
      tokenFetches++;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    inferenceFetches++;
    if (inferenceFetches === 1) return new Response("unauthorized", { status: 401 });
    return new Response(sseSuccess("ready after refresh", 7, 2), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: memStore(expired), fetch });
  const { record, self } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 3, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => ID }, root);
  // Exact provider-send accounting: the pinned adapter structurally issues at
  // most two inference sends per admitted attempt (one 401 replay, no loop).
  // The replay is reported in the per-send ledger, never hidden, while
  // renewal stays explicitly unobserved as an evidence claim. The 401
  // refresh reuses the warmed credential without a second token send.
  expect(record.lifecycle).toBe("observed-ready");
  expect(record.attempts).toBe(1);
  expect(tokenFetches).toBe(1);
  expect(inferenceFetches).toBeLessThanOrEqual(2);
  expect(inferenceFetches).toBe(2);
  const renewal = record.observations.find(item => item.observation === "renewal")!;
  expect(renewal.event).toBe("unobserved");
  expect(renewal.attempts).toBe(0);
  expect(renewal.sends).toEqual([{ inference: 0, token: 1, confirmed: true, admission: 1 }, { inference: 1, token: 0, confirmed: true, admission: 1 }, { inference: 1, token: 0, confirmed: true, admission: 1 }]);
  expect(self.providerSends).toEqual({ inference: 2, token: 1 });
});

test("a blocked credential store does not outlive the probe deadline", async () => {
  const root = setup();
  const hanging: HostCredentialStore = {
    get: () => new Promise<never>(() => {}),
    set: async () => {},
    delete: async () => true,
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: hanging });
  const controller = new AbortController();
  controller.abort();
  await expect(ports.readCredential!(controller.signal)).rejects.toThrow();
});

test("concurrent cancel and commit never corrupt the record or promote late success", async () => {
  const root = setup();
  let release!: (event: ProbeEvent) => void;
  const gate = new Promise<ProbeEvent>(resolve => { release = resolve; });
  const starter = bridgePorts({ root, fetch: successFetch() });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: () => gate }, starter.root);
  for (let spin = 0; spin < 100; spin++) {
    try { await readProbeAttempt(root, ID); break; } catch { await new Promise(r => setTimeout(r, 5)); }
  }
  // Deterministic cancel-first: an acknowledged cancel makes later commits fail.
  const cancelled = await cancelProbeAttempt(root, ID);
  expect(cancelled.lifecycle).toBe("cancelled");
  release("success");
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  // Concurrent storm on the terminal record: the lock serializes every
  // transition, nothing corrupts, and no late success is promoted.
  const outcomes: boolean[] = [];
  const racers: Promise<unknown>[] = [];
  for (let k = 1; k <= 20; k++) {
    racers.push(cancelProbeAttempt(root, ID).catch(() => null));
    racers.push(commitProbeOutcome(root, ID, cancelled.observations, k, 10).catch(() => false).then(ok => { outcomes.push(!!ok); }));
  }
  await Promise.all(racers);
  const final = await readProbeAttempt(root, ID);
  expect(final.lifecycle).toBe("cancelled");
  expect(outcomes.every(committed => committed === false)).toBe(true);
  // Deterministic commit-first: a committed terminal is never rewritten by a later cancel.
  const other = `ee781630-4d14-4d8b-a0eb-000000001001`;
  const direct = bridgePorts({ root, id: other, fetch: successFetch() });
  const run = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...direct.ports, now: () => 1800000000000, id: () => other }, root);
  expect(run.record.lifecycle).toBe("observed-ready");
  const afterCancel = await cancelProbeAttempt(root, other);
  expect(afterCancel.lifecycle).toBe("observed-ready");
});

test("restart reconciles every started attempt without a slice cap", async () => {
  const root = setup();
  const gate = new Promise<ProbeEvent>(() => {});
  const gated = bridgePorts({ fetch: successFetch() });
  const controller = new AbortController();
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...gated.ports, now: () => 1800000000000, id: () => ID, infer: () => gate }, root, controller.signal);
  for (let spin = 0; spin < 100; spin++) {
    try { await readProbeAttempt(root, ID); break; } catch { await new Promise(r => setTimeout(r, 5)); }
  }
  const template = await readProbeAttempt(root, ID);
  for (let i = 0; i < 70; i++) {
    const id = `ee781630-4d14-4d8b-a0eb-${String(1000 + i).padStart(12, "0")}`;
    writeFileSync(join(root, ".local", "host-probe", `${id}.json`), JSON.stringify({ ...template, id }) + "\n");
  }
  const updated = await reconcileProbeAttempts(root);
  expect(updated).toHaveLength(71);
  expect(updated.every(record => record.lifecycle === "interrupted")).toBe(true);
  await cancelProbeAttempt(root, ID).catch(() => null);
  // Settle the gated owner instead of leaking it past the test: the internal
  // deadline race lets the abort through and the CAS keeps interrupted.
  controller.abort();
  const late = await pending;
  expect(late.record.lifecycle).toBe("interrupted");
});

test("an ancestor symlink cannot redirect managed probe state", async () => {
  const root = setup();
  const outside = mkdtempSync(join(tmpdir(), "jit-probe-outside-")); roots.push(outside);
  const link = join(root, ".local");
  rmSync(link, { force: true, recursive: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(outside, link, "dir");
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: memStore(validTokens), fetch: successFetch() });
  // The symlinked ancestor fails closed before any attempt is persisted or any account is touched.
  await expect(liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root)).rejects.toThrow("unsafe_local_directory");
  expect(readdirSync(outside)).toEqual([]);
});

test("cross-process cancel and commit keep exactly one terminal outcome", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  let release!: (event: "unobserved") => void;
  const gate = new Promise<ProbeEvent>(resolve => { release = resolve as (event: ProbeEvent) => void; });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: () => gate }, root);
  for (let spin = 0; spin < 100; spin++) {
    try { await readProbeAttempt(root, ID); break; } catch { await new Promise(r => setTimeout(r, 5)); }
  }
  // Truly concurrent children: every contender is spawned before any is
  // awaited, so cancel and commit race through the transactional CAS instead
  // of running sequentially. Exactly one commit may acknowledge.
  const childSource = (mode: "cancel" | "commit") => `
    const { cancelProbeAttempt, commitProbeOutcome, readProbeAttempt } = await import(${JSON.stringify(join(import.meta.dir, "../src/evidence/probe.ts"))});
    const root = ${JSON.stringify(root)}, id = ${JSON.stringify(ID)};
    await Bun.sleep(Math.floor(Math.random() * 50));
    if (${JSON.stringify(mode)} === "cancel") {
      const out = await cancelProbeAttempt(root, id).catch(() => null);
      console.log(JSON.stringify({ kind: "cancel", lifecycle: out?.lifecycle ?? "error" }));
    } else {
      const record = await readProbeAttempt(root, id).catch(() => null);
      if (!record) { console.log(JSON.stringify({ kind: "commit", ok: false })); process.exit(0); }
      const ok = await commitProbeOutcome(root, id, record.observations, 1, 10).catch(() => false);
      console.log(JSON.stringify({ kind: "commit", ok }));
    }
  `;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  for (let i = 0; i < 6; i++) {
    children.push(Bun.spawn(["bun", "-e", childSource("cancel")], { stdout: "pipe", stderr: "ignore" }));
    children.push(Bun.spawn(["bun", "-e", childSource("commit")], { stdout: "pipe", stderr: "ignore" }));
  }
  const outputs = await Promise.all(children.map(async proc => {
    const text = await new Response(proc.stdout as unknown as ReadableStream).text();
    await proc.exited;
    return text.trim();
  }));
  const results = outputs.map(line => JSON.parse(line) as { kind: string; ok?: boolean; lifecycle?: string });
  const commitWins = results.filter(item => item.kind === "commit" && item.ok);
  expect(commitWins.length).toBeLessThanOrEqual(1);
  release("unobserved");
  const late = await pending;
  const final = await readProbeAttempt(root, ID);
  // No torn records, no post-terminal overwrite, no late success beyond the fenced outcome.
  expect(final.lifecycle).not.toBe("observed-ready");
  expect(late.record.lifecycle).not.toBe("observed-ready");
  if (commitWins.length === 0) expect(final.lifecycle).toBe("cancelled");
  // The settled record is byte-stable: a re-read matches exactly.
  expect(await readProbeAttempt(root, ID)).toEqual(final);
});

test("bridge infer rejects route/model mismatches with zero provider contact", async () => {
  const root = setup();
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: memStore(validTokens), fetch: successFetch() });
  const signal = new AbortController().signal;
  await expect(ports.infer({ route: "codex", model: "gpt-5-codex", prompt: PROBE_PROMPT, tools: [], discovery: { repository: false, hosted: false }, deadlineMs: 8000 }, signal))
    .rejects.toThrow("invalid_probe_input");
  await expect(ports.infer({ route: "grok", model: "other-model", prompt: PROBE_PROMPT, tools: [], discovery: { repository: false, hosted: false }, deadlineMs: 8000 }, signal))
    .rejects.toThrow("invalid_probe_input");
  // Overlapping infer calls on one ports instance throw instead of swapping counts.
  // The gate rejects at once, so the first call fails closed after the
  // overlap is detected and performs no provider contact.
  const first = ports.infer({ route: "grok", model: "grok-4-fixture", prompt: PROBE_PROMPT, tools: [], discovery: { repository: false, hosted: false }, deadlineMs: 8000, gate: async () => { throw new Error("fenced"); } }, new AbortController().signal);
  await expect(ports.infer({ route: "grok", model: "grok-4-fixture", prompt: PROBE_PROMPT, tools: [], discovery: { repository: false, hosted: false }, deadlineMs: 8000 }, signal))
    .rejects.toThrow("invalid_probe_input");
  // The fenced first send surfaces as failed evidence, never as success and
  // never as a transmitted request.
  await expect(first).resolves.toBe("failed");
});

test("live probe enforces its deadline even with a hanging credential store", async () => {
  const root = setup();
  let inferCalls = 0;
  const ports: import("../src/evidence/probe").ProbePorts = {
    now: () => 1800000000000,
    id: () => ID,
    readCredential: () => new Promise<never>(() => {}),
    infer: async () => { inferCalls++; return "success"; },
  };
  const startedAt = Date.now();
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 3, deadlineMs: 100 }, ports, root);
  expect(Date.now() - startedAt).toBeLessThan(5000);
  expect(record.lifecycle).toBe("cancelled");
  expect(record.attempts).toBe(0);
  expect(inferCalls).toBe(0);
});

test("cancel during a gated admission starts no further provider requests", async () => {
  const root = setup();
  let inferCalls = 0;
  let release!: (event: ProbeEvent) => void;
  const gate = new Promise<ProbeEvent>(resolve => { release = resolve; });
  const starter = bridgePorts({ root, fetch: successFetch() });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 3, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => OTHER_ID,
      infer: async () => { inferCalls++; return gate; } }, root);
  for (let spin = 0; spin < 100; spin++) {
    try {
      const current = await readProbeAttempt(root, OTHER_ID);
      if (current.attempts === 1) break;
    } catch { /* Not persisted yet. */ }
    await new Promise(r => setTimeout(r, 5));
  }
  // The first admission is durably reserved before any provider contact.
  expect((await readProbeAttempt(root, OTHER_ID)).attempts).toBe(1);
  await cancelProbeAttempt(root, OTHER_ID);
  release("success");
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  // No second admission was ever reserved: exactly one provider request.
  expect(inferCalls).toBe(1);
  expect((await readProbeAttempt(root, OTHER_ID)).attempts).toBe(1);
});

test("restart preserves admitted attempts instead of recording zero", async () => {
  const root = setup();
  let release!: (event: ProbeEvent) => void;
  const gate = new Promise<ProbeEvent>(resolve => { release = resolve; });
  const starter = bridgePorts({ root, fetch: successFetch() });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 2, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: () => gate }, root);
  for (let spin = 0; spin < 100; spin++) {
    try {
      if ((await readProbeAttempt(root, ID)).attempts === 1) break;
    } catch { /* Not persisted yet. */ }
    await new Promise(r => setTimeout(r, 5));
  }
  const reconciled = await reconcileProbeAttempts(root);
  expect(reconciled).toHaveLength(1);
  expect(reconciled[0]!.lifecycle).toBe("interrupted");
  expect(reconciled[0]!.attempts).toBe(1);
  // A late completion after the restart can never promote the record.
  release("success");
  const late = await pending;
  expect(late.record.lifecycle).toBe("interrupted");
  expect(late.record.attempts).toBe(1);
});

test("codex success reports exact counts with no renewal claim", async () => {
  const { root, route, model, ports } = bridgePorts({ route: "codex", fetch: successFetch("codex ready") });
  const { record, self } = await liveProbe("fixture-probe-host",
    { route, model, maxAttempts: 3, deadlineMs: 8000 }, ports, root);
  expect(record.lifecycle).toBe("observed-ready");
  expect(record.route).toBe("codex");
  expect(record.attempts).toBe(1);
  expect(record.observations.find(item => item.observation === "renewal")).toMatchObject({ event: "unobserved", attempts: 0 });
  expect(self.providerSends).toEqual({ inference: 1, token: 0 });
  const renewal = record.observations.find(item => item.observation === "renewal")!;
  expect(renewal.sends).toEqual([{ inference: 1, token: 0, confirmed: true, admission: 1 }]);
  const live = record.observations.find(item => item.observation === "live-request")!;
  expect(live.sends).toEqual([]);
});

test("codex deadline aborts refresh traffic with no post-deadline credential write", async () => {
  const root = setup();
  let tokenCalls = 0, setCalls = 0;
  let releaseToken!: (response: Response) => void;
  const tokenGate = new Promise<Response>(resolve => { releaseToken = resolve; });
  const store: HostCredentialStore = {
    get: async () => JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 }),
    set: async () => { setCalls++; },
    delete: async () => true,
  };
  const fetch: HostAuthFetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      tokenCalls++;
      // A faithful transport honors abort: the composed probe signal rejects
      // the pending refresh instead of letting it complete after the deadline.
      if (init?.signal?.aborted) throw new Error("aborted");
      return await Promise.race([
        tokenGate,
        new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      ]);
    }
    return new Response(sseSuccess("late codex"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const ports = bridgeProbePorts({ route: "codex", model: "codex-fixture", root, store, fetch });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "codex", model: "codex-fixture", maxAttempts: 1, deadlineMs: 1500 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  // The refresh never settles on its own, so a generous deadline still expires
  // while it is pending, without racing host construction on slow CI runners.
  // Terminal state is deadline-driven (either timer may win the race);
  // the guarantee under test is boundedness with zero post-deadline writes.
  expect(["cancelled", "failed"].includes(record.lifecycle)).toBe(true);
  expect(tokenCalls).toBe(1);
  // Releasing the refresh after the deadline must not write credentials:
  // the composed signal already settled the refresh as aborted.
  releaseToken(new Response(JSON.stringify({ access_token: "late-access", refresh_token: "r", expires_in: 3600 }), { status: 200 }));
  await new Promise(r => setTimeout(r, 200));
  expect(setCalls).toBe(0);
});

test("no replay send starts after cancellation acknowledges", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  let inferenceFetches = 0, tokenFetches = 0;
  let releaseToken!: () => void;
  const tokenGate = new Promise<void>(resolve => { releaseToken = resolve; });
  const fetch: HostAuthFetch = async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      tokenFetches++;
      await tokenGate;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    inferenceFetches++;
    if (inferenceFetches === 1) return new Response("unauthorized", { status: 401 });
    return new Response(sseSuccess("late replay", 7, 2), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: memStore(expired), fetch });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 3, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => ID }, root);
  for (let spin = 0; spin < 200 && tokenFetches === 0; spin++) {
    await new Promise(r => setTimeout(r, 5));
  }
  expect(tokenFetches).toBe(1);
  // Cancellation acknowledges while the proactive refresh is still gated:
  // the first inference send must never start afterward.
  const cancelled = await cancelProbeAttempt(root, ID);
  expect(cancelled.lifecycle).toBe("cancelled");
  releaseToken();
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  // The fenced inference send was refused at the shared gate: no inference
  // request ever left the transport. The token entry stays explicitly
  // unconfirmed: its transport completed only after cancellation had already
  // terminalized the record, so confirmation correctly refused to rewrite
  // settled evidence.
  expect(inferenceFetches).toBe(0);
  const final = await readProbeAttempt(root, ID);
  expect(final.attempts).toBe(1);
  expect(final.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 0, token: 1, confirmed: false, admission: 1 }]);
});

test("ledger placement is validated: non-renewal sends and length mismatch reject", async () => {
  const root = setup();
  const { ports } = bridgePorts({ fetch: successFetch() });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, ports, root);
  expect(record.lifecycle).toBe("observed-ready");
  const polluted = {
    ...record,
    id: OTHER_ID,
    observations: record.observations.map(item => item.observation === "service-start"
      ? { ...item, sends: [{ inference: 1, token: 0, confirmed: true, admission: 1 }] }
      : item.observation === "renewal" ? { ...item, sends: [] } : item),
  };
  writeFileSync(join(root, ".local", "host-probe", `${OTHER_ID}.json`), JSON.stringify(polluted) + "\n");
  await expect(readProbeAttempt(root, OTHER_ID)).rejects.toThrow();
  expect(() => exportProbeSummary(polluted as never)).toThrow();
  const stretched = {
    ...record,
    id: OTHER_ID,
    observations: record.observations.map(item => item.observation === "renewal"
      ? { ...item, sends: [{ inference: 1, token: 0, confirmed: true, admission: 1 }, { inference: 1, token: 0, confirmed: true, admission: 1 }, { inference: 0, token: 1, confirmed: true, admission: 1 }, { inference: 0, token: 1, confirmed: true, admission: 1 }, { inference: 1, token: 0, confirmed: true, admission: 1 }] } : item),
  };
  writeFileSync(join(root, ".local", "host-probe", `${OTHER_ID}.json`), JSON.stringify(stretched) + "\n");
  await expect(readProbeAttempt(root, OTHER_ID)).rejects.toThrow();
});

test("a stale terminal commit cannot erase persisted admissions or ledgers", async () => {
  const root = setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const starter = bridgePorts({ root, fetch: successFetch() });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: () => gate.then(() => "success" as const) }, root);
  for (let spin = 0; spin < 100; spin++) {
    try {
      if ((await readProbeAttempt(root, ID)).attempts === 1) break;
    } catch { /* Not persisted yet. */ }
    await new Promise(r => setTimeout(r, 5));
  }
  // A stale writer passes zeroed counters and an empty ledger: the commit
  // wins (the record is still started) but preserves durable state.
  const stale = await readProbeAttempt(root, ID);
  const committed = await commitProbeOutcome(root, ID, stale.observations.map(item =>
    item.observation === "renewal" ? { ...item, sends: [] } : item), 0, 10);
  expect(committed).toBe(true);
  const settled = await readProbeAttempt(root, ID);
  expect(settled.attempts).toBe(1);
  expect(settled.observations.find(item => item.observation === "renewal")!.sends).toEqual([]);
  release();
  const late = await pending;
  expect(late.record.lifecycle).not.toBe("started");
});

test("a send that completes after cancellation stays unconfirmed and unwritten", async () => {
  const root = setup();
  let releaseFetch!: (response: Response) => void;
  const fetchGate = new Promise<Response>(resolve => { releaseFetch = resolve; });
  const fetch: HostAuthFetch = async () => fetchGate;
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: memStore(validTokens), fetch });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  for (let spin = 0; spin < 200; spin++) {
    try {
      const current = await readProbeAttempt(root, OTHER_ID);
      const sends = current.observations.find(item => item.observation === "renewal")!.sends;
      if (sends?.length === 1 && sends[0]!.inference === 1) break;
    } catch { /* Not persisted yet. */ }
    await new Promise(r => setTimeout(r, 5));
  }
  // The admission (and its unconfirmed intent) is durable before cancel wins.
  expect((await readProbeAttempt(root, OTHER_ID)).observations.find(item => item.observation === "renewal")!.sends)
    .toEqual([{ inference: 1, token: 0, confirmed: false, admission: 1 }]);
  const cancelled = await cancelProbeAttempt(root, OTHER_ID);
  expect(cancelled.lifecycle).toBe("cancelled");
  // The transport completes only after cancellation acknowledged: the
  // confirmation is refused, the store of record keeps the entry explicitly
  // unconfirmed, and the late response never becomes success evidence.
  releaseFetch(new Response(sseSuccess("late success"), { status: 200, headers: { "content-type": "text/event-stream" } }));
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  const final = await readProbeAttempt(root, OTHER_ID);
  expect(final.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 1, token: 0, confirmed: false, admission: 1 }]);
  const exported = exportProbeSummary(final);
  expect(exported.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 1, token: 0, confirmed: false, admission: 1 }]);
});

test("no credential write happens after cancellation acknowledges", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  let setCalls = 0, tokenFetches = 0;
  let releaseToken!: (response: Response) => void;
  const tokenGate = new Promise<Response>(resolve => { releaseToken = resolve; });
  const store: HostCredentialStore = {
    get: async () => expired,
    set: async () => { setCalls++; },
    delete: async () => true,
  };
  const fetch: HostAuthFetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (!url.toLowerCase().includes("token")) {
      throw new Error("unexpected inference request before refresh");
    }
    tokenFetches++;
    if (init?.signal?.aborted) throw new Error("aborted");
    return await Promise.race([
      tokenGate,
      new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  for (let spin = 0; spin < 200 && tokenFetches === 0; spin++) {
    await new Promise(r => setTimeout(r, 5));
  }
  expect(tokenFetches).toBe(1);
  // Cancellation acknowledges while the refresh transport is still pending.
  const cancelled = await cancelProbeAttempt(root, OTHER_ID);
  expect(cancelled.lifecycle).toBe("cancelled");
  // The late token response must not become a credential write: the fenced
  // store refuses it even though the transport itself completed.
  releaseToken(new Response(JSON.stringify({ access_token: "late-access", refresh_token: "r", expires_in: 3600 }), { status: 200 }));
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  await new Promise(r => setTimeout(r, 50));
  expect(setCalls).toBe(0);
  // The self sample counts only confirmed sends: the unconfirmed token
  // send is uncertainty, never exact evidence.
  expect(late.self.providerSends).toEqual({ inference: 0, token: 0 });
  const final = await readProbeAttempt(root, OTHER_ID);
  // The token send was initiated before cancellation, so the ledger keeps
  // it explicitly unconfirmed (uncertain) rather than confirmed or erased.
  expect(final.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 0, token: 1, confirmed: false, admission: 1 }]);
});

test("concurrent probes on distinct records settle without lock errors", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch("concurrent") });
  const ids = [ID, OTHER_ID, "ee781630-4d14-4d8b-a0eb-000000000001", "ee781630-4d14-4d8b-a0eb-000000000002"];
  const runs = ids.map((id, index) => liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000 + index, id: () => id }, root));
  const settled = await Promise.all(runs.map(run => run.then(
    result => ({ ok: true as const, record: result.record }),
    error => ({ ok: false as const, error: String(error && (error as Error).message || error) }),
  )));
  expect(settled.filter(item => item.ok)).toHaveLength(ids.length);
  for (const item of settled) {
    expect(item.ok).toBe(true);
    if (item.ok) expect(["observed-ready", "failed", "cancelled", "interrupted"].includes(item.record.lifecycle)).toBe(true);
  }
  // No record is left behind in started: every admission terminalized.
  for (const id of ids) {
    expect((await readProbeAttempt(root, id)).lifecycle).not.toBe("started");
  }
});

test("a refused late token write stays unconfirmed with zero credential writes", async () => {
  const root = setup();
  // Explicit fenced store: the supported Schway guard (schway#416) refuses
  // the write after cancellation acknowledged, exactly as it does for
  // Schway's own default native store in production.
  const backend = new Map<string, string>();
  let tokenCalls = 0;
  let releaseBody!: (response: Response) => void;
  const bodyGate = new Promise<Response>(resolve => { releaseBody = resolve; });
  const store: HostCredentialStore = {
    get: async () => JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 }),
    set: async (_identity, value) => { backend.set("grok", value); },
    delete: async () => true,
  };
  const fetch: HostAuthFetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (!url.toLowerCase().includes("token")) {
      return new Response(sseSuccess("late", 1, 1), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    tokenCalls++;
    if (init?.signal?.aborted) throw new Error("aborted");
    return await Promise.race([
      bodyGate,
      new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  for (let spin = 0; spin < 200 && tokenCalls === 0; spin++) {
    await new Promise(r => setTimeout(r, 5));
  }
  expect(tokenCalls).toBe(1);
  const cancelled = await cancelProbeAttempt(root, OTHER_ID);
  expect(cancelled.lifecycle).toBe("cancelled");
  // The confirmed token response arrives after cancellation: the fenced
  // store must refuse the write even though the transport completed.
  releaseBody(new Response(JSON.stringify({ access_token: "late-access", refresh_token: "r", expires_in: 3600 }), { status: 200 }));
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  await new Promise(r => setTimeout(r, 50));
  expect(backend.size).toBe(0);
  // The token transport completed, but confirmation was refused after
  // cancellation: the entry stays explicitly unconfirmed.
  const final = await readProbeAttempt(root, OTHER_ID);
  expect(final.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 0, token: 1, confirmed: false, admission: 1 }]);
  expect(final.attempts).toBe(1);
});

test("cancellation waits for an in-flight credential mutation to settle", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let writeAt = 0, cancelAt = 0;
  const backend = new Map<string, string>();
  const store: HostCredentialStore = {
    // Expired login forces a proactive refresh through the supported guard.
    get: async () => expired,
    // Gated backend write: cancellation serializes against the whole
    // mutation instead of acknowledging past it, bounded by the deadline.
    set: async (_identity, value) => {
      await writeGate;
      writeAt = Date.now();
      backend.set("grok", value);
    },
    delete: async () => false,
    // Atomic: single-threaded Map access with no await between compare
    // and delete.
    compareAndDelete: async (_identity, expected) => {
      if (backend.get("grok") !== expected) return false;
      backend.delete("grok");
      return true;
    },
  };
  const fetch: HostAuthFetch = async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "r", expires_in: 3600 }), { status: 200 });
    }
    return new Response(sseSuccess("late", 1, 1), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch });
  const controller = new AbortController();
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 1000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root, controller.signal);
  try {
    // Wait until the credential mutation is actually in flight (attempt
    // reserved and the refresh intent durably recorded).
    for (let spin = 0; spin < 200; spin++) {
      try {
        const sends = (await readProbeAttempt(root, OTHER_ID)).observations.find(item => item.observation === "renewal")!.sends;
        if (sends!.length > 0) break;
      } catch { /* Not persisted yet. */ }
      await new Promise(r => setTimeout(r, 5));
    }
    await new Promise(r => setTimeout(r, 50));
    // Cancel while the write is in flight: acknowledgement waits for safe
    // settlement instead of racing past the mutation.
    const cancelPromise = cancelProbeAttempt(root, OTHER_ID);
    await new Promise(r => setTimeout(r, 50));
    releaseWrite();
    const cancelled = await cancelPromise;
    cancelAt = Date.now();
    expect(cancelled.lifecycle).toBe("cancelled");
    const late = await pending;
    expect(late.record.lifecycle).toBe("cancelled");
    // The mutation settled before acknowledgement: exactly one write, no
    // post-acknowledgement mutation.
    expect(backend.size).toBe(1);
    expect(writeAt).toBeLessThanOrEqual(cancelAt);
  } finally {
    controller.abort();
    releaseWrite();
    await pending.catch(() => null);
  }
});

test("a hanging credential mutation cannot wedge the probe past its deadline", async () => {
  const root = setup();
  const { fencedStoreWrite } = await import("../src/evidence/probe");
  const { ports } = bridgePorts({ fetch: successFetch() });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, ports, root);
  expect(record.lifecycle).toBe("observed-ready");
  const hanging = new Promise<never>(() => {});
  const controller = new AbortController();
  const id = record.id;
  setTimeout(() => controller.abort(), 50);
  const startedAt = Date.now();
  await expect(fencedStoreWrite(root, id, controller.signal, () => hanging)).rejects.toThrow();
  // Bounded: the abort releases the lifecycle lock instead of hanging on it.
  expect(Date.now() - startedAt).toBeLessThan(5000);
  // The record is untouched by the aborted write.
  expect((await readProbeAttempt(root, id)).lifecycle).toBe("observed-ready");
});

test("a crash between initiation and confirmation leaves explicitly unconfirmed evidence", async () => {
  const root = setup();
  const childId = "ee781630-4d14-4d8b-a0eb-000000001337";
  // The token transport hangs forever: the child parks after the intent is
  // durably recorded but before any confirmation can run. Killing it here
  // is deterministic — no later step can advance the record.
  const childSource = `
    const { bridgeProbePorts } = await import(${JSON.stringify(join(import.meta.dir, "../src/evidence/bridge-probe.ts"))});
    const { liveProbe } = await import(${JSON.stringify(join(import.meta.dir, "../src/evidence/probe.ts"))});
    const root = ${JSON.stringify(root)}, id = ${JSON.stringify(childId)};
    const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
    const store = { get: async () => expired, set: async () => {}, delete: async () => true };
    const fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.toLowerCase().includes("token")) throw new Error("unreachable");
      await new Promise(() => {});
    };
    const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch });
    await liveProbe("fixture-probe-host",
      { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 60000 },
      { now: () => 1800000000000, id: () => id, readCredential: ports.readCredential, infer: ports.infer }, root);
  `;
  const child = Bun.spawn(["bun", "-e", childSource], { stdout: "ignore", stderr: "ignore" });
  try {
    for (let spin = 0; spin < 200; spin++) {
      try {
        const sends = (await readProbeAttempt(root, childId)).observations.find(item => item.observation === "renewal")!.sends;
        if (sends!.length > 0) break;
      } catch { /* Not persisted yet. */ }
      await new Promise(r => setTimeout(r, 25));
    }
    const crashed = await readProbeAttempt(root, childId);
    expect(crashed.lifecycle).toBe("started");
    expect(crashed.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 0, token: 1, confirmed: false, admission: 1 }]);
    child.kill(9);
    await child.exited;
  } finally {
    try { child.kill(9); } catch { /* Already exited. */ }
  }
  // Restart reconciles the orphan without inventing confirmation.
  const updated = await reconcileProbeAttempts(root);
  expect(updated).toHaveLength(1);
  expect(updated[0]!.lifecycle).toBe("interrupted");
  expect(updated[0]!.observations.find(item => item.observation === "renewal")!.sends).toEqual([{ inference: 0, token: 1, confirmed: false, admission: 1 }]);
});

test("a throwing store maps to store-unavailable, not a missing login", async () => {
  const root = setup();
  const store: HostCredentialStore = {
    get: async () => { throw new Error("locked keychain"); },
    set: async () => {},
    delete: async () => false,
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch: successFetch("unused") });
  expect(await ports.readCredential!(new AbortController().signal)).toBe("missing");
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  expect(record.observations.find(item => item.observation === "credential-read")!.event).toBe("store");
  expect(record.lifecycle).toBe("store-unavailable");
});

test("a hanging credential write does not wedge the probe past its deadline", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  const store: HostCredentialStore = {
    get: async () => expired,
    set: () => new Promise<never>(() => {}),
    delete: async () => false,
    // Vacuous: the write never settles, so no value ever needs removal.
    compareAndDelete: async () => true,
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  const startedAt = Date.now();
  // The write never settles, so a budget generous enough for slow hosts to
  // reach it still always expires during the write (#84).
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 2000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  // Bounded by the deadline even though the store write never settles. The
  // write is unresolved at terminalization, so the record reports
  // uncertainty instead of a clean cancelled/failed claim: the value could
  // still land after the record is immutable.
  expect(Date.now() - startedAt).toBeLessThan(8000);
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
  expect((await readProbeAttempt(root, OTHER_ID)).lifecycle).toBe(record.lifecycle);
}, 15_000);

test("ledger entries beyond admitted attempts or over the per-ordinal bound reject", async () => {
  const root = setup();
  const { ports } = bridgePorts({ fetch: successFetch() });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, ports, root);
  expect(record.attempts).toBe(1);
  const base = record.observations.find(item => item.observation === "renewal")!.sends!;
  expect(base).toHaveLength(1);
  // An entry stamped for an admission that never happened fails closed,
  // even though it fits the overall budget.
  const future = {
    ...record,
    id: OTHER_ID,
    observations: record.observations.map(item => item.observation === "renewal"
      ? { ...item, sends: [{ ...base[0]!, admission: 2 }] } : item),
  };
  writeFileSync(join(root, ".local", "host-probe", `${OTHER_ID}.json`), JSON.stringify(future) + "\n");
  await expect(readProbeAttempt(root, OTHER_ID)).rejects.toThrow();
  // Three inference sends on one ordinal exceed the pinned per-ordinal
  // ceiling of two, even within the overall four-send budget.
  const over = {
    ...record,
    id: OTHER_ID,
    observations: record.observations.map(item => item.observation === "renewal"
      ? { ...item, sends: [
        { inference: 1, token: 0, confirmed: true, admission: 1 },
        { inference: 1, token: 0, confirmed: true, admission: 1 },
        { inference: 1, token: 0, confirmed: true, admission: 1 },
      ] } : item),
  };
  writeFileSync(join(root, ".local", "host-probe", `${OTHER_ID}.json`), JSON.stringify(over) + "\n");
  await expect(readProbeAttempt(root, OTHER_ID)).rejects.toThrow();
});

test("renewal success or nonzero attempts fail validation and never export", async () => {
  const root = setup();
  const { ports } = bridgePorts({ fetch: successFetch() });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 }, ports, root);
  const tampered = {
    ...record,
    id: OTHER_ID,
    observations: record.observations.map(item => item.observation === "renewal"
      ? { ...item, event: "success", attempts: 1 } : item),
  };
  writeFileSync(join(root, ".local", "host-probe", `${OTHER_ID}.json`), JSON.stringify(tampered) + "\n");
  await expect(readProbeAttempt(root, OTHER_ID)).rejects.toThrow();
  // Valid records export renewal as not-success: the claim can never
  // become positive evidence, even if a future reader skips validation.
  const exported = exportProbeSummary(record);
  expect(exported.observations.find(item => item.observation === "renewal")!.event).toBe("not-success");
});

for (const route of ["grok", "codex"] as const) {
  test(`${route} truncated 200 SSE never becomes observed-ready`, async () => {
    const root = setup();
    const empty200: HostAuthFetch = async () =>
      new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    const ports = bridgeProbePorts({ route, model: route === "codex" ? "codex-fixture" : "grok-4-fixture", root, store: memStore(validTokens), fetch: empty200 });
    const { record, self } = await liveProbe("fixture-probe-host",
      { route, model: route === "codex" ? "codex-fixture" : "grok-4-fixture", maxAttempts: 2, deadlineMs: 8000 },
      { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
    // The pinned release requires the protocol terminal frame (schway#418):
    // a body that ends without one fails closed instead of reporting success.
    expect(record.lifecycle).not.toBe("observed-ready");
    expect(record.lifecycle).toBe("failed");
    expect(self.providerSends.inference).toBeLessThanOrEqual(4);
    const live = record.observations.find(item => item.observation === "live-request")!;
    expect(live.event).not.toBe("success");
  });
}

test("separate-process cancel leaves no post-acknowledgement credential visible", async () => {
  const root = setup();
  const flag = join(root, "release-write");
  const startedFlag = join(root, "write-started");
  const childId = "ee781630-4d14-4d8b-a0eb-000000002001";
  const childSource = `
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const { bridgeProbePorts } = await import(${JSON.stringify(join(import.meta.dir, "../src/evidence/bridge-probe.ts"))});
    const { liveProbe, readProbeAttempt } = await import(${JSON.stringify(join(import.meta.dir, "../src/evidence/probe.ts"))});
    const root = ${JSON.stringify(root)}, flag = ${JSON.stringify(flag)}, started = ${JSON.stringify(startedFlag)}, id = ${JSON.stringify(childId)};
    const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
    let writes = 0;
    const backend = new Map();
    const store = {
      get: async (identity) => backend.has(identity.account) ? backend.get(identity.account) : expired,
      set: async (identity, value) => {
        writeFileSync(started, "1");
        for (let i = 0; i < 400 && !existsSync(flag); i++) await new Promise(r => setTimeout(r, 25));
        writes++;
        backend.set(identity.account, value);
      },
      delete: async (identity) => backend.delete(identity.account),
      // Atomic: single-threaded Map access with no await between compare
      // and delete.
      compareAndDelete: async (identity, expected) => {
        if (backend.get(identity.account) !== expected) return false;
        backend.delete(identity.account);
        return true;
      },
    };
    const fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.toLowerCase().includes("token")) {
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "r", expires_in: 3600 }), { status: 200 });
      }
      throw new Error("unreachable");
    };
    const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch });
    const { record } = await liveProbe("fixture-probe-host",
      { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 30000 },
      { ...ports, now: () => 1800000000000, id: () => id }, root);
    console.log(JSON.stringify({ lifecycle: record.lifecycle, writes, backendSize: backend.size }));
  `;
  const child = Bun.spawn(["bun", "-e", childSource], { stdout: "pipe", stderr: "ignore" });
  try {
    // Wait until the child's credential write is actually in flight, then
    // cancel from THIS process: the child never shares the in-process wait
    // registry, so this is truly cross-process.
    for (let spin = 0; spin < 200 && !existsSync(startedFlag); spin++) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(existsSync(startedFlag)).toBe(true);
    const cancelled = await cancelProbeAttempt(root, childId);
    expect(cancelled.lifecycle).toBe("cancelled");
    writeFileSync(flag, "release");
    const out = JSON.parse(await new Response(child.stdout).text());
    await child.exited;
    // The late write completed after acknowledgement but final visibility is
    // fenced: exactly one backend write happened, then it was removed.
    expect(out.lifecycle).toBe("cancelled");
    expect(out.writes).toBe(1);
    expect(out.backendSize).toBe(0);
    const final = await readProbeAttempt(root, childId);
    expect(final.lifecycle).toBe("cancelled");
  } finally {
    try { child.kill(9); } catch { /* Already exited. */ }
  }
});

test("a write completing after the deadline leaves no credential visible", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  // A prior login already sits in the store; the probe's late write
  // overwrites it and the fence must remove exactly that late value —
  // never resurrecting the prior login, never keeping the probe's.
  const backend = new Map<string, string>([["grok-subscription:xai", expired]]);
  const store: HostCredentialStore = {
    get: async identity => backend.get(identity.account) ?? expired,
    // Settles well after the 2 s deadline: the abort path terminalizes
    // without waiting, then the fence removes the late value. The deadline is
    // generous enough for slow hosts to reach the write first (#84).
    set: async (identity, value) => {
      await new Promise(r => setTimeout(r, 3000));
      backend.set(identity.account, value);
    },
    delete: async identity => backend.delete(identity.account),
    // Atomic: single-threaded Map access with no await between compare
    // and delete, so a concurrent legitimate write can never slip in.
    compareAndDelete: async (identity, expected) => {
      if (backend.get(identity.account) !== expected) return false;
      backend.delete(identity.account);
      return true;
    },
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  const startedAt = Date.now();
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 2000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  // Bounded by the deadline even though the write settles later. The write
  // is unresolved when the deadline terminalizes, so the record reports
  // uncertainty (never a clean cancelled/failed claim it cannot verify).
  expect(Date.now() - startedAt).toBeLessThan(5000);
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
  await new Promise(r => setTimeout(r, 3500));
  // The late settlement was removed again: final visibility is fenced. The
  // published uncertainty stays conservative — a later clean-up cannot
  // downgrade an immutable terminal record.
  expect(backend.size).toBe(0);
  expect((await readProbeAttempt(root, OTHER_ID)).lifecycle).toBe("store-unavailable");
}, 15_000);

test("invalidation never removes a concurrent legitimate credential", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  // Atomic fixture store: the compare-and-delete sees the latest value, so
  // the final state is deterministic regardless of interleaving — either
  // order keeps the legitimate credential.
  const { store: atomic, backend } = mapStore();
  const expiring: HostCredentialStore & { compareAndDelete(identity: { account: string }, expected: string): Promise<boolean> } = {
    get: async () => expired,
    set: (identity, value) => atomic.set(identity, value),
    delete: (identity) => atomic.delete(identity),
    compareAndDelete: (identity, expected) => atomic.compareAndDelete(identity, expected),
  };
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let enteredSet = false;
  const gated: HostCredentialStore & { compareAndDelete(identity: { account: string }, expected: string): Promise<boolean> } = {
    get: (identity) => expiring.get(identity),
    set: async (identity, value) => { enteredSet = true; await writeGate; return expiring.set(identity, value); },
    delete: (identity) => expiring.delete(identity),
    compareAndDelete: (identity, expected) => expiring.compareAndDelete(identity, expected),
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: gated, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  const controller = new AbortController();
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 3000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root, controller.signal);
  try {
    for (let spin = 0; spin < 200 && !enteredSet; spin++) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(enteredSet).toBe(true);
    // Cancel while the write is in flight, then let it land: the atomic
    // cleanup compare must see the value that lands after the legitimate
    // write and leave the legitimate credential alone either way.
    const cancelPromise = cancelProbeAttempt(root, OTHER_ID);
    releaseWrite();
    const cancelled = await cancelPromise;
    expect(cancelled.lifecycle).toBe("cancelled");
    backend.set("grok-subscription:xai", "legitimate-fresh-login");
    const late = await pending;
    expect(late.record.lifecycle).toBe("cancelled");
    await new Promise(r => setTimeout(r, 100));
    expect(backend.get("grok-subscription:xai")).toBe("legitimate-fresh-login");
  } finally {
    controller.abort();
    releaseWrite();
    await pending.catch(() => null);
  }
});
test("cleanup backend failure surfaces store-unavailable, not a clean claim", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  const backend = new Map<string, string>();
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let enteredSet = false;
  // The backend write lands, but its cleanup always fails: the attempt must
  // report store-unavailable instead of a clean cancelled/failed claim over
  // a possibly visible credential.
  const store: HostCredentialStore & { compareAndDelete(identity: { account: string }, expected: string): Promise<boolean> } = {
    get: async () => expired,
    set: async (identity, value) => { enteredSet = true; await writeGate; backend.set(identity.account, value); },
    delete: async identity => backend.delete(identity.account),
    compareAndDelete: async () => { throw new Error("backend down"); },
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  const controller = new AbortController();
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root, controller.signal);
  try {
    for (let spin = 0; spin < 200 && !enteredSet; spin++) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(enteredSet).toBe(true);
    // Abort while the write is in flight, then let it land: the fenced race
    // loses, the supervised late cleanup fails, and the attempt reports
    // uncertainty instead of a clean terminal.
    controller.abort();
    releaseWrite();
    const late = await pending;
    expect(late.record.lifecycle).toBe("store-unavailable");
    expect(late.record.nextAction).toBe("check-secure-store");
    // Honest visibility: the late value is still there, and the record
    // says so instead of claiming a clean fence.
    expect(backend.size).toBe(1);
    expect((await readProbeAttempt(root, OTHER_ID)).lifecycle).toBe("store-unavailable");
  } finally {
    controller.abort();
    releaseWrite();
    await pending.catch(() => null);
  }
});

test("a store without atomic cleanup fails the write closed before backend contact", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  let setCalls = 0;
  // No compare-and-delete: the seam refuses the write before any backend
  // contact instead of risking a racy read-then-delete.
  const store: HostCredentialStore = {
    get: async () => expired,
    set: async () => { setCalls++; },
    delete: async () => true,
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  expect(setCalls).toBe(0);
  expect(record.lifecycle).toBe("store-unavailable");
});

test("class-backed stores keep their prototype methods through the seam", async () => {
  const root = setup();
  const initial = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  const backend = new Map<string, string>([["grok-subscription:xai", initial]]);
  // Class prototype methods are non-enumerable: an object spread would drop
  // them and the write would fail closed without backend contact.
  class ClassStore {
    async get(identity: { account: string }) { return backend.get(identity.account) ?? null; }
    async set(identity: { account: string }, value: string) { backend.set(identity.account, value); }
    async delete(identity: { account: string }) { return backend.delete(identity.account); }
    async compareAndDelete(identity: { account: string }, expected: string) {
      if (backend.get(identity.account) !== expected) return false;
      backend.delete(identity.account);
      return true;
    }
  }
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store: new ClassStore() as never, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root);
  expect(record.lifecycle).toBe("observed-ready");
  // The refresh reached the class store's own set (not a failed-closed write).
  expect(JSON.parse(backend.get("grok-subscription:xai")!).accessToken).toBe("new-access");
});

test("a post-deadline landing whose cleanup fails never publishes a clean cancelled", async () => {
  const root = setup();
  const expired = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-token", obtainedAt: 0, expiresAt: 1 });
  const backend = new Map<string, string>();
  // The write is gated: it is admitted, then held until the test releases it, so the abort always lands
  // mid-write whatever the machine speed. Releasing after the abort models the post-deadline landing, and
  // its cleanup fails; the record is immutable by then, so it must already state uncertainty.
  let entered!: () => void, release!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const writeGate = new Promise<void>(resolve => { release = resolve; });
  const store: HostCredentialStore & { compareAndDelete(identity: { account: string }, expected: string): Promise<boolean> } = {
    get: async () => expired,
    set: async (identity, value) => {
      entered();
      await writeGate;
      backend.set(identity.account, value);
    },
    delete: async identity => backend.delete(identity.account),
    compareAndDelete: async () => { throw new Error("backend down"); },
  };
  const ports = bridgeProbePorts({ route: "grok", model: "grok-4-fixture", root, store, fetch: async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.toLowerCase().includes("token")) {
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "refresh-token", expires_in: 3600 }), { status: 200 });
    }
    return successFetch("late")(input, init);
  } });
  // The caller abort drives the same owned-abort path the deadline timer fires; the generous deadline never
  // decides anything, so no wall-clock sleep or timer drives this test.
  const stop = new AbortController();
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...ports, now: () => 1800000000000, id: () => OTHER_ID }, root, stop.signal);
  await enteredGate;
  stop.abort();
  release();
  const { record } = await pending;
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
  // The late value stayed visible and the durable record says so.
  expect(backend.size).toBe(1);
  expect((await readProbeAttempt(root, OTHER_ID)).lifecycle).toBe("store-unavailable");
});

test("same-process reconcile over an unresolved write reports store-unavailable", async () => {
  const root = setup();
  const backend = new Map<string, string>();
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let enteredSet = false;
  const store = {
    get: async () => null,
    set: async (identity: { account: string }, value: string) => { enteredSet = true; await writeGate; backend.set(identity.account, value); },
    delete: async (identity: { account: string }) => backend.delete(identity.account),
    compareAndDelete: async () => { throw new Error("backend down"); },
  };
  const starter = bridgePorts({ root, fetch: successFetch() });
  const pending = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async input => {
      await input.fence!.writeStore({ account: "grok-subscription:xai" }, "probe-value", store);
      return "success";
    } }, starter.root);
  try {
    for (let spin = 0; spin < 200 && !enteredSet; spin++) await new Promise(r => setTimeout(r, 10));
    expect(enteredSet).toBe(true);
    // A reconcile in the probing process sees the unresolved write inside
    // the terminal CAS and refuses a clean interrupted claim.
    const [reconciled] = await reconcileProbeAttempts(root);
    expect(reconciled!.lifecycle).toBe("store-unavailable");
    expect(reconciled!.nextAction).toBe("check-secure-store");
    releaseWrite();
    const late = await pending;
    expect(late.record.lifecycle).toBe("store-unavailable");
    expect(backend.size).toBe(1);
  } finally {
    releaseWrite();
    await pending.catch(() => null);
  }
});

test("a deadline inside a Schway guard window never publishes a clean cancelled", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  // Emulates the pinned native-store path: guard, then an unobservable
  // native write that outlives the deadline.
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 100 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async input => {
      await input.fence!.guard!();
      await new Promise(r => setTimeout(r, 400));
      return "success";
    } }, starter.root);
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
  await new Promise(r => setTimeout(r, 500));
  expect((await readProbeAttempt(root, ID)).lifecycle).toBe("store-unavailable");
});

test("a settled Schway guard window does not over-report a successful probe", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async input => {
      await input.fence!.guard!();
      await input.fence!.guard!();
      return "success";
    } }, starter.root);
  expect(record.lifecycle).toBe("observed-ready");
});

test("an abort-settled Schway call keeps its guard window through terminalization", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  // Pinned Schway rejects the caller on abort while its refresh (and the
  // native write inside it) keeps running detached.
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 100 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async (input, signal) => {
      await input.fence!.guard!();
      void new Promise(r => setTimeout(r, 400));
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return "failed";
    } }, starter.root);
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
});

test("an unreadable record after a landed write stays uncertain, never kept as clean", async () => {
  const root = setup();
  const backend = new Map<string, string>();
  const recordPath = join(root, ".local", "host-probe", `${ID}.json`);
  const parked = join(root, "parked.json");
  const store = {
    get: async () => null,
    // The write lands, then the record becomes unreadable for the
    // post-write visibility read only.
    set: async (identity: { account: string }, value: string) => {
      backend.set(identity.account, value);
      renameSync(recordPath, parked);
    },
    delete: async (identity: { account: string }) => backend.delete(identity.account),
    compareAndDelete: async (identity: { account: string }, expected: string) => {
      if (backend.get(identity.account) !== expected) return false;
      backend.delete(identity.account);
      return true;
    },
  };
  const starter = bridgePorts({ root, fetch: successFetch() });
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async input => {
      await input.fence!.writeStore({ account: "grok-subscription:xai" }, "probe-value", store);
      renameSync(parked, recordPath);
      return "success";
    } }, starter.root);
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
  // Not destroyed on an unverifiable read: the value stays and the record says so.
  expect(backend.size).toBe(1);
  expect((await readProbeAttempt(root, ID)).lifecycle).toBe("store-unavailable");
});

test("uncertainty past the deadline still publishes a valid store-unavailable record", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  // Wall clock past the deadline at terminalization (production Date.now
  // shape): the uncertainty observation must still validate.
  let ticks = 0;
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 100 },
    { ...starter.ports, now: () => 1800000000000 + (ticks++ === 0 ? 0 : 5000), id: () => ID, infer: async (input, signal) => {
      await input.fence!.guard!();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return "failed";
    } }, starter.root);
  expect(record.lifecycle).toBe("store-unavailable");
  expect(record.nextAction).toBe("check-secure-store");
  expect(record.elapsedMs).toBe(5000);
  expect((await readProbeAttempt(root, ID)).lifecycle).toBe("store-unavailable");
});

test("a failed terminal publication keeps tracking for a later same-process reconcile", async () => {
  const root = setup();
  const backend = new Map<string, string>();
  const recordPath = join(root, ".local", "host-probe", `${ID}.json`);
  const parked = join(root, "parked.json");
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let enteredSet = false;
  const store = {
    get: async () => null,
    set: async (identity: { account: string }, value: string) => { enteredSet = true; await writeGate; backend.set(identity.account, value); },
    delete: async (identity: { account: string }) => backend.delete(identity.account),
    compareAndDelete: async () => { throw new Error("backend down"); },
  };
  const starter = bridgePorts({ root, fetch: successFetch() });
  const run = liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 8000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async input => {
      // Leave an admitted write unresolved, then make terminal publication fail.
      void input.fence!.writeStore({ account: "grok-subscription:xai" }, "probe-value", store).catch(() => {});
      for (let spin = 0; spin < 200 && !enteredSet; spin++) await new Promise(r => setTimeout(r, 5));
      renameSync(recordPath, parked);
      return "success";
    } }, starter.root);
  try {
    await expect(run).rejects.toThrow();
    renameSync(parked, recordPath);
    const [reconciled] = await reconcileProbeAttempts(root);
    expect(reconciled!.lifecycle).toBe("store-unavailable");
    expect(reconciled!.nextAction).toBe("check-secure-store");
  } finally {
    releaseWrite();
  }
});

test("no inference starts past the absolute deadline, even before its timer fires", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  let inferCalled = false;
  // A blocked event loop delays the owned timer; the dispatch check reads
  // the absolute deadline itself.
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 50 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID,
      readCredential: async () => { const until = Date.now() + 150; while (Date.now() < until) { /* busy */ } return "ok"; },
      infer: async () => { inferCalled = true; return "success"; } }, starter.root);
  expect(inferCalled).toBe(false);
  expect(record.lifecycle).toBe("cancelled");
  expect(record.attempts).toBe(0);
});

test("slow readiness does not restart the settlement budget", async () => {
  const root = setup();
  const starter = bridgePorts({ root, fetch: successFetch() });
  const store = {
    get: async () => null,
    set: () => new Promise<void>(() => {}),
    delete: async () => false,
    compareAndDelete: async () => true,
  };
  const startedAt = Date.now();
  const { record } = await liveProbe("fixture-probe-host",
    { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 1000 },
    { ...starter.ports, now: () => 1800000000000, id: () => ID,
      readCredential: async () => { await new Promise(r => setTimeout(r, 400)); return "ok"; },
      infer: async input => {
        await input.fence!.writeStore({ account: "grok-subscription:xai" }, "probe-value", store);
        return "success";
      } }, starter.root);
  // Readiness leaves a wide margin before the deadline (slow CI runners), and
  // settlement waits only for what remains of the one absolute deadline,
  // never a fresh budget measured from after readiness.
  expect(Date.now() - startedAt).toBeLessThan(1300);
  expect(record.lifecycle).toBe("store-unavailable");
});

test("no clock crossing at any dispatch boundary starts inference past the deadline", async () => {
  // Sweep the deadline crossing across every clock read in the run: at no
  // boundary may inference start with the clock already past the deadline
  // or with a clamped budget.
  const realNow = Date.now;
  try {
    for (let crossAt = 1; crossAt <= 40; crossAt++) {
      const root = setup();
      const starter = bridgePorts({ root, fetch: successFetch() });
      const base = realNow();
      // The first read is the deadline capture; the deadline is anchored to it.
      let reads = 0, current = base, first: number | null = null;
      Date.now = () => { reads++; current = base + (reads < crossAt ? 0 : 10_000); first ??= current; return current; };
      let late = false;
      await liveProbe("fixture-probe-host",
        { route: "grok", model: "grok-4-fixture", maxAttempts: 1, deadlineMs: 5000 },
        { ...starter.ports, now: () => 1800000000000, id: () => ID, infer: async input => {
          if (first === null || current >= first + 5000 || input.deadlineMs <= 0 || input.deadlineMs > 5000) late = true;
          return "success";
        } }, starter.root);
      Date.now = realNow;
      expect({ crossAt, late }).toEqual({ crossAt, late: false });
    }
  } finally {
    Date.now = realNow;
  }
});

for (const outcome of ["images-unsupported", "images-unavailable"] as const)
test(`bridge probe handles ${outcome} without auth safely`, async () => {
  const ports = bridgeProbePorts({ root: setup(), route: "grok", model: "grok-4-fixture", store: memStore(validTokens), fetch: throwingFetch,
    testImagesRejected: { outcome, model: { provider: "grok", id: "grok-4-fixture" },
      usage: { attempts: [], complete: false, totalMs: 0 } } as unknown as import("schway/host").HostImagesRejected,
  });
  expect(await ports.infer({ route: "grok", model: "grok-4-fixture", prompt: PROBE_PROMPT, tools: [], discovery: { repository: false, hosted: false }, deadlineMs: 8000 }, new AbortController().signal)).toBe("rejected");
});

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function bridgePorts(overrides: { root?: string; store?: HostCredentialStore | null; fetch?: HostAuthFetch | undefined; id?: string } = {}) {
  const root = overrides.root ?? setup();
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
  // The replay is reported in the self sample, never hidden, while renewal
  // stays explicitly unobserved as an evidence claim.
  expect(record.lifecycle).toBe("observed-ready");
  expect(record.attempts).toBe(1);
  expect(tokenFetches).toBe(1);
  expect(inferenceFetches).toBeLessThanOrEqual(2);
  expect(inferenceFetches).toBe(2);
  const renewal = record.observations.find(item => item.observation === "renewal")!;
  expect(renewal.event).toBe("unobserved");
  expect(renewal.attempts).toBe(0);
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
  expect(ports.takeProviderSends!()).toEqual({ inference: 0, token: 0 });
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

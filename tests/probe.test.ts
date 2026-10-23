import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProbePorts, runProbeCommand } from "../src/probe-cli";
import { PROBE_PROMPT, cancelProbeAttempt, commitProbeOutcome, exportProbeSummary, liveProbe, parseLiveOptions, preflightProbe, readProbeAttempt, reconcileProbeAttempts, validateProbeAttempt, type ProbeAttempt, type ProbeEvent, type ProbePorts } from "../src/evidence/probe";
import type { NextAction } from "../src/evidence/contract";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const ID = "ee781630-4d14-4d8b-a0eb-21b276ed5632";
const SECRET = "TOKEN_SENTINEL_must_not_persist";
const OTHER_ID = "ff781630-4d14-4d8b-a0eb-21b276ed5633";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "jit-host-probe-")); roots.push(root);
  mkdirSync(join(root, ".local"), { mode: 0o700 });
  return root;
}

function configFile(root: string, routes: { route: string; model: string | null; configured: boolean }[] = [{ route: "probe-route", model: "probe-model", configured: true }]) {
  const path = ".local/host-probe-config.json";
  writeFileSync(join(root, path), JSON.stringify({ installationLabel: "fixture-probe-host", routes }));
  return path;
}

function ports(overrides: { nowValue?: number; id?: () => string; now?: () => number; readCredential?: ProbePorts["readCredential"]; infer?: ProbePorts["infer"] } = {}): ProbePorts & { calls: { read: number; infer: number }; seen: { prompt: unknown; tools: unknown; discovery: unknown }[]; tick: (ms: number) => void } {
  let nowValue = overrides.nowValue ?? 1800000000000;
  const calls = { read: 0, infer: 0 }, seen: { prompt: unknown; tools: unknown; discovery: unknown }[] = [];
  return { calls, seen,
    tick: (ms: number) => { nowValue += ms; },
    now: overrides.now ?? (() => nowValue),
    id: overrides.id ?? (() => ID),
    readCredential: async signal => { calls.read++; return overrides.readCredential ? overrides.readCredential(signal) : "ok"; },
    infer: async (input, signal) => { calls.infer++; seen.push({ prompt: input.prompt, tools: input.tools, discovery: input.discovery }); return overrides.infer ? overrides.infer(input, signal) : "success"; },
  };
}

test("preflight reports configured-unverified with zero credential or inference invocations", async () => {
  const root = setup(), path = configFile(root), p = ports();
  const result = await runProbeCommand(["preflight", "--config", path], root, p);
  expect(result.exitCode).toBe(0);
  expect(p.calls).toEqual({ read: 0, infer: 0 });
  const record = await readProbeAttempt(root, ID);
  expect(record).toMatchObject({ schema: "jit.host.probe/v1", mode: "preflight", lifecycle: "configured-unverified", attempts: 0, promptBytes: Buffer.byteLength(PROBE_PROMPT) });
  expect(record.observations.map(item => item.observation)).toEqual(["service-start", "credential-read", "live-request", "renewal"]);
  expect(record.observations.every(item => item.event === "unobserved")).toBe(true);
  expect(JSON.stringify(result.output)).not.toContain(SECRET);
  expect(JSON.stringify(result.output)).not.toContain("probe-route");
  const file = join(root, ".local/host-probe", `${ID}.json`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("live mode requires explicit route, model, attempts and deadline before any account request", async () => {
  const root = setup(), path = configFile(root), p = ports();
  const attempts = ["--attempts", "3", "--deadline", "5000"];
  const cases: string[][] = [
    ["live", "--config", path],
    ["live", "--config", path, "--route", "probe-route", ...attempts],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "3"],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "0", "--deadline", "5000"],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "11", "--deadline", "5000"],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "3", "--deadline", "0"],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "3", "--deadline", "60001"],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "2.5", "--deadline", "5000"],
    ["live", "--config", path, "--route", "token-secret-route", "--model", "probe-model", "--attempts", "3", "--deadline", "5000"],
    ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "3", "--deadline", "5000", "--extra", "x"],
    ["preflight", "--config", path, "--route", "probe-route"],
  ];
  for (const args of cases) {
    expect((await runProbeCommand(args, root, p)).exitCode, JSON.stringify(args)).toBe(2);
  }
  expect(p.calls).toEqual({ read: 0, infer: 0 });
  expect(await readProbeAttempt(root, ID).then(() => "persisted").catch(() => "absent")).toBe("absent");
});

test("classifier covers every live outcome with the selected route unchanged and no fallback", async () => {
  const root = setup(), path = configFile(root);
  const table: [ProbeEvent | "thrown" | "malformed", ProbeAttempt["lifecycle"], NextAction][] = [
    ["success", "observed-ready", "none"], ["login", "needs-login", "owner-login"], ["store", "store-unavailable", "check-secure-store"],
    ["quota", "quota-waiting", "wait-for-quota"], ["rejected", "rejected", "review-route-policy"], ["failed", "failed", "inspect-sanitized-failure"],
    ["malformed", "failed", "inspect-sanitized-failure"], ["thrown", "failed", "inspect-sanitized-failure"],
  ];
  for (const [index, [event, state, nextAction]] of table.entries()) {
    const id = `ee781630-4d14-4d8b-a0eb-21b276ed56${index.toString().padStart(2, "0")}`;
    const p = ports({ id: () => id, infer: event === "thrown" ? async () => { throw new Error("transport exploded"); } : async () => event as ProbeEvent });
    const args = ["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "3", "--deadline", "5000"];
    const result = await runProbeCommand(args, root, p);
    expect(result.exitCode).toBe(0);
    const record = await readProbeAttempt(root, id);
    expect(record.lifecycle, event).toBe(state);
    expect(record.nextAction, event).toBe(nextAction);
    // Terminal classifications stop at once; transient store/transport
    // failures consume the full bounded budget with no outer retry.
    expect(record.attempts, event).toBe(event === "success" || event === "login" || event === "quota" || event === "rejected" ? 1 : 3);
    expect(record.observations.find(item => item.observation === "live-request")!.event, event).toBe(event === "thrown" || event === "malformed" ? "failed" : event);
    // Renewal is never inferred from any inference outcome.
    expect(record.observations.find(item => item.observation === "renewal")!.event).toBe("unobserved");
  }
});

test("budget honesty: every admitted request is counted and no outer retry exceeds the maximum", async () => {
  const root = setup();
  let calls = 0;
  const flaky = ports({ id: () => ID, infer: async () => (++calls <= 2 ? "failed" : "success") });
  const first = await liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 5, deadlineMs: 5000 }, flaky, root);
  expect(first.record.lifecycle).toBe("observed-ready");
  expect(first.record.attempts).toBe(3);
  expect(first.self).toMatchObject({ attemptsUsed: 3, maxAttempts: 5 });
  // Exhaustion stops exactly at the maximum with no extra retry.
  const exhausted = ports({ id: () => OTHER_ID, infer: async () => "failed" });
  const second = await liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 2, deadlineMs: 5000 }, exhausted, root);
  expect(second.record.lifecycle).toBe("failed");
  expect(second.record.attempts).toBe(2);
  expect(exhausted.calls.infer).toBe(2);
  // A fixed prompt, empty tools and strict discovery off are dispatched every time.
  for (const input of flaky.seen) {
    expect(input.prompt).toBe(PROBE_PROMPT);
    expect(input.tools).toEqual([]);
    expect(input.discovery).toEqual({ repository: false, hosted: false });
  }
});

test("persistence and restart: started attempts reconcile to interrupted and late success never commits", async () => {
  const root = setup();
  let release!: (event: ProbeEvent) => void;
  const gate = new Promise<ProbeEvent>(resolve => { release = resolve; });
  const gated = ports({ infer: () => gate });
  const pending = liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 3, deadlineMs: 5000 }, gated, root);
  for (let spin = 0; spin < 100 && !(() => { try { readFileSync(join(root, ".local/host-probe", `${ID}.json`)); return true; } catch { return false; } })(); spin++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect((await readProbeAttempt(root, ID)).lifecycle).toBe("started");
  // Restart before completion marks the orphan interrupted.
  expect((await reconcileProbeAttempts(root)).map(record => record.lifecycle)).toEqual(["interrupted"]);
  release("success");
  const late = await pending;
  expect(late.record.lifecycle).toBe("interrupted");
  expect(late.record.observations.find(item => item.observation === "live-request")!.event).toBe("unobserved");
  expect(await commitProbeOutcome(root, ID, late.record.observations, 1, 10)).toBe(false);
  expect((await readProbeAttempt(root, ID)).lifecycle).toBe("interrupted");
});

test("observation separation: credential, inference and renewal evidence never substitute for each other", async () => {
  const root = setup();
  const locked = ports({ id: () => ID, readCredential: async () => "locked", infer: async () => "login" });
  const { record } = await liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 2, deadlineMs: 5000 }, locked, root);
  expect(record.lifecycle).toBe("needs-login");
  const byName = Object.fromEntries(record.observations.map(item => [item.observation, item]));
  expect(byName["credential-read"]).toMatchObject({ probeClass: "preflight", event: "login", state: "needs-login" });
  expect(byName["live-request"]).toMatchObject({ probeClass: "inference", event: "login", state: "needs-login" });
  expect(byName["renewal"]).toMatchObject({ probeClass: "renewal", event: "unobserved", state: "configured-unverified" });
  // A successful login still leaves renewal unobserved and the route waiting for its own inference proof.
  const missing = ports({ id: () => OTHER_ID, readCredential: async () => "missing", infer: async () => "failed" });
  const failed = await liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 1, deadlineMs: 5000 }, missing, root);
  expect(failed.record.observations.find(item => item.observation === "credential-read")).toMatchObject({ event: "store", state: "store-unavailable" });
  expect(failed.record.observations.find(item => item.observation === "renewal")!.event).toBe("unobserved");
});

test("stop and cleanup: owner cancel wins over a late success, with bounded self resources", async () => {
  const root = setup(), path = configFile(root);
  let release!: (event: ProbeEvent) => void;
  const gate = new Promise<ProbeEvent>(resolve => { release = resolve; });
  const gated = ports({ infer: () => gate });
  const pending = liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 3, deadlineMs: 5000 }, gated, root);
  for (let spin = 0; spin < 100 && !(() => { try { readFileSync(join(root, ".local/host-probe", `${ID}.json`)); return true; } catch { return false; } })(); spin++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect((await cancelProbeAttempt(root, ID)).lifecycle).toBe("cancelled");
  release("success");
  const late = await pending;
  expect(late.record.lifecycle).toBe("cancelled");
  expect(late.record.lifecycle).not.toBe("observed-ready");
  const exported = await runProbeCommand(["export", "--id", ID], root, gated);
  expect(exported.exitCode).toBe(0);
  expect(exported.output).toMatchObject({ route: "redacted-local-alias", model: "redacted", lifecycle: "cancelled" });
  const full = JSON.stringify(late.record);
  expect(full).not.toContain(SECRET);
  // Deadlines past the classifier bound fail honestly instead of recording readiness.
  const slow = ports({ id: () => OTHER_ID, nowValue: 1800000000000, infer: async () => "success" });
  const expired = await liveProbe("fixture-probe-host", { route: "probe-route", model: "probe-model", maxAttempts: 1, deadlineMs: 100 },
    { ...slow, now: (() => { let calls = 0; return () => 1800000000000 + (++calls === 1 ? 0 : 5000); })() }, root);
  expect(expired.record.lifecycle).toBe("failed");
  expect(expired.self.elapsedMs).toBe(5000);
  void path;
});

test("default command ports fail closed with no secret reads, network or environment access", async () => {
  const root = setup(), path = configFile(root), ports = defaultProbePorts();
  expect(await ports.readCredential(new AbortController().signal)).toBe("missing");
  expect(await ports.infer({ route: "probe-route", model: "probe-model", prompt: PROBE_PROMPT, tools: [], discovery: { repository: false, hosted: false }, deadlineMs: 100 }, new AbortController().signal)).toBe("failed");
  const result = await runProbeCommand(["live", "--config", path, "--route", "probe-route", "--model", "probe-model", "--attempts", "2", "--deadline", "5000"], root, ports);
  expect(result.exitCode).toBe(0);
  expect(result.output).toMatchObject({ lifecycle: "failed", self: { attemptsUsed: 2, maxAttempts: 2 } });
  expect(JSON.stringify(result)).not.toMatch(/TOKEN|SECRET|Bearer|192\.0\.2/);
});

test("malformed records and tampered success cannot be persisted or exported", async () => {
  const root = setup();
  const p = ports();
  const { record } = await preflightProbe("fixture-probe-host", "probe-route", "probe-model", p, root);
  expect(() => validateProbeAttempt({ ...record, lifecycle: "observed-ready" })).toThrow();
  expect(() => validateProbeAttempt({ ...record, observations: record.observations.slice(0, 3) })).toThrow();
  expect(() => parseLiveOptions({ route: "probe-route", model: "probe-model", maxAttempts: 3, deadlineMs: 5000, extra: true })).toThrow();
  expect(exportProbeSummary(record)).toMatchObject({ route: "redacted-local-alias", model: "redacted", lifecycle: "configured-unverified" });
  expect(JSON.stringify(exportProbeSummary(record))).not.toContain("probe-route");
});

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvidenceCommand } from "../src/evidence-cli";
import { exportSummary, routeEvidence, validateEvidence, type HostEvidence } from "../src/evidence/contract";
import { inventory, localPorts, parseConfig, type InventoryPorts } from "../src/evidence/inventory";
import { readEvidence, writeEvidence } from "../src/evidence/records";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = "ee781630-4d14-4d8b-a0eb-21b276ed5632";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "jit-evidence-fixture-")); roots.push(root);
  mkdirSync(join(root, ".local"), { mode: 0o700 }); mkdirSync(join(root, ".local/state"));
  const config = { installationLabel: "fixture-host", context: "service", testedPath: "/fixture/path", workingDirectory: root,
    stateDirectory: ".local/state", deadlineMs: 100, routes: [{ route: "codex-subscription", model: "gpt-6.1-sol", configured: true }, { route: "grok-subscription", model: null, configured: false }] };
  writeFileSync(join(root, ".local/config.json"), JSON.stringify(config)); return { root, config };
}
function ports(): InventoryPorts {
  return { now: () => 1800000000000, id: () => id,
    host: () => ({ os: "linux", architecture: "arm64", kernel: "6.8.0-1018-raspi", bun: "1.4.2", uid: 12345, effectiveUid: 12345 }),
    bunOnPath: async () => ({ found: true, version: "1.4.2" }), directories: async () => ({ workingDirectory: "ready", persistentState: "writable" }),
    dependencies: async () => [{ name: "typescript", declared: "7.0.2", installed: "7.0.2", compatibility: "unverified" }] };
}
const command = (root: string, mode: string) => Bun.spawn([process.execPath, "tests/fixtures/evidence-cli.ts", root, mode], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: {} });

test("command fixtures emit bounded ARM64/x64, missing-PATH, malformed and unwritable observations without claiming readiness", async () => {
  for (const mode of ["arm64", "x64", "missing", "malformed", "unwritable"]) {
    const { root } = setup(), child = command(root, mode);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stderr).toBe("");
    const summary = JSON.parse(stdout), record = await readEvidence(root, summary.evidenceId);
    expect(record.id).toBe(id); expect(record.observedAt).toBe("2027-01-15T08:00:00.000Z");
    expect(record.inventory.architecture).toBe(mode === "x64" ? "x64" : "arm64");
    expect(record.inventory.testedPathBun.state).toBe(mode === "missing" ? "absent-on-tested-PATH" : mode === "malformed" ? "unverified" : "installed");
    expect(record.inventory.processBun).toBe("1.4.2"); expect(record.inventory.dependencies[0]!.compatibility).toBe("unverified");
    expect(record.routes.map(r => r.state)).toEqual(["configured-unverified", "not-configured"]);
    expect(record.outcome).toBe("blocked"); expect(record.inventory.context).toBe("service"); expect(record.inventory.identity.uid).toBe(12345);
    expect(summary.nextAction).toBe(mode === "missing" || mode === "malformed" ? "check-runtime-path" : mode === "unwritable" ? "provide-writable-state-directory" : "verify-dependencies-on-target");
    expect(stdout).not.toMatch(/fixture-host|codex-subscription|gpt-6\.1-sol|12345|TOKEN_SENTINEL|192\.0\.2\.44|Authorization|PATH=/);
    const file = join(root, ".local/host-evidence", `${id}.json`); expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(file).size).toBeLessThan(32768);
  }
});

test("route classifier separates all route states, fixtures and lifecycle observations from actual bounded inference", () => {
  const base = { route: "codex-subscription", model: "gpt-6.1-sol", observation: "live-request" as const, probeClass: "inference" as const, maxAttempts: 2, attempts: 1, deadlineMs: 500, elapsedMs: 20, configured: true };
  for (const [event, state, action] of [["unobserved", "configured-unverified", "run-opt-in-probe"], ["success", "observed-ready", "none"], ["login", "needs-login", "owner-login"], ["store", "store-unavailable", "check-secure-store"], ["quota", "quota-waiting", "wait-for-quota"], ["rejected", "rejected", "review-route-policy"], ["failed", "failed", "inspect-sanitized-failure"]] as const) {
    const row = routeEvidence({ ...base, event }); expect(row.state).toBe(state); expect(row.nextAction).toBe(action);
  }
  expect(routeEvidence({ ...base, event: "success", configured: false }).state).toBe("not-configured");
  for (const observation of ["fixture", "credential-read", "renewal", "restart", "reboot", "service-start"] as const) expect(routeEvidence({ ...base, observation, event: "success" }).state).toBe("configured-unverified");
  expect(routeEvidence({ ...base, probeClass: "preflight", event: "success" }).state).toBe("configured-unverified");
  expect(routeEvidence({ ...base, elapsedMs: 501, event: "success" }).state).toBe("failed");
  for (const change of [{ maxAttempts: 0 }, { maxAttempts: Infinity }, { attempts: 3 }, { attempts: 0 }, { deadlineMs: 0 }, { deadlineMs: Infinity }, { elapsedMs: -1 }]) expect(() => routeEvidence({ ...base, ...change, event: "success" })).toThrow();
});

test("malformed process values and thrown diagnostics never become persisted or exported artifacts", async () => {
  const { root, config } = setup(), p = ports(), sentinel = "Authorization: Bearer TOKEN_SENTINEL ssh://user@192.0.2.44 PATH=/private/credential";
  p.host = () => ({ os: sentinel, architecture: sentinel, kernel: sentinel, bun: sentinel, uid: sentinel as unknown as number, effectiveUid: null });
  p.bunOnPath = async () => { throw new Error(sentinel); };
  p.directories = async () => { throw new Error(sentinel); };
  p.dependencies = async () => [{ name: "typescript", declared: "7.0.2", installed: sentinel, compatibility: "unverified" }];
  const result = await runEvidenceCommand(["inventory", "--config", ".local/config.json"], root, p);
  expect(result.exitCode).toBe(0); const record = await readEvidence(root, id);
  expect(record.inventory.os).toBe("unverified"); expect(record.inventory.testedPathBun.state).toBe("unverified");
  expect(record.inventory.workingDirectory).toBe("unverified"); expect(record.inventory.dependencies[0]!.installed).toBeNull();
  expect(JSON.stringify([record, result])).not.toMatch(/TOKEN_SENTINEL|192\.0\.2\.44|Authorization|credential|PATH=/);
  const exported = await runEvidenceCommand(["export", "--id", id], root, p); expect(exported.exitCode).toBe(0); expect(exported.output).toEqual(exportSummary(record));
  expect(JSON.stringify(exported)).not.toContain(root); expect(JSON.stringify(record)).not.toContain(config.testedPath);
});

test("invalid/oversized local config and records reject with fixed next actions; no unsafe export or partial new evidence", async () => {
  const { root, config } = setup(), evidence = await inventory(parseConfig(config, root), ports());
  for (const invalid of [{ ...evidence, rawBody: "TOKEN_SENTINEL" }, { ...evidence, installationLabel: "ssh://user@192.0.2.44" }, { ...evidence, inventory: { ...evidence.inventory, environment: { TOKEN: "TOKEN_SENTINEL" } } }, { ...evidence, routes: Array(900).fill(evidence.routes[0]) }]) {
    expect(() => validateEvidence(invalid)).toThrow(); await expect(writeEvidence(root, invalid)).rejects.toThrow();
  }
  expect(readdirSync(join(root, ".local")).sort()).toEqual(["config.json", "state"]);
  await writeEvidence(root, evidence); await expect(writeEvidence(root, evidence)).rejects.toThrow(); expect(await readEvidence(root, id)).toEqual(evidence);
  writeFileSync(join(root, ".local/host-evidence", `${id}.json`), JSON.stringify({ ...evidence, token: "TOKEN_SENTINEL" }));
  const out = await runEvidenceCommand(["export", "--id", id], root, ports()); expect(out.exitCode).toBe(2); expect(JSON.stringify(out)).not.toContain("TOKEN_SENTINEL");
  writeFileSync(join(root, ".local/config.json"), "TOKEN_SENTINEL".repeat(900));
  const failed = await runEvidenceCommand(["inventory", "--config", ".local/config.json"], root, ports()); expect(failed.exitCode).toBe(2); expect(JSON.stringify(failed)).not.toContain("TOKEN_SENTINEL");
  for (const args of [["login", "--config", "x"], ["inference", "--config", "x"], ["inventory", "--install", "true"], ["inventory", "--config", "x", "--reboot"]]) expect((await runEvidenceCommand(args, root, ports())).exitCode).toBe(2);
});

test("local storage/config symlinks and unavailable evidence store fail safely without overwriting other files", async () => {
  const { root, config } = setup(); writeFileSync(join(root, ".local/host-evidence"), "existing");
  const result = await runEvidenceCommand(["inventory", "--config", ".local/config.json"], root, ports());
  expect(result.exitCode).toBe(2); expect(result.output).toMatchObject({ stored: false, outcome: "failed", nextAction: "check-local-evidence-directory" });
  expect(readFileSync(join(root, ".local/host-evidence"), "utf8")).toBe("existing");
  const outside = join(root, "outside.json"); writeFileSync(outside, JSON.stringify(config));
  expect((await runEvidenceCommand(["inventory", "--config", outside], root, ports())).exitCode).toBe(2);
  symlinkSync(outside, join(root, ".local/alias.json")); expect((await runEvidenceCommand(["inventory", "--config", ".local/alias.json"], root, ports())).exitCode).toBe(2);
  rmSync(join(root, ".local"), { recursive: true }); mkdirSync(join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), join(root, ".local"));
  await expect(writeEvidence(root, await inventory(parseConfig(config, root), ports()))).rejects.toThrow(); expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
});

test("current-host ports test explicit missing/alternate PATH and writable state without network or leaked process output", async () => {
  const { root, config } = setup(), p = localPorts(), network = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network_not_authorized"); }) as unknown as typeof fetch;
  try {
    const empty = await inventory(parseConfig({ ...config, testedPath: "" }, root), p);
    expect(empty.inventory.processBun).toBe(Bun.version); expect(empty.inventory.testedPathBun.state).toBe("absent-on-tested-PATH");
    mkdirSync(join(root, "bin")); symlinkSync(process.execPath, join(root, "bin/bun"));
    const installed = await inventory(parseConfig({ ...config, testedPath: join(root, "bin"), deadlineMs: 2000 }, root), p);
    expect(installed.inventory.testedPathBun).toEqual({ state: "installed", version: Bun.version }); expect(installed.inventory.persistentState).toBe("writable");
    expect(readdirSync(join(root, ".local/state"))).toEqual([]); expect(installed.inventory.dependencies.every(d => d.compatibility === "unverified")).toBe(true);
    rmSync(join(root, "bin/bun")); writeFileSync(join(root, "bin/bun"), '#!/bin/sh\nprintf "Authorization: Bearer TOKEN_SENTINEL 192.0.2.44\\n"\n', { mode: 0o700 });
    const malformed = await inventory(parseConfig({ ...config, testedPath: join(root, "bin") }, root), p); expect(malformed.inventory.testedPathBun.state).toBe("unverified"); expect(JSON.stringify(malformed)).not.toMatch(/TOKEN_SENTINEL|192\.0\.2\.44|Authorization/);
    writeFileSync(join(root, "not-a-directory"), "fixture");
    const unavailable = await inventory(parseConfig({ ...config, testedPath: "", stateDirectory: "not-a-directory" }, root), p); expect(unavailable.inventory.persistentState).toBe("unavailable");
  } finally { globalThis.fetch = network; }
});

test("bounded inventory aborts a stalled version process and preserves an honest unverified record", async () => {
  const { root, config } = setup(); mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/bun"), "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n", { mode: 0o700 });
  const start = Date.now(), evidence = await inventory(parseConfig({ ...config, testedPath: join(root, "bin"), deadlineMs: 100 }, root), localPorts());
  expect(Date.now() - start).toBeLessThan(2000); expect(evidence.inventory.testedPathBun.state).toBe("unverified"); expect(evidence.nextAction).toBe("check-runtime-path");
});

test("versioned envelope can retain separately classified bounded route observations without claiming whole-host compatibility", async () => {
  const { root, config } = setup(); const record: HostEvidence = await inventory(parseConfig(config, root), ports());
  record.observation = "live-request"; record.routes = [routeEvidence({ route: "codex-subscription", model: "gpt-6.1-sol", configured: true, observation: "live-request", probeClass: "inference", maxAttempts: 1, attempts: 1, deadlineMs: 100, elapsedMs: 20, event: "success" })];
  validateEvidence(record); await writeEvidence(root, record); expect((await readEvidence(root, id)).routes[0]!.state).toBe("observed-ready");
  record.observation = "fixture"; expect(() => validateEvidence(record)).toThrow();
});

test("standalone CLI inventory then export works in an explicit disposable local installation", async () => {
  const { root, config } = setup(); writeFileSync(join(root, ".local/config.json"), JSON.stringify({ ...config, testedPath: "" }));
  const cli = join(import.meta.dir, "../src/evidence-cli.ts");
  const run = async (args: string[]) => {
    const process = Bun.spawn([Bun.which("bun")!, cli, ...args], { cwd: root, env: {}, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(stderr).toBe(""); return { stdout, exit };
  };
  const result = await run(["inventory", "--config", ".local/config.json"]); expect(result.exit).toBe(0);
  const summary = JSON.parse(result.stdout); expect(summary.stored).toBe(true); expect(summary.inventory.testedPathBun.state).toBe("absent-on-tested-PATH");
  const exported = await run(["export", "--id", summary.evidenceId]); expect(exported.exit).toBe(0);
  expect(JSON.parse(exported.stdout)).toEqual(exportSummary(await readEvidence(root, summary.evidenceId)));
  expect(exported.stdout).not.toMatch(/fixture-host|codex-subscription|gpt-6\.1-sol|workingDirectory.*jit-evidence-fixture/);
});

test("FIFO configuration and evidence files reject without blocking the standalone command", async () => {
  const { root } = setup(), cli = join(import.meta.dir, "../src/evidence-cli.ts");
  const check = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd: root, env: {}, stdout: "pipe", stderr: "pipe", timeout: 1000, killSignal: 9 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(2); expect(stderr).toBe(""); expect(JSON.parse(stdout)).toMatchObject({ error: "evidence-unavailable", nextAction: "check-local-configuration-and-inventory" });
  };
  rmSync(join(root, ".local/config.json"));
  expect(Bun.spawnSync(["mkfifo", "-m", "600", join(root, ".local/config.json")]).exitCode).toBe(0);
  await check(["inventory", "--config", ".local/config.json"]);
  mkdirSync(join(root, ".local/host-evidence"), { mode: 0o700 });
  expect(Bun.spawnSync(["mkfifo", "-m", "600", join(root, ".local/host-evidence", `${id}.json`)]).exitCode).toBe(0);
  await check(["export", "--id", id]);
});

test("dependency versions resolve from an encoded space/Thai checkout path", async () => {
  const { root } = setup(), checkout = join(root, "Jit MVP #ภาษาไทย"), repo = join(import.meta.dir, "..");
  mkdirSync(join(checkout, "src"), { recursive: true });
  cpSync(join(repo, "src/evidence"), join(checkout, "src/evidence"), { recursive: true });
  cpSync(join(repo, "src/evidence-cli.ts"), join(checkout, "src/evidence-cli.ts")); cpSync(join(repo, "package.json"), join(checkout, "package.json"));
  symlinkSync(join(repo, "node_modules"), join(checkout, "node_modules"));
  const child = Bun.spawn([process.execPath, join(checkout, "src/evidence-cli.ts"), "inventory", "--config", ".local/config.json"], { cwd: root, env: {}, stdout: "pipe", stderr: "pipe", timeout: 2000, killSignal: 9 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0); expect(stderr).toBe("");
  expect(JSON.parse(stdout).inventory.dependencies).toEqual([
    { name: "typescript", declared: "7.0.2", installed: "7.0.2", compatibility: "unverified" },
    { name: "@types/bun", declared: "1.4.3", installed: "1.4.3", compatibility: "unverified" },
  ]);
  rmSync(join(checkout, "node_modules")); mkdirSync(join(checkout, "node_modules/typescript"), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", "-m", "600", join(checkout, "node_modules/typescript/package.json")]).exitCode).toBe(0);
  const fifo = Bun.spawn([process.execPath, join(checkout, "src/evidence-cli.ts"), "inventory", "--config", ".local/config.json"], { cwd: root, env: {}, stdout: "pipe", stderr: "pipe", timeout: 2000, killSignal: 9 });
  const [fifoOut, fifoErr, fifoExit] = await Promise.all([new Response(fifo.stdout).text(), new Response(fifo.stderr).text(), fifo.exited]);
  expect(fifoExit).toBe(0); expect(fifoErr).toBe(""); expect(JSON.parse(fifoOut).inventory.dependencies.every((d: { installed: unknown }) => d.installed === null)).toBe(true);
});

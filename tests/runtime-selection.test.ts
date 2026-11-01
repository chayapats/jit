import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { selectRuntime } from "../src/runtime-selection";
import { parseServiceConfig, renderServiceUnit } from "../ops/package/service-config";
import { S14Store, s14ApplicationId, s14SchemaVersion } from "../src/s14/store";

const roots: string[] = [], source = resolve(import.meta.dir, ".."), main = join(source, "src/main.ts");
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-runtime-selection-")); roots.push(root);
  return root;
}
async function run(root: string, args: string[], env: NodeJS.ProcessEnv = {}, entry = main, preload?: string) {
  const child = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), entry, ...args], {
    cwd: root, env: { PATH: process.env.PATH, ...env }, stdin: new TextEncoder().encode("fixture-owner-password-267\n"), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
  return { stdout, stderr, code };
}
function snapshot(root: string): unknown {
  const visit = (path: string): unknown => {
    const stat = lstatSync(path);
    return { mode: stat.mode, bytes: stat.isFile() ? readFileSync(path).toString("hex") : null,
      entries: stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map(name => [name, visit(join(path, name))])) : null };
  };
  return visit(root);
}
function legacyConfig(root: string) {
  return { serviceUser: "jit", executablePath: join(root, "opt/jit/current"), workingDirectory: join(root, "work"), stateDirectory: join(root, "state"),
    ledgerPath: join(root, "ledger/checkpoint.json"), backupDirectory: join(root, "backups"), routes: [], secretRefs: [],
    network: { bindHost: "127.0.0.1", port: 3000, vpnInterface: null }, resources: { memoryMaxBytes: 268435456, maxRestarts: 5, restartWindowSeconds: 300, logBytes: 16777216, retentionDays: 14 } };
}

test("bare setup and --s14 create the same independent S14 format; --legacy keeps its own format", async () => {
  for (const flags of [[], ["--s14"], ["--legacy"]]) {
    const root = fixture(), result = await run(root, ["setup", ...flags, "--password-stdin"]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const legacy = flags.includes("--legacy"), path = join(root, legacy ? ".local/jit.sqlite" : ".local/s14/application.sqlite");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, legacy ? ".local/s14" : ".local/jit.sqlite"))).toBe(false);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query<{ application_id: number }, []>("PRAGMA application_id").get()!.application_id).toBe(legacy ? 0 : s14ApplicationId);
      if (!legacy) {
        expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(s14SchemaVersion);
        expect(db.query("SELECT name FROM sqlite_master WHERE name='projects'").get()).toBeNull();
        expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM owner").get()!.count).toBe(1);
      }
    } finally { db.close(); }
    expect(result.stdout).not.toContain("?token=");
    if (!legacy) {
      const ops = await run(root, ["ops", ...flags, "--password-stdin"]);
      expect({ code: ops.code, stderr: ops.stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(ops.stdout)).toMatchObject({ backups: [], stage: null, workers: "stopped" });
    }
  }
});

test("normal default serve/setup loads no legacy application/config/store or CLI", async () => {
  const root = fixture(), copy = join(root, "source"); mkdirSync(copy);
  cpSync(join(source, "src"), join(copy, "src"), { recursive: true });
  cpSync(join(source, "ops/package"), join(copy, "ops/package"), { recursive: true });
  symlinkSync(join(source, "node_modules"), join(copy, "node_modules"));
  for (const name of ["application", "config", "store", "app-cli"]) writeFileSync(join(copy, `src/${name}.ts`), 'throw new Error("legacy_module_imported");\n');
  const entry = join(copy, "src/main.ts"), preload = join(source, "tests/fixtures/s14-service-preload.ts");
  const result = await run(root, ["serve"], { JIT_ORIGIN: "invalid legacy config", JIT_RUN_PORT: "invalid", JIT_S14_ORIGIN: "http://localhost:3001" }, entry, preload);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ state: "s14_listening", origin: "http://localhost:3001" });
  const setup = await run(root, ["setup", "--password-stdin"], {}, entry);
  expect(setup.code).toBe(0); expect(setup.stderr).toBe("");
  const db = new S14Store(join(root, ".local/s14/application.sqlite"));
  try { expect(db.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM owner"))!.count).toBe(1); }
  finally { db.close(); }
});

test("old canonical config omission selects legacy and preserves the immutable unit argv", async () => {
  const root = fixture(), config = legacyConfig(root), path = join(root, "service.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  expect(parseServiceConfig(config).runtime).toBeUndefined();
  expect(JSON.stringify(parseServiceConfig(config))).not.toContain('"runtime"');
  expect(selectRuntime(["serve", "--service-config", path], {})).toEqual({ runtime: "legacy", args: ["serve", "--service-config", path] });
  const unit = await renderServiceUnit(config, { bunPath: process.execPath, configPath: path });
  expect(unit).toContain(`ExecStart=${process.execPath} ${config.executablePath}/src/main.ts serve --service-config ${path}`);
  expect(unit).not.toContain("--legacy"); expect(unit).not.toContain("--s14");
  // The real old invocation reaches legacy preflight, which refuses missing installation prerequisites on the selected legacy state.
  const result = await run(root, ["serve", "--service-config", path]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("Service blocked at");
  expect(existsSync(join(root, ".local/s14"))).toBe(false); expect(existsSync(join(config.stateDirectory, "application.sqlite"))).toBe(false);
  expect(selectRuntime(["upgrade", "--service-config", path, "--password-stdin"], {}).runtime).toBe("legacy");
  expect(selectRuntime(["service", "status"], {}).runtime).toBe("service");
});

test("selectors, invalid commands/flags and named-config mismatches refuse before any installation bytes change", async () => {
  const root = fixture(), old = join(root, "legacy"), s14 = join(root, "fresh/application.sqlite"); mkdirSync(old);
  for (const name of ["app.sqlite", "app.sqlite-wal", "app.sqlite-shm", "ledger", "native", "profile", "backup"]) writeFileSync(join(old, name), `retained ${name}`);
  const config = legacyConfig(root), path = join(root, "legacy.json"); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const spath = join(root, "s14.json");
  writeFileSync(spath, JSON.stringify({ ...config, runtime: "s14", runPort: "schway", network: { ...config.network, port: 3001 },
    s14: { vaultDirectory: join(root, "vault"), computerRoot: join(root, "computers"), gitScratch: join(root, "scratch") } }), { mode: 0o600 });
  const before = snapshot(root);
  for (const args of [
    ["setup", "--s14", "--legacy"], ["setup", "--legacy", "--legacy"], ["serve", "--s14", "--s14"], ["unknown"],
    ["reset-owner"], ["upgrade"], ["ask", "hello"], ["setup", "--legacy", "--unknown"], ["serve", "--unknown"],
    ["serve", "setup"], ["setup", "--password-stdin", "--password-stdin"], ["serve", "--refusal-page", "--no-refusal-page"],
    ["ops", "--command"], ["ops", "--command", "a", "--command", "b"], ["serve", "--service-config"],
    ["serve", "--service-config", path, "--service-config", path], ["serve", "--s14", "--service-config", path],
    ["serve", "--legacy", "--service-config", spath], ["serve", "--service-config", spath],
    ["owner-link", "--output-fd", "3"], ["owner-link", "--s14", "--output-fd", "4"], ["owner-link", "--s14", "--s14", "--output-fd", "3"],
    ["service", "status", "--s14"],
  ]) {
    const result = await run(root, args, { JIT_DATABASE: join(old, "app.sqlite"), JIT_S14_DATABASE: s14 });
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("?token=");
    expect(snapshot(root)).toEqual(before);
  }
  expect((await run(root, ["setup", "--password-stdin"], { JIT_DATABASE: join(old, "app.sqlite"), JIT_S14_DATABASE: s14 })).stderr).toContain("legacy_database_requires_explicit_runtime");
  expect(snapshot(root)).toEqual(before);
});

test("explicit --s14 acknowledges independent state without ever mapping JIT_DATABASE", async () => {
  const root = fixture(), old = join(root, "legacy.sqlite"); writeFileSync(old, "legacy bytes");
  const result = await run(root, ["setup", "--s14", "--password-stdin"], { JIT_DATABASE: old });
  expect(result.code).toBe(0); expect(readFileSync(old, "utf8")).toBe("legacy bytes");
  expect(existsSync(join(root, ".local/s14/application.sqlite"))).toBe(true);
});

test("default S14 refuses a selected legacy store with typed refusal and identical sidecars/profile/native/backup bytes", async () => {
  const root = fixture(), path = join(root, "old.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('retained');"); db.close();
  for (const name of ["old.sqlite-wal", "old.sqlite-shm", "profile", "native", "backup"]) writeFileSync(join(root, name), `retained ${name}`);
  const before = snapshot(root), result = await run(root, ["serve", "--no-refusal-page"], { JIT_S14_DATABASE: path });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "s14_fresh_state_required", nextAction: "choose_a_separate_JIT_S14_DATABASE_keep_legacy_installation" });
  expect(snapshot(root)).toEqual(before);
});

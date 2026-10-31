import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireOwnerSetup } from "../src/ops/owner-setup";
import { openS14BootstrapStore, printS14OwnerSetupLink } from "../src/s14/owner-bootstrap";
import { acquireS14RuntimeLock } from "../src/s14/runtime-lock";
import { S14Store } from "../src/s14/store";

const origin = "http://localhost:3001", roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-owner-link-")); roots.push(root);
  const path = join(root, "application.sqlite");
  const env = { ...process.env, JIT_S14_DATABASE: path, JIT_S14_ORIGIN: origin };
  return { root, path, env };
}
async function issue(env: NodeJS.ProcessEnv, outputFd = "3") {
  const child = Bun.spawn([process.execPath, "src/main.ts", "owner-link", "--s14", "--output-fd", outputFd], { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const fd = child.stdio[3]!;
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, status, privateOutput: readFileSync(fd, "utf8") };
  } finally { closeSync(fd); }
}

test("foreground terminal prints once without logging; redirected stdout or non-interactive stdin never issues/rotates a link", () => {
  const f = fixture(), store = new S14Store(f.path), terminal: string[] = [];
  const log = spyOn(console, "log"), error = spyOn(console, "error");
  try {
    const output = { isTTY: true, write: (value: string) => terminal.push(value) };
    printS14OwnerSetupLink(store, origin, { isTTY: true }, output);
    expect(terminal).toHaveLength(1);
    const token = new URL(terminal[0]!.trim()).searchParams.get("token")!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const hashFile = readFileSync(`${f.path}.owner-setup.json`, "utf8");
    expect(hashFile).not.toContain(token);
    expect(JSON.parse(hashFile).hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(statSync(`${f.path}.owner-setup.json`).mode & 0o777).toBe(0o600);
    store.transaction(tx => requireOwnerSetup(store, tx, token, Date.now()));
    store.transaction(tx => expect(() => requireOwnerSetup(store, tx, token, Date.now() + 900000)).toThrow("owner_setup_link_invalid"));
    const redirected: string[] = [];
    printS14OwnerSetupLink(store, origin, { isTTY: true }, { isTTY: false, write: value => redirected.push(value) });
    printS14OwnerSetupLink(store, origin, { isTTY: false }, output);
    expect(redirected).toEqual([]); expect(terminal).toHaveLength(1);
    expect(readFileSync(`${f.path}.owner-setup.json`, "utf8")).toBe(hashFile);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    store.transaction(tx => tx.run("INSERT INTO owner VALUES ('owner','not-a-password',1)"));
    printS14OwnerSetupLink(store, origin, { isTTY: true }, output);
    expect(terminal).toHaveLength(1);
    store.transaction(tx => expect(() => requireOwnerSetup(store, tx, token, Date.now())).toThrow("owner_setup_link_invalid"));
  } finally { log.mockRestore(); error.mockRestore(); store.close(); }
});

test("real non-TTY serve emits safe listening logs only and creates no capability file", () => {
  const f = fixture();
  const child = spawnSync(process.execPath, ["tests/fixtures/s14-bootstrap.ts"], { env: f.env, encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).state).toBe("s14_listening");
  expect(child.stderr).toBe("");
  expect(child.stdout + child.stderr).not.toMatch(/owner\/setup|token=|[a-f0-9]{64}/);
  expect(existsSync(`${f.path}.owner-setup.json`)).toBe(false);
});

test("real interactive serve displays exactly one usable link on its terminal", async () => {
  const f = fixture();
  let terminalOutput = "";
  const child = Bun.spawn([process.execPath, "tests/fixtures/s14-bootstrap.ts"], { env: f.env,
    terminal: { cols: 80, rows: 24, data: (_terminal, data) => { terminalOutput += data.toString(); } } });
  try {
    expect(await child.exited).toBe(0);
    const links = terminalOutput.match(/http:\/\/localhost:3001\/owner\/setup\?token=[a-f0-9]{64}/g) ?? [];
    expect(links).toHaveLength(1);
    const token = new URL(links[0]!).searchParams.get("token")!;
    const store = new S14Store(f.path);
    try { store.transaction(tx => requireOwnerSetup(store, tx, token, Date.now())); } finally { store.close(); }
    expect(terminalOutput.split(/\r?\n/).find(line => line.includes("s14_listening"))).not.toContain(token);
  } finally { child.terminal?.close(); }
});

test("trusted CLI delivers only to a dedicated pipe while the runtime is locked; rotation, expiry and owner fence stay intact", async () => {
  const f = fixture(), store = new S14Store(f.path), release = acquireS14RuntimeLock(f.path);
  try {
    const child = await issue(f.env);
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(""); expect(child.stderr).toBe("");
    const link = child.privateOutput.trim(), token = new URL(link).searchParams.get("token")!;
    expect(link).toMatch(/^http:\/\/localhost:3001\/owner\/setup\?token=[a-f0-9]{64}$/);
    for (const name of readdirSync(f.root)) expect(readFileSync(join(f.root, name)).includes(Buffer.from(token))).toBe(false);
    store.transaction(tx => requireOwnerSetup(store, tx, token, Date.now()));
    const rotated = await issue(f.env);
    expect(rotated.status).toBe(0); expect(rotated.privateOutput).not.toBe(child.privateOutput);
    store.transaction(tx => expect(() => requireOwnerSetup(store, tx, token, Date.now())).toThrow("owner_setup_link_invalid"));
    const nextToken = new URL(String(rotated.privateOutput).trim()).searchParams.get("token")!;
    store.transaction(tx => expect(() => requireOwnerSetup(store, tx, nextToken, Date.now() + 900000)).toThrow("owner_setup_link_invalid"));
    store.transaction(tx => tx.run("INSERT INTO owner VALUES ('owner','not-a-password',1)"));
    const owned = await issue(f.env);
    expect(owned.status).toBe(0); expect(owned.privateOutput).toBe(""); expect(owned.stdout + owned.stderr).toBe("");
    store.transaction(tx => expect(() => requireOwnerSetup(store, tx, nextToken, Date.now())).toThrow("owner_setup_link_invalid"));
  } finally { release(); store.close(); }
});

test("CLI refuses stdout, stderr, missing/invalid descriptors and plaintext file output before creating state", async () => {
  const f = fixture();
  for (const fd of ["0", "1", "2", "99999", "no", "3.0"]) {
    const child = await issue(f.env, fd);
    expect(child.status).toBe(1); expect(child.stdout).toBe("");
    expect(child.stderr).toContain("owner_link_private_pipe_required"); expect(child.privateOutput).toBe("");
    expect(existsSync(f.path)).toBe(false);
  }
  const file = openSync(join(f.root, "must-stay-empty"), "wx", 0o600);
  try {
    const child = spawnSync(process.execPath, ["src/main.ts", "owner-link", "--s14", "--output-fd", "3"], { env: f.env, stdio: ["ignore", "pipe", "pipe", file], encoding: "utf8" });
    expect(child.status).toBe(1); expect(child.stdout).toBe(""); expect(child.stderr).toContain("owner_link_private_pipe_required");
    expect(readFileSync(join(f.root, "must-stay-empty"), "utf8")).toBe(""); expect(existsSync(f.path)).toBe(false);
  } finally { closeSync(file); }
});

test("CLI rejects aliases of log outputs and refuses legacy bytes before locks, capability files or workers", async () => {
  const f = fixture();
  const aliased = spawnSync("/bin/sh", ["-c", 'exec 3>&1; exec "$JIT_TEST_BUN" src/main.ts owner-link --s14 --output-fd 3'], { env: { ...f.env, JIT_TEST_BUN: process.execPath }, encoding: "utf8" });
  expect(aliased.status).toBe(1); expect(aliased.stdout).toBe(""); expect(aliased.stderr).toContain("owner_link_private_pipe_required");
  expect(existsSync(f.path)).toBe(false);
  const legacy = Buffer.alloc(100); legacy.write("SQLite format 3\0"); legacy.writeUInt32BE(45, 60);
  writeFileSync(f.path, legacy, { mode: 0o600 });
  const refused = await issue(f.env);
  expect(refused.status).toBe(1); expect(refused.stdout + refused.privateOutput).toBe(""); expect(refused.stderr).toContain("s14_fresh_state_required");
  expect(readFileSync(f.path)).toEqual(legacy); expect(readdirSync(f.root)).toEqual(["application.sqlite"]);
});

test("installer CLI uses the configured HTTPS browser origin without placing the capability in stdout or stderr", async () => {
  const f = fixture(), child = await issue({ ...f.env, JIT_S14_ORIGIN: "https://jit.example.test" });
  expect(child.status).toBe(0); expect(child.privateOutput).toMatch(/^https:\/\/jit\.example\.test\/owner\/setup\?token=[a-f0-9]{64}\n$/);
  expect(child.stdout + child.stderr).toBe("");
});

test("bootstrap waits for ATTACH preparation contention before issuing, and returns the one opened store", async () => {
  const f = fixture();
  let now = 0, opens = 0;
  const waits: number[] = [];
  const store = await openS14BootstrapStore(f.path, { now: () => now, wait: async ms => { waits.push(ms); now += ms; }, open() {
    if (++opens < 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return new S14Store(f.path);
  } });
  try {
    expect(opens).toBe(3); expect(waits).toEqual([25, 25]);
    expect(existsSync(`${f.path}.owner-setup.json`)).toBe(false);
    expect(store.path).toBe(f.path);
  } finally { store.close(); }
});

test("bootstrap contention has a finite deadline, never retries other failures and never creates a capability", async () => {
  const f = fixture();
  let now = 0, opens = 0;
  await expect(openS14BootstrapStore(f.path, { now: () => now, wait: async ms => { now += ms; }, open() {
    opens++; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  } })).rejects.toThrow("s14_store_busy");
  expect(now).toBe(2000); expect(opens).toBe(81);
  opens = 0;
  await expect(openS14BootstrapStore(f.path, { now: () => now, wait: async () => { throw Error("must not wait"); }, open() {
    opens++; throw new Error("not contention");
  } })).rejects.toThrow("not contention");
  expect(opens).toBe(1); expect(existsSync(f.path)).toBe(false);
});

test("short bootstrap ATTACH waits restore the normal writer timeout before capability issuance", () => {
  const f = fixture(), store = new S14Store(f.path, undefined, { attachBusyTimeoutMs: 25 });
  try {
    expect(store.read(tx => tx.get<{ timeout: number }>("PRAGMA busy_timeout")!.timeout)).toBe(2000);
    expect(existsSync(`${f.path}.owner-setup.json`)).toBe(false);
  } finally { store.close(); }
  expect(() => new S14Store(f.path, undefined, { attachBusyTimeoutMs: 0 })).toThrow("invalid_store_busy_timeout");
});

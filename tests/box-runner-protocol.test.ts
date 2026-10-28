import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localBox, runLocal, runnerCall, runnerScript, type LocalBox } from "./fixtures/box-local-runner";

const boxes: LocalBox[] = [];
afterEach(() => { for (const box of boxes.splice(0)) rmSync(dirname(box.root), { recursive: true, force: true }); });
function fresh(): LocalBox { const box = localBox("jit-runner-"); boxes.push(box); return box; }
const b64 = (text: string) => Buffer.from(text).toString("base64");
const uuid = () => crypto.randomUUID();

test("the runner is executable and installed with mode 0555 in the base image target, and documents its protocol", () => {
  // Git keeps only the executable bit; the image COPY sets the exact mode.
  expect(statSync(runnerScript).mode & 0o111).toBe(0o111);
  const containerfile = readFileSync(join(import.meta.dir, "../ops/box/Containerfile"), "utf8");
  const base = containerfile.split(/^FROM /m).find(stage => stage.includes("AS base"))!;
  expect(base).toContain("COPY --chmod=0555 ops/box/runner /opt/jit/runner");
  expect(existsSync(join(import.meta.dir, "../docs/contracts/box-runner-v1.md"))).toBe(true);
});

test("malformed, oversized and unknown requests are protocol errors; one JSON response always comes back", async () => {
  const box = fresh();
  const raw = async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode((await runLocal(box, { input: bytes })).stdout));
  expect(await raw(new TextEncoder().encode("not json"))).toEqual({ v: 1, ok: false, error: { code: "EPROTO" } });
  expect(await raw(new TextEncoder().encode('{"v":2,"op":"stat","path":"/x"}'))).toEqual({ v: 1, ok: false, error: { code: "EPROTO" } });
  expect(await runnerCall(box, { op: "format-disk" })).toEqual({ v: 1, ok: false, error: { code: "EPROTO" } } as never);
  // A newline or NUL in a path never reaches the shell.
  expect((await runnerCall(box, { op: "stat", path: `${box.root}/a\nb` })).error?.code).toBe("EPROTO");
  const huge = new Uint8Array(24 * 1024 * 1024 + 10).fill(0x20);
  expect(await raw(huge)).toEqual({ v: 1, ok: false, error: { code: "E2BIG" } });
  // Scratch files never outlive the request.
  expect(readdirSync(box.state).filter(name => name.startsWith("req."))).toEqual([]);
});

test("paths outside the workspace, traversal and non-canonical paths are refused before any file access", async () => {
  const box = fresh();
  writeFileSync(join(dirname(box.root), "outside.txt"), "outside");
  for (const path of ["/etc/passwd", `${box.root}/../outside.txt`, `${box.root}/./a`, `${box.root}//a`, "relative/path", `${box.root}-sibling/x`]) {
    for (const op of ["stat", "read", "observe", "list"]) {
      const response = await runnerCall(box, { op, path, offset: 0, length: 10 });
      expect([op, path, response.error?.code]).toEqual([op, path, "EACCES"]);
    }
  }
  expect((await runnerCall(box, { op: "write", path: `${box.root}/../outside.txt`, data: b64("x"), createParents: false })).error?.code).toBe("EACCES");
  expect(readFileSync(join(dirname(box.root), "outside.txt"), "utf8")).toBe("outside");
  expect((await runnerCall(box, { op: "spawn", id: uuid(), command: "pwd", cwd: "/" })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "glob", cwd: dirname(box.root), dot: false })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "search", pattern: "x", path: "/etc", cwd: box.root, limit: 5 })).error?.code).toBe("EACCES");
});

test("symlink escapes are refused for reading, listing, writing through a parent, searching and running", async () => {
  const box = fresh();
  const outside = join(dirname(box.root), "outside");
  mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(outside, join(box.root, "dir-link"));
  symlinkSync(join(outside, "secret.txt"), join(box.root, "file-link"));
  expect((await runnerCall(box, { op: "read", path: `${box.root}/file-link`, offset: 0, length: 100 })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "read", path: `${box.root}/dir-link/secret.txt`, offset: 0, length: 100 })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "list", path: `${box.root}/dir-link` })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "observe", path: `${box.root}/file-link`, content: true })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "write", path: `${box.root}/dir-link/new.txt`, data: b64("x"), createParents: true })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "spawn", id: uuid(), command: "pwd", cwd: `${box.root}/dir-link` })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "search", pattern: "secret", path: `${box.root}/dir-link`, cwd: box.root, limit: 5 })).error?.code).toBe("EACCES");
  expect(readdirSync(outside)).toEqual(["secret.txt"]);
  // Writing the link's own entry replaces the link and never follows it out of the workspace.
  const observed = await runnerCall(box, { op: "observe", path: `${box.root}/dangling`, content: false });
  expect(observed.result).toBeNull();
  symlinkSync(join(outside, "planted.txt"), join(box.root, "dangling"));
  expect((await runnerCall(box, { op: "write", path: `${box.root}/dangling`, data: b64("inside"), createParents: false })).ok).toBe(true);
  expect(lstatSync(join(box.root, "dangling")).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(box.root, "dangling"), "utf8")).toBe("inside");
  expect(existsSync(join(outside, "planted.txt"))).toBe(false);
  // Listing reports a symlink entry as a symlink without following it.
  const listed = await runnerCall(box, { op: "list", path: box.root });
  expect(listed.result.entries.find((entry: { name: string }) => entry.name === "dir-link")).toEqual({ name: "dir-link", type: "symlink" });
});

test("writes are atomic, keep the file mode, honour observations and never leave a staging file", async () => {
  const box = fresh();
  writeFileSync(join(box.root, "a.sh"), "old", { mode: 0o750 });
  Bun.spawnSync(["chmod", "750", join(box.root, "a.sh")]);
  const observed = await runnerCall(box, { op: "observe", path: `${box.root}/a.sh`, content: true });
  expect(Buffer.from(observed.result.data, "base64").toString()).toBe("old");
  expect((await runnerCall(box, { op: "write", path: `${box.root}/a.sh`, data: b64("new"), observed: observed.result.token })).ok).toBe(true);
  expect(readFileSync(join(box.root, "a.sh"), "utf8")).toBe("new");
  expect(statSync(join(box.root, "a.sh")).mode & 0o777).toBe(0o750);
  // The old observation is stale now; a write that expected absence fails when the file exists.
  expect((await runnerCall(box, { op: "write", path: `${box.root}/a.sh`, data: b64("x"), observed: observed.result.token })).error?.code).toBe("ECHANGED");
  expect((await runnerCall(box, { op: "write", path: `${box.root}/a.sh`, data: b64("x"), observed: null })).error?.code).toBe("ECHANGED");
  expect(readFileSync(join(box.root, "a.sh"), "utf8")).toBe("new");
  expect((await runnerCall(box, { op: "write", path: `${box.root}/deep/er/f.txt`, data: b64("x"), createParents: false })).error?.code).toBe("ENOENT");
  expect((await runnerCall(box, { op: "write", path: `${box.root}/deep/er/f.txt`, data: b64("x"), createParents: true })).ok).toBe(true);
  expect((await runnerCall(box, { op: "write", path: `${box.root}/deep`, data: b64("x") })).error?.code).toBe("EISDIR");
  expect((await runnerCall(box, { op: "write", path: `${box.root}/a.sh/x`, data: b64("x"), createParents: true })).error?.code).toBe("ENOTDIR");
  const leftovers = Bun.spawnSync(["find", box.root, "-name", ".jit-write.*"]).stdout.toString();
  expect(leftovers).toBe("");
});

test("fixed limits: read chunks, observed files, spawn output and timeouts are bounded", async () => {
  const box = fresh();
  writeFileSync(join(box.root, "big"), Buffer.alloc(17 * 1024 * 1024, 1));
  expect((await runnerCall(box, { op: "read", path: `${box.root}/big`, offset: 0, length: 1_048_577 })).error?.code).toBe("EINVAL");
  const chunk = await runnerCall(box, { op: "read", path: `${box.root}/big`, offset: 17 * 1024 * 1024 - 10, length: 1_048_576 });
  expect([Buffer.from(chunk.result.data, "base64").length, chunk.result.eof]).toEqual([10, true]);
  expect((await runnerCall(box, { op: "observe", path: `${box.root}/big`, content: true })).error?.code).toBe("EFBIG");
  const spawned = await runnerCall(box, { op: "spawn", id: uuid(), command: "head -c 9000000 /dev/zero; head -c 100 /dev/zero >&2", cwd: box.root });
  expect([Buffer.from(spawned.result.stdout, "base64").length, spawned.result.stdoutBytes, spawned.result.stderrBytes]).toEqual([8_388_608, 9_000_000, 100]);
  // The flood never lands in the box beyond the kept bytes: a 40 MB stream leaves no large file behind.
  const flood = await runnerCall(box, { op: "spawn", id: uuid(), command: "head -c 40000000 /dev/zero", cwd: box.root });
  expect(flood.result.stdoutBytes).toBe(40_000_000);
  expect(readdirSync(box.state).filter(name => name.startsWith("req."))).toEqual([]);
  const started = Date.now();
  const timed = await runnerCall(box, { op: "spawn", id: uuid(), command: "trap '' TERM; sleep 5", cwd: box.root, timeoutMs: 150 });
  expect(timed.result).toMatchObject({ exitCode: null, timedOut: true });
  expect(Date.now() - started).toBeLessThan(3000);
});

test("a command that exits leaves background children 200 ms, then its group is killed and the pipes close", async () => {
  const box = fresh();
  const started = Date.now();
  const result = await runnerCall(box, { op: "spawn", id: uuid(), command: "echo early; (sleep 20; echo late) & exit 0", cwd: box.root });
  expect(Buffer.from(result.result.stdout, "base64").toString()).toBe("early\n");
  expect(result.result.exitCode).toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("spawn gets exactly the requested environment, runs in its own group and kill reaches every process", async () => {
  const box = fresh();
  const env = await runnerCall(box, { op: "spawn", id: uuid(), command: "env | sort", cwd: box.root, env: { PATH: "/usr/bin:/bin", QUOTED: "a'b $(rm -rf /) `x`" } });
  const lines = Buffer.from(env.result.stdout, "base64").toString().trim().split("\n").filter(line => !/^(PWD|SHLVL|_|OLDPWD)=/.test(line));
  expect(lines).toEqual(["PATH=/usr/bin:/bin", "QUOTED=a'b $(rm -rf /) `x`"]);
  expect((await runnerCall(box, { op: "spawn", id: uuid(), command: "true", cwd: box.root, env: { "BAD-NAME": "x" } })).error?.code).toBe("EINVAL");
  const id = uuid();
  const running = runnerCall(box, { op: "spawn", id, command: `(sleep 30 & echo $! > ${box.root}/child.pid; wait)`, cwd: box.root });
  for (let i = 0; i < 100 && !existsSync(join(box.state, `${id}.pid`)); i++) await Bun.sleep(20);
  for (let i = 0; i < 100 && !existsSync(join(box.root, "child.pid")); i++) await Bun.sleep(20);
  expect((await runnerCall(box, { op: "kill", id })).result).toEqual({ killed: true });
  expect((await running).result.exitCode).toBeNull();
  const child = Number(readFileSync(join(box.root, "child.pid"), "utf8"));
  expect(() => process.kill(child, 0)).toThrow();
  expect((await runnerCall(box, { op: "kill", id })).result).toEqual({ killed: false });
  expect((await runnerCall(box, { op: "kill", id: "not-a-uuid" })).error?.code).toBe("EINVAL");
});

test("spill files are the one exception outside the workspace, and only by exact name in the temporary directory", async () => {
  const box = fresh();
  const name = `schway-bash-${uuid()}.log`;
  expect((await runnerCall(box, { op: "writePrivate", path: join(box.tmp, name), data: b64("spilled") })).ok).toBe(true);
  expect(statSync(join(box.tmp, name)).mode & 0o777).toBe(0o600);
  const read = await runnerCall(box, { op: "read", path: join(box.tmp, name), offset: 0, length: 100 });
  expect(Buffer.from(read.result.data, "base64").toString()).toBe("spilled");
  rmSync(join(box.tmp, name));
  expect((await runnerCall(box, { op: "writePrivate", path: join(box.tmp, "other.log"), data: b64("x") })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "writePrivate", path: join(box.root, name), data: b64("x") })).error?.code).toBe("EACCES");
  expect((await runnerCall(box, { op: "read", path: join(box.tmp, "other.log"), offset: 0, length: 1 })).error?.code).toBe("EACCES");
});

test("glob and search stopped by the wall-time limit say so instead of looking complete", async () => {
  const box = fresh();
  box.opSeconds = 1;
  // ripgrep reading a FIFO blocks until the limit stops it; its partial result is marked truncated with the reason.
  Bun.spawnSync(["mkfifo", join(box.root, "pipe")]);
  const searched = await runnerCall(box, { op: "search", pattern: "x", path: `${box.root}/pipe`, cwd: box.root, limit: 5 });
  expect(searched.result).toMatchObject({ matches: [], truncated: true, failure: "search stopped after 1 seconds; narrow the path or the pattern" });
  // A walk that outlives the limit is ETIMEDOUT.
  const shims = join(dirname(box.root), "shims"); mkdirSync(shims);
  writeFileSync(join(shims, "find"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  box.pathPrefix = shims;
  expect((await runnerCall(box, { op: "glob", cwd: box.root, dot: false })).error?.code).toBe("ETIMEDOUT");
  expect(new TextDecoder().decode((await runLocal({ ...box, opSeconds: 999 }, { input: new TextEncoder().encode("{}") })).stdout)).toContain("EPROTO");
});

test("the declared limits fit the box scratch space: a 16 MiB write and a full 8 MiB stream succeed", async () => {
  const box = fresh();
  const data = Buffer.alloc(16 * 1024 * 1024, 0x61);
  expect((await runnerCall(box, { op: "write", path: `${box.root}/big.txt`, data: data.toString("base64"), createParents: false })).ok).toBe(true);
  expect(statSync(join(box.root, "big.txt")).size).toBe(16 * 1024 * 1024);
  expect((await runnerCall(box, { op: "write", path: `${box.root}/big2.txt`, data: Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64") })).error?.code).toBe("EFBIG");
  const stream = await runnerCall(box, { op: "spawn", id: uuid(), command: "head -c 8388608 /dev/zero", cwd: box.root });
  expect([Buffer.from(stream.result.stdout, "base64").length, stream.result.stdoutBytes]).toEqual([8_388_608, 8_388_608]);
  // Worst case in /run: the 24 MiB request, 16 MiB of decoded data, and two capped streams with their base64 copies.
  const worst = 24 + 16 + 2 * (8 + Math.ceil(8 * 4 / 3));
  expect(worst).toBeLessThan(128);
});

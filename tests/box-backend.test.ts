import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { coreToolDefinitions, type ToolDefinition } from "schway/host";
import { createBoxBackend } from "../src/exec/box-backend";
import type { BoxExecRequest, BoxExecResult } from "../src/exec/box-runtime";
import { FakeBoxRuntime } from "../src/exec/fake-box-runtime";
import { localBox, localExec, type LocalBox } from "./fixtures/box-local-runner";
import { runBoxParity } from "./fixtures/schway-core-tools/parity";

const projectId = "0f2d7a52-6b7e-4c1f-9a39-5e0c3c1d2b10";
const boxes: LocalBox[] = [];
afterEach(() => { for (const box of boxes.splice(0)) rmSync(dirname(box.root), { recursive: true, force: true }); });

async function backendOver(exec?: (request: BoxExecRequest) => Promise<BoxExecResult>, redact?: (text: string) => string) {
  const box = localBox(); boxes.push(box);
  const runtime = new FakeBoxRuntime({ exec: exec ? (_h, r) => exec(r) : localExec(box), workspaceRoot: box.root, temporaryDirectory: box.tmp });
  const handle = await runtime.ensure(projectId, "workspace");
  return { box, runtime, backend: createBoxBackend(runtime, handle, redact ? { redact } : {}) };
}
const byName = (definitions: readonly ToolDefinition[]) => Object.fromEntries(definitions.map(tool => [tool.name, tool]));
const ctx = (root: string, signal?: AbortSignal) => ({ workspace: { root, launchCwd: root, extraRoots: [] }, ...(signal ? { signal } : {}) });
const ok = (result: unknown): BoxExecResult => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify({ v: 1, ok: true, result })), stderr: new Uint8Array() });

test("the Schway core tools reproduce the SCH01 golden byte for byte through the box backend and the runner", async () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/schway-core-tools/golden.json"), "utf8"));
  const { box, runtime, backend } = await backendOver();
  expect(await runBoxParity(backend, box.root, box.tmp, tmpdir())).toEqual(golden);
  // Every file and process operation went through the runner exec; none ran on the host directly.
  const ops = new Set(runtime.calls.filter(call => call.op === "exec").map(call => (call.request as { op: string }).op));
  expect([...ops].sort()).toEqual(["glob", "list", "observe", "read", "realpath", "search", "spawn", "stat", "write", "writePrivate"]);
}, 60_000);

test("escapes are refused before the backend, and the runner refuses them again when asked directly", async () => {
  const { box, runtime, backend } = await backendOver();
  const tools = byName(coreToolDefinitions(backend));
  writeFileSync(join(dirname(box.root), "outside.txt"), "secret outside\n");
  Bun.spawnSync(["ln", "-s", join(dirname(box.root), "outside.txt"), join(box.root, "escape.txt")]);
  expect(await tools.read!.execute({ path: "../outside.txt" }, ctx(box.root))).toMatchObject({ content: "Path is outside the workspace: ../outside.txt", isError: true });
  expect(await tools.read!.execute({ path: "escape.txt" }, ctx(box.root))).toMatchObject({ content: "Path is outside the workspace: escape.txt", isError: true });
  // Below Schway's check, the runner itself refuses a symlink that leaves the workspace.
  expect(await backend.realpath(join(box.root, "escape.txt"))).toBe(join(dirname(box.root), "outside.txt"));
  await expect(backend.stat(join(box.root, "escape.txt"))).rejects.toMatchObject({ code: "EACCES" });
  await expect((async () => { for await (const _ of backend.readFile(join(box.root, "escape.txt"))) break; })()).rejects.toMatchObject({ code: "EACCES" });
  await expect(backend.stat(join(dirname(box.root), "outside.txt"))).rejects.toMatchObject({ code: "EACCES" });
  expect(runtime.calls.some(call => call.op === "exec" && JSON.stringify(call.request).includes("outside.txt") && (call.request as { op: string }).op === "read")).toBe(false);
});

test("a stale edit observation reports a changed file and writes nothing", async () => {
  const { box, backend } = await backendOver();
  writeFileSync(join(box.root, "f.txt"), "one\n");
  const observed = await backend.observeFile(join(box.root, "f.txt"), { content: true });
  writeFileSync(join(box.root, "f.txt"), "changed\n");
  await expect(backend.writeFileAtomically(join(box.root, "f.txt"), "two\n", { observed })).rejects.toMatchObject({ code: "ECHANGED" });
  expect(readFileSync(join(box.root, "f.txt"), "utf8")).toBe("changed\n");
  await expect(backend.writeFileAtomically(join(box.root, "f.txt"), "x", { observed: { targetExists: true } })).rejects.toBeInstanceOf(TypeError);
});

test("cancellation reaches the process inside the box through a runner kill, and settles as AbortError", async () => {
  const { box, runtime, backend } = await backendOver();
  const tools = byName(coreToolDefinitions(backend));
  const controller = new AbortController();
  const marker = join(box.root, "still-running");
  const running = tools.bash!.execute({ command: `sleep 0.3; while :; do date >> ${marker}; sleep 0.1; done` }, ctx(box.root, controller.signal));
  await Bun.sleep(600);
  controller.abort();
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
  const kills = runtime.calls.flatMap(call => call.op === "exec" && (call.request as { op: string }).op === "kill" ? [call.request as { id: string }] : []);
  expect(kills).toHaveLength(1);
  expect(kills[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  // The process group is gone: the marker stops growing.
  const size = readFileSync(marker, "utf8").length;
  await Bun.sleep(400);
  expect(readFileSync(marker, "utf8").length).toBe(size);
});

test("a spawn result that arrives after cancellation is never published", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const { backend } = await backendOver(async request => {
    const parsed = JSON.parse(new TextDecoder().decode(request.input)) as { op: string };
    requests.push(parsed.op);
    if (parsed.op === "kill") return ok({ killed: true });
    // The late runner answer ignores the abort and arrives afterwards with output.
    await gate;
    return ok({ stdout: Buffer.from("late output").toString("base64"), stderr: "", exitCode: 0, timedOut: false });
  });
  const controller = new AbortController(), chunks: string[] = [];
  const spawned = backend.spawn({ command: "work", cwd: backend.workspaceRoot, signal: controller.signal, onOutput: chunk => chunks.push(chunk.text) });
  await Bun.sleep(20);
  controller.abort();
  release();
  await expect(spawned).rejects.toMatchObject({ name: "AbortError" });
  expect(chunks).toEqual([]);
  expect(requests).toEqual(["spawn", "kill"]);
  // Aborting before the call starts never reaches the runtime.
  await expect(backend.spawn({ command: "never", cwd: backend.workspaceRoot, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toEqual(["spawn", "kill"]);
});

test("runner and transport failures map to Node-style codes, and command output passes the redaction guard", async () => {
  const { backend } = await backendOver(async request => {
    const op = (JSON.parse(new TextDecoder().decode(request.input)) as { op: string }).op;
    if (op === "stat") return { exitCode: 0, stdout: new TextEncoder().encode('{"v":1,"ok":false,"error":{"code":"ENOTDIR"}}'), stderr: new Uint8Array() };
    if (op === "realpath") return { exitCode: 125, stdout: new Uint8Array(), stderr: new TextEncoder().encode("podman failed") };
    if (op === "list") return { exitCode: 0, stdout: new TextEncoder().encode("not json"), stderr: new Uint8Array() };
    return ok({ stdout: Buffer.from("token=SECRET-VALUE-1234\n").toString("base64"), stderr: "", exitCode: 0, timedOut: false });
  }, text => text.replaceAll("SECRET-VALUE-1234", "[credential-redacted]"));
  await expect(backend.stat("/workspace/a/b")).rejects.toMatchObject({ code: "ENOTDIR" });
  await expect(backend.realpath("/workspace")).rejects.toMatchObject({ code: "EIO" });
  await expect(backend.list("/workspace")).rejects.toMatchObject({ code: "EIO" });
  const result = await backend.spawn({ command: "echo", cwd: "/workspace" });
  expect(result.stdout).toBe("token=[credential-redacted]\n");
});

test("glob matches with Bun.Glob on the host and prunes hidden trees unless the pattern names one", async () => {
  const requests: { op: string; dot?: boolean }[] = [];
  const { backend } = await backendOver(async request => {
    const parsed = JSON.parse(new TextDecoder().decode(request.input)) as { op: string; dot?: boolean };
    requests.push(parsed);
    return ok({ files: ["a.ts", "src/b.ts", "src/c.md", ".github/w.yml"], truncated: false });
  });
  const collect = async (pattern: string) => { const out: string[] = []; for await (const file of backend.glob(pattern, { cwd: "/workspace" })) out.push(file); return out; };
  expect(await collect("**/*.ts")).toEqual(["a.ts", "src/b.ts"]);
  expect(await collect(".github/*.yml")).toEqual([".github/w.yml"]);
  expect(requests.map(request => request.dot)).toEqual([false, true]);
});

test("readFile streams fixed 1 MiB chunks and stops requesting when iteration stops", async () => {
  const { box, runtime, backend } = await backendOver();
  writeFileSync(join(box.root, "big.bin"), Buffer.alloc(2_500_000, 7));
  let total = 0;
  for await (const chunk of backend.readFile(join(box.root, "big.bin"))) total += chunk.length;
  expect(total).toBe(2_500_000);
  const reads = () => runtime.calls.filter(call => call.op === "exec" && (call.request as { op: string }).op === "read").length;
  expect(reads()).toBe(3);
  for await (const _chunk of backend.readFile(join(box.root, "big.bin"))) break;
  expect(reads()).toBe(4);
});


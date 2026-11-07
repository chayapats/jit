import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composedFixture } from "./fixtures/s15-composition";
import type { FileUpload } from "../src/s16/files/types";
import type { ConversationFileCommand } from "../src/s15/conversation/types";
import type { S15CompositionOptions } from "../src/s15/composition";
import type { VmSshTransport } from "../src/s15/vm/transport";
import { vmHostCommand } from "../src/s15/vm/host";
import { vmRunnerSource } from "../src/s15/vm/runner";
import { vmCanonical } from "../src/s15/vm/validation";
import { vmStagedName } from "../src/s15/vm/service";

// FILE16-01C: an attached file is staged into the working computer, processed there, and one produced file is
// collected as an immutable artifact with the complete input ancestry. Deterministic: scripted model, fixture VM.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Fixture = Awaited<ReturnType<typeof composedFixture>>;
type Hook = (request: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

/** Composition with files and S16 computers. `hook` sees every guest operation first and may answer it. */
async function fixture(hook: { current: Hook | null } = { current: null }) {
  let f!: Fixture;
  f = await composedFixture("default", false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { if (!rule.adapters.includes("s16_files")) rule.adapters.push("s16_files"); if (!rule.operations.includes("artifact_create")) rule.operations.push("artifact_create"); }
    const base = options.vm.transport!;
    return { ...options, files: {}, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, vm: { ...options.vm, transport: registration => {
      const transport = base(registration), invoke = transport.invoke.bind(transport);
      transport.invoke = (async (request: Record<string, unknown>, input: Parameters<VmSshTransport["invoke"]>[1]) => {
        const answer = await hook.current?.(request);
        if (answer) { input.beforeStart(); f.vmCalls.push(String(request.op)); return answer; }
        // A tiny deterministic "program" in the guest: uppercase one file into another (`upper <in> <out>`).
        if (request.op === "spawn" && typeof request.command === "string" && request.command.startsWith("upper ")) {
          input.beforeStart(); f.vmCalls.push("spawn");
          const [, from, to] = request.command.split(" "), cwd = String(request.cwd);
          f.files.set(`${cwd}/${to}`, Buffer.from(new TextDecoder().decode(f.files.get(`${cwd}/${from}`) ?? new Uint8Array()).toUpperCase()));
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: 0 };
        }
        return invoke(request, input);
      }) as VmSshTransport["invoke"];
      return transport;
    } } };
  });
  cleanups.push(() => f.close()); return { f, hook };
}
async function upload(f: Fixture, text: string, name = "notes.txt") {
  const response = await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "upload_" + hash(name).slice(0, 8), conversationId: "conversation", name, bytes: Buffer.byteLength(text), sha256: hash(text) });
  expect(response.status).toBe(201); const pending = await response.json() as FileUpload;
  const written = await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, text); expect(written.status).toBe(200);
  return (await written.json() as FileUpload).receipt!;
}
async function send(f: Fixture, receipt: { id: string; sha256: string }, requestId = "message1") {
  const command: ConversationFileCommand = { contract: "s16-conversation/v2", requestId, conversationId: "conversation", text: "Uppercase these notes on the working computer and give me the result file.", continuation: null, files: [{ id: receipt.id, sha256: receipt.sha256 }] };
  const sent = await f.request("/api/s16/client/conversations/conversation/messages", "POST", command); expect(sent.status).toBe(202);
  await f.service.conversation.drain(); return f.service.conversation.view(f.owner, requestId);
}
const script = (id: string, name = "notes.txt", collect = "out.md") => [
  { type: "tool_call" as const, id: "put", name: "computer_file_put", arguments: { id } },
  { type: "tool_call" as const, id: "run", name: "bash", arguments: { command: `upper inputs/${id}/${vmStagedName(name)} out.md` } },
  { type: "tool_call" as const, id: "collect", name: "computer_file_collect", arguments: { path: collect, name: "result.md" } },
];

test("FILE16-01C: staged input → real VM processing → collected immutable artifact with full ancestry and matching download", async () => {
  const { f } = await fixture(), receipt = await upload(f, "launch on friday\n");
  const boot = await (await f.request("/api/s16/client/bootstrap")).json();
  expect(boot.capabilities.computers).toMatchObject({ available: true, files: true });
  f.script = script(receipt.id);
  const row = await send(f, receipt);
  expect(row.state).toBe("completed");
  expect(row.evidence.map(e => e.tool)).toEqual(["computer_file_put", "bash", "computer_file_collect"]);
  expect(row.artifacts).toHaveLength(1);
  const artifact = row.artifacts![0]!, downloaded = await f.request(`/api/s16/client/requests/message1/artifacts/${artifact.id}`), bytes = new Uint8Array(await downloaded.arrayBuffer());
  expect(downloaded.status).toBe(200); expect(new TextDecoder().decode(bytes)).toBe("LAUNCH ON FRIDAY\n"); expect(hash(bytes)).toBe(artifact.sha256);
  expect(artifact).toMatchObject({ name: "result.md", mime: "text/markdown" });
  // The staged bytes are the exact original, under a service-chosen path inside the work root.
  const staged = [...f.files.entries()].find(([path]) => path.endsWith(`/inputs/${receipt.id}/notes.txt`));
  expect(staged && new TextDecoder().decode(staged[1])).toBe("launch on friday\n");
  expect(staged![0]).toMatch(new RegExp(`^/var/lib/jit-work/${row.authority!.id}/chat_${row.authority!.id}/inputs/`));
  // The artifact's recorded inputs are every selected file, although the output cites none.
  const library = await (await f.request(`/api/s16/client/artifacts/${artifact.id}`)).json();
  expect(library.inputs.map((input: { id: string }) => input.id)).toEqual([receipt.id]);
  // Restart: the committed artifact stays downloadable and nothing in the VM runs again.
  const calls = f.vmCalls.length; await f.reopen();
  expect((await f.request(`/api/s16/client/requests/message1/artifacts/${artifact.id}`)).status).toBe(200);
  await f.service.conversation.drain(); expect(f.vmCalls.length).toBe(calls);
  // Withdrawing the input withdraws the derived artifact too.
  await f.request(`/api/s16/client/uploads/${receipt.id}/withdraw`, "POST", {});
  expect((await f.request(`/api/s16/client/requests/message1/artifacts/${artifact.id}`)).status).toBe(409);
});

test("FILE16-01C: traversal, absolute escapes, non-text and oversized output are refused and nothing is delivered", async () => {
  for (const [path, setup, expected, reads] of [["../escape.md", null, "vm_path_denied", 0], ["/etc/passwd", null, "vm_path_denied", 0], ["missing.md", null, "ENOENT", 1],
    ["binary.md", (f: Fixture, root: string) => f.files.set(`${root}/binary.md`, new Uint8Array([0xff, 0xfe, 0x00])), "artifact_content_refused", 1],
    ["big.md", (f: Fixture, root: string) => f.files.set(`${root}/big.md`, new Uint8Array(70 * 1024).fill(97)), "invalid_number", 1]] as const) {
    const { f, hook } = await fixture(), receipt = await upload(f, "data\n");
    hook.current = request => {
      if (request.op === "init" && setup) setup(f, String(request.root));
      if (request.op === "read" && !f.files.has(String(request.path))) { f.vmCalls.push("read"); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }
      return undefined;
    };
    f.script = [{ type: "tool_call", id: "collect", name: "computer_file_collect", arguments: { path, name: "result.md" } }];
    const row = await send(f, receipt);
    // The refusal is a correctable tool error the model sees; without a collected file the work is not complete.
    const call = f.service.conversation.store.db.query<{ evidence_json: string }, []>("SELECT evidence_json FROM tool_calls WHERE tool='computer_file_collect'").get()!;
    expect(JSON.parse(JSON.parse(call.evidence_json).content)).toEqual({ error: expected }); expect(JSON.parse(call.evidence_json).isError).toBe(true);
    expect(f.vmCalls.filter(op => op === "read")).toHaveLength(reads);
    expect(row.state).not.toBe("completed"); expect(row.result).toBeNull(); expect(row.artifacts ?? []).toEqual([]);
    expect(f.service.files!.lineage(f.owner)).toEqual([]);
  }
});

test("FILE16-01C: withdrawing the file while it is being staged prevents any later use or publication", async () => {
  const { f, hook } = await fixture(), receipt = await upload(f, "secret plan\n");
  hook.current = async request => {
    if (request.op === "write" && String(request.path).includes("/inputs/")) { await f.request(`/api/s16/client/uploads/${receipt.id}/withdraw`, "POST", {}); }
    return undefined;
  };
  f.script = script(receipt.id);
  const row = await send(f, receipt);
  expect(f.service.conversation.store.db.query<{ tool: string; state: string }, []>("SELECT tool,state FROM tool_calls").all()).toEqual([{ tool: "computer_file_put", state: "unknown" }]);
  expect(row.state).not.toBe("completed"); expect(row.artifacts ?? []).toEqual([]);
  expect(f.vmCalls.filter(op => op === "read")).toHaveLength(0);
  expect(f.service.files!.lineage(f.owner)).toEqual([]);
});

test("FILE16-01C: a lost VM transport during collection is never re-run and leaves no partial artifact", async () => {
  const { f, hook } = await fixture(), receipt = await upload(f, "data\n");
  hook.current = request => { if (request.op === "read") throw new Error("connection lost"); return undefined; };
  f.script = script(receipt.id);
  const row = await send(f, receipt);
  expect(f.service.conversation.store.db.query<{ tool: string; state: string }, []>("SELECT tool,state FROM tool_calls WHERE tool='computer_file_collect'").get()).toEqual({ tool: "computer_file_collect", state: "unknown" });
  expect(row.state).not.toBe("completed"); expect(row.artifacts ?? []).toEqual([]);
  const reads = f.vmCalls.filter(op => op === "read").length, writes = f.vmCalls.filter(op => op === "write").length;
  hook.current = null; await f.reopen(); await f.service.conversation.drain();
  expect(f.vmCalls.filter(op => op === "read")).toHaveLength(reads); expect(f.vmCalls.filter(op => op === "write")).toHaveLength(writes);
  expect(f.service.files!.lineage(f.owner)).toEqual([]);
});

test("FILE16-01C: the real guest helper refuses symlinked collection paths and symlinked staging directories", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "jit-collect-"))); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = `${directory}/work`, tmp = `${directory}/tmp`, outside = `${directory}/outside`;
  mkdirSync(root); mkdirSync(tmp); mkdirSync(outside); writeFileSync(`${outside}/private.txt`, "outside-marker");
  writeFileSync(`${root}/ok.md`, "fine"); symlinkSync(`${outside}/private.txt`, `${root}/link.md`); symlinkSync(outside, `${root}/inputs`);
  const run = async (operation: Record<string, unknown>) => JSON.parse(new TextDecoder().decode((await vmHostCommand(["python3", "-I", "-c", vmRunnerSource], { input: Buffer.from(vmCanonical({ v: 1, id: "collect", root, tmp, cap: 65536, ...operation })), timeoutMs: 3000, maxBytes: 262144 })).stdout));
  expect((await run({ op: "read", path: `${root}/ok.md` })).result).toEqual({ data: Buffer.from("fine").toString("base64") });
  const link = await run({ op: "read", path: `${root}/link.md` }); expect(link.ok).toBe(false); expect(JSON.stringify(link)).not.toContain("outside");
  const staged = await run({ op: "write", path: `${root}/inputs/file_1/notes.txt`, data: Buffer.from("x").toString("base64"), createParents: true });
  expect(staged.ok).toBe(false);
  expect(vmStagedName("../../etc/passwd")).toBe("etc_passwd"); expect(vmStagedName(".hidden")).toBe("hidden"); expect(vmStagedName("ไฟล์.txt")).toBe("txt"); expect(vmStagedName("ไฟล์")).toBe("file");
});

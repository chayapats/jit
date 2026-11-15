import { expect, test } from "bun:test";
import type { ToolDefinition } from "schway/host";
import { createConversationVmTools } from "../src/s15/conversation/vm-port";
import type { ConversationPolicyWork } from "../src/s15/conversation/policy-port";
import type { VmSession, WorkingVmPort } from "../src/s15/vm";

function fixture() {
  const events: string[] = [], requests: unknown[] = [];
  const definition = (name: string): ToolDefinition => ({ name, execution: "exclusive", description: name, inputSchema: { type: "object" }, execute: async () => ({ content: "ok" }) });
  const session = { id: "placed_session", definitions: [definition("read"), definition("bash")], evidence: () => [], cancel: async () => { events.push("session cancel"); }, close: async () => { events.push("session close"); } } as unknown as VmSession;
  const vm = { async openAttempt(_actor: unknown, request: unknown) { requests.push(request); return session; } } as unknown as WorkingVmPort;
  const work = { actor: {}, authority: { id: "work", request: { resources: [{ id: "workspace" }] } } } as unknown as ConversationPolicyWork;
  const abort = new AbortController();
  return { vm, work, session, requests, events, definition, input: { mode: "execute" as const, signal: abort.signal, guard() { events.push("guard"); } } };
}

test("desktop tool binds the admitted placed session, not a model-selected VM; run cleanup precedes work-shell cleanup", async () => {
  const f = fixture(); let received: VmSession | undefined;
  const port = createConversationVmTools(f.vm, { vmId: "pool", resourceId: "workspace", async browser(session, guard, signal, actor) {
    expect(actor).toBe(f.work.actor);
    received = session; expect(guard).toBe(f.input.guard); expect(signal).toBe(f.input.signal);
    return { tools: [f.definition("computer_browser")], close() { f.events.push("browser close"); } };
  } });
  const tools = await port.open(f.work,f.input);
  expect(received).toBe(f.session); expect(f.requests[0]).toMatchObject({ vmId: "pool", workId: "work", access: "execute" });
  expect(tools.tools.map(t => [t.definition.name,t.access])).toEqual([["read","read"],["bash","reversible_write"],["computer_browser","reversible_write"]]);
  await tools.cancel(); expect(f.events.slice(-2)).toEqual(["browser close","session cancel"]);
  await tools.close(); expect(f.events.slice(-2)).toEqual(["browser close","session close"]);
});

test("inspect does not ask for a browser; a headless factory adds no browser to execute work", async () => {
  const f=fixture(); let calls=0;
  const port=createConversationVmTools(f.vm,{vmId:"pool",resourceId:"workspace",async browser(){calls++;return null;}});
  const inspect=await port.open(f.work,{...f.input,mode:"inspect"});expect(calls).toBe(0);expect(inspect.tools.map(t=>t.definition.name)).toEqual(["read"]);await inspect.close();
  const execute=await port.open(f.work,f.input);expect(calls).toBe(1);expect(execute.tools.map(t=>t.definition.name)).toEqual(["read","bash"]);await execute.close();
});

test("failed browser admission closes the VM session and offers nothing; a foreign resource never opens it", async () => {
  const f=fixture(),port=createConversationVmTools(f.vm,{vmId:"pool",resourceId:"workspace",async browser(){throw new Error("admission failed");}});
  await expect(port.open(f.work,f.input)).rejects.toThrow("admission failed");expect(f.events.at(-1)).toBe("session close");
  f.work.authority.request.resources=[];
  await expect(port.open(f.work,f.input)).rejects.toMatchObject({code:"outside_scope"});expect(f.requests).toHaveLength(1);
});

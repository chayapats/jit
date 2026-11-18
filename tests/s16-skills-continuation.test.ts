import { afterEach, expect, test } from "bun:test";
import { computerContinuationFixture } from "./fixtures/s16-computer-continuation";
import type { SkillCommand, SkillReceipt } from "../src/s16/skills/types";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const uid = () => crypto.randomUUID().replaceAll("-", "");
async function fixture() {
  const h = await computerContinuationFixture(true, 8, true), { f, client } = h; cleanup.push(() => f.close());
  const command = (value: object): Promise<SkillReceipt> => client.skillCommand({ contract: "s16-skill-command/v1", requestId: uid(), ...value } as SkillCommand);
  const imported = await command({ kind: "skill.import", input: { kind: "folder", label: "Continuation fixture", files: [{ path: "SKILL.md", base64: Buffer.from("---\nname: resume-notes\ndescription: Use the retained draft.\n---\nThe test command is bun test.\n").toString("base64") }] } });
  const detail = await client.skill(imported.skillId), recipients = await client.skillRecipients(imported.skillId, detail.candidate!.pin, {});
  await command({ kind: "skill.review", skillId: detail.record.id, expectedRevision: detail.record.revision, pin: detail.candidate!.pin, availability: { kind: "team" }, executable: true, dependencies: {}, recipientsHash: recipients.hash });
  const record = f.service.skills!.record(imported.skillId)!;
  // This fixture intentionally retains its explicit non-default policy. Its owning configuration, not the package,
  // admits the new data resource and exact provider/purpose sharing. The production default path is tested separately.
  f.policyInput.resources.push(record.resource); f.policyInput.rules[0]!.resources.push(record.resource);
  f.service.policy.owner.install(f.owner, uid(), f.service.policy.owner.current(f.owner)!.revision, f.policyInput);
  f.service.team.register(f.owner, uid(), 0, { ...record.resource, contract: "s15-team-resource/v1", label: "Resume notes", kind: "data", scope: { kind: "team" }, purposes: ["purpose"], allowedBots: null, deniedBots: [], operations: ["read", "write", "input"], active: true, coordinationKey: record.resource.id });
  f.recipientApprovals.push({ recipient: f.route.recipient, purpose: f.policyInput.purposes[0]!, resources: [record.resource], dataClasses: ["private"], sources: [record.source], expiresAt: f.policyInput.expiresAt });
  f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["computer", record.resource.id], access: "reversible_write", subject: null };
  h.skill = { skillId: record.id, unitId: f.service.skills!.package(record.activePin!).units[0]!.id };
  return { h, f, record, command };
}

test("a real computer continuation retains actual loaded skill evidence, DATA15 ancestry and the original work/workspace", async () => {
  const { h, f, record } = await fixture(); const initial = await f.chat("Use the reviewed notes and continue after signing in.", "skill_handoff");
  expect((await h.card()).state).toBe("pending"); expect(f.service.conversation.store.request("skill_handoff").skillUses).toMatchObject([{ skillId: record.id, pin: record.activePin }]);
  h.plan = "continue"; await h.handBack(); await f.service.drain();
  const rows = f.service.conversation.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE json_type(record_json,'$.computerContinuation')='object'").all(); expect(rows).toHaveLength(1);
  const resumed = f.service.conversation.view(f.owner, rows[0]!.id); expect(resumed.state).toBe("completed"); expect(resumed.authority!.id).toBe(initial.authority!.id);
  expect(h.prompts.at(-1)).toContain("The test command is bun test.");
  const work = f.service.conversation.options.policy.open(resumed.authority!), context = f.service.team.bind(work.actor);
  expect(f.service.memory.dataAncestry(context, resumed.receipt.rootRequestId).length).toBeGreaterThan(0);
  const sessions = f.service.vmStore.db.query<{ attempt_id: string }, [string]>("SELECT attempt_id FROM vm_sessions WHERE work_id=?").all(initial.authority!.id); expect(new Set(sessions.map(s => s.attempt_id))).toEqual(new Set([`chat_${initial.authority!.id}`]));
});

test("revoking a loaded skill during the continuation's actual model wait withholds its result and stops all later tools", async () => {
  const { h, f, record, command } = await fixture(); await f.chat("Use the reviewed notes before signing in.", "revoked_skill_handoff");
  h.plan = "continue"; const gate = h.hold("continue", 1); await h.handBack(); const draining = f.service.drain(); await gate.entered.promise;
  await command({ kind: "skill.revoke", skillId: record.id, expectedRevision: record.revision }); const vmCalls = f.vmCalls.length; gate.release.resolve(); await draining;
  const row = f.service.conversation.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE json_type(record_json,'$.computerContinuation')='object'").get()!;
  const result = f.service.conversation.view(f.owner, row.id); expect(result.state).not.toBe("completed"); expect(result.result).toBeNull(); expect(f.vmCalls).toHaveLength(vmCalls);
});

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProtectedDataStore, TEAM_SCHEMA_V1 } from "../src/s15/team/store";
import { MEMORY_SCHEMA_V1 } from "../src/s15/memory/store";
import { join } from "node:path";
import { SkillDirectory } from "../src/s16/skills/service";
import { skillDisclosure } from "../src/s16/skills/disclosure";
import type { SkillAvailability, SkillRecord } from "../src/s16/skills/types";
import { openDisclosureService, type DisclosureService, type DisclosureSource } from "../src/s15/disclosure";
import type { ComposedDisclosure } from "../src/s15/disclosure/composition";
import { disclosureMemory } from "../src/s15/disclosure/data-memory";
import { MemoryService } from "../src/s15/memory";
import { TeamService } from "../src/s15/team";
import { fixture, ref } from "./fixtures/s15-policy";
import { githubSkillFixture } from "./fixtures/s16-skills";
import type { OwnerActor, WorkActor } from "../src/s15/policy";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const uid = () => crypto.randomUUID().replaceAll("-", "");
const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString("base64") });
async function setup() {
  let directory!: SkillDirectory<OwnerActor>, disclosure!: DisclosureService, generation = 1, privateBot: string | null = null;
  const providers = [ref("payee")], unrelated = new Map<string, DisclosureSource>();
  const f = fixture({ catalogs: base => ({ ...base,
    current(kind, id) { const record = directory?.records().find(r => r.resource.id === id); if (kind === "resource" && record) return { ref: record.resource, active: record.state === "active" }; return base.current(kind, id); },
    allows: (work, action) => disclosure ? disclosure.catalogs(base).allows(work, action) : base.allows(work, action),
  }) });
  f.add("bot", ref("bot2")); f.input.bots.push(ref("bot2")); f.input.rules[0]!.bots.push(ref("bot2"));
  const directoryOptions = { path: join(f.dir, "skills.sqlite"), create: true, installationId: "test_installation", now: () => f.now, ownerGeneration: () => generation,
    requireOwner: (actor: OwnerActor) => { f.service.owner.current(actor); }, network: githubSkillFixture().network, bots: () => [{ id: "bot", name: "A" }, { id: "bot2", name: "B" }], dependency: () => null, recipients: () => providers, membership: () => "installed" as const,
  }; directory = new SkillDirectory(directoryOptions);
  const base: ComposedDisclosure = { catalogs: { source: value => unrelated.get(value.id) ?? null, recipient: value => ["payee", "other"].includes(value.id) ? { ref: value, active: true } : null, approvals: () => [] }, routes: [{ id: "out", kind: "adapter", resolve: (_work, payload) => [ref((payload as { to: string }).to)] }], modelRoute: () => "out", workSources: () => [] };
  const configured = skillDisclosure(base, { directory: () => directory, ownerGeneration: () => generation, computer: () => ({ resource: ref("account"), botId: privateBot }), copyCurrent: () => true, work: ref("purpose"), interpretation: ref("purpose"), now: () => f.now });
  disclosure = openDisclosureService({ ...configured, runtime: "s15", path: join(f.dir, "disclosure.sqlite"), create: true, installationId: "test_installation", now: () => f.now }); disclosure.attach(f.service);
  let team: TeamService | undefined, memory: MemoryService | undefined;
  cleanup.push(async () => { memory?.close(); team?.close(); disclosure.close(); await directory.close(); f.cleanup(); });
  const command = (value: object) => directory.command(f.owner, { contract: "s16-skill-command/v1", requestId: uid(), ...value });
  const imported = await command({ kind: "skill.import", input: { kind: "folder", label: "Notes", files: [file("SKILL.md", "---\nname: notes\ndescription: Follow the notes.\n---\nThe test command is bun test.\n")] } });
  const review = async (record: SkillRecord, availability: SkillAvailability = { kind: "team" }, executable = true) => {
    const pin = record.candidatePin ?? record.activePin!, sharing = directory.recipients(f.owner, record.id, pin, {});
    return command({ kind: record.candidatePin ? "skill.review" : "skill.availability", skillId: record.id, expectedRevision: record.revision, ...(record.candidatePin ? { pin, dependencies: {} } : {}), availability, executable, recipientsHash: sharing.hash });
  };
  await review(directory.record(imported.skillId)!);
  const active = directory.record(imported.skillId)!;
  f.input.resources.push(active.resource); f.input.rules[0]!.resources.push(active.resource); f.input.budget!.ceiling.calls = 100; f.install();
  const admit = (resources = [ref("account"), active.resource], bot = "bot") => { const result = f.admit({ resources, bot: ref(bot), access: "reversible_write" }); if (!result.actor) throw Error(JSON.stringify(result.receipt)); return result.actor; };
  const guard = (actor: WorkActor, recipient = "payee") => disclosure.guardRead(f.service.work.guard(actor), "out", { to: recipient });
  return { f, get directory() { return directory; }, get disclosure() { return disclosure; }, active, providers, unrelated, command, review, admit, guard, set privateBot(value: string | null) { privateBot = value; }, set generation(value: number) { generation = value; },
    async reopen() { disclosure.close(); await directory.close(); directory = new SkillDirectory({ ...directoryOptions, create: false }); disclosure = openDisclosureService({ ...configured, runtime: "s15", path: join(f.dir, "disclosure.sqlite"), create: false, installationId: "test_installation", now: () => f.now }); disclosure.attach(f.service); },
    memory() {
      const data = disclosureMemory(f.service, disclosure);
      team = new TeamService({ runtime: "s15", path: join(f.dir, "team.sqlite"), create: true, installationId: "test_installation", policy: f.service, now: () => f.now, maxConcurrentOperations: 8, producerCurrent: () => true, dataLineage: data.lineage });
      for (const resource of f.input.resources) team.register(f.owner, uid(), 0, { contract: "s15-team-resource/v1", ...resource, label: resource.id, kind: "data", scope: { kind: "team" }, purposes: ["purpose"], allowedBots: null, deniedBots: [], operations: ["read"], active: true, coordinationKey: resource.id });
      memory = new MemoryService({ runtime: "s15", path: join(f.dir, "memory.sqlite"), create: true, installationId: "test_installation", team, retention: () => ({ kind: "team" }), now: () => f.now });
      return { get team() { return team!; }, get memory() { return memory!; }, data,
        reopen() { const t = team!.options, m = memory!.options; memory!.close(); team!.close(); team = new TeamService({ ...t, create: false }); memory = new MemoryService({ ...m, team, create: false }); },
        checkRollback() {
          const t = team!.options, m = memory!.options; memory!.close(); team!.close();
          for (const [path, app, schema, formats] of [[t.path, 0x4a495436, TEAM_SCHEMA_V1, [1, 2]], [m.path, 0x4a495437, MEMORY_SCHEMA_V1, [1, 2, 3, 4]]] as const) {
            const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex"), before = hash();
            expect(() => new ProtectedDataStore(path, "test_installation", false, app, schema, true, formats)).toThrow("s15_data_store_incompatible"); expect(hash()).toBe(before);
          }
          team = new TeamService({ ...t, create: false }); memory = new MemoryService({ ...m, team, create: false });
        },
      };
    },
  };
}

test("text-only playbooks can be explicitly reviewed for computer use; frozen recipients never expand with provider configuration", async () => {
  const h = await setup(), actor = h.admit(); h.disclosure.read(actor, h.active.source); expect(() => h.guard(actor)).not.toThrow();
  h.providers.push(ref("other")); expect(() => h.guard(actor, "other")).toThrow("recipient_unapproved");
  const preview = h.directory.recipients(h.f.owner, h.active.id, h.active.activePin!, {}); h.providers.pop();
  await expect(h.command({ kind: "skill.availability", skillId: h.active.id, expectedRevision: h.active.revision, availability: { kind: "team" }, executable: true, recipientsHash: preview.hash })).rejects.toThrow("skill_recipients_changed");
});

test("a following ordinary work inherits VM-copy privacy without silently admitting the package; revocation does not declassify or erase that copy", async () => {
  const h = await setup(), first = h.admit(); h.disclosure.read(first, h.active.source); h.disclosure.vmInput(first, "vm");
  const next = h.admit([ref("account")]); h.disclosure.vmOutput(next, "vm"); expect(() => h.guard(next)).not.toThrow(); expect(() => h.guard(next, "other")).toThrow("recipient_unapproved");
  expect(h.disclosure.lineage(next).map(source => source.resource.id)).toEqual(["account"]);
  await h.command({ kind: "skill.revoke", skillId: h.active.id, expectedRevision: h.active.revision });
  expect(() => h.disclosure.lineage(first)).toThrow(/authority_revoked|lineage_withdrawn/); expect(() => h.guard(next)).not.toThrow();
  expect(h.directory.copies()).toMatchObject([{ pin: h.active.activePin, source: h.active.source, recipients: [ref("payee")], botIds: null }]);
  await h.reopen(); expect(() => h.guard(next)).not.toThrow(); expect(() => h.guard(next, "other")).toThrow("recipient_unapproved");
});

test("Bot-only know-how requires the actual private computer, and later broader availability cannot promote the released private copy", async () => {
  const h = await setup(); await h.review(h.active, { kind: "bots", botIds: ["bot"] });
  const scoped = h.directory.record(h.active.id)!; h.f.input.resources = [ref("account"), scoped.resource]; h.f.input.rules[0]!.resources = [...h.f.input.resources]; h.f.install();
  const first = h.admit(h.f.input.resources); h.disclosure.read(first, scoped.source);
  expect(() => h.disclosure.vmInput(first, "vm")).toThrow("skill_private_computer_required"); expect(h.directory.copies()).toHaveLength(0);
  h.privateBot = "bot"; h.disclosure.vmInput(first, "vm");
  await h.review(scoped); const broader = h.directory.record(scoped.id)!; h.f.input.resources = [ref("account"), broader.resource]; h.f.input.rules[0]!.resources = [...h.f.input.resources]; h.f.install();
  const other = h.admit([ref("account")], "bot2"); expect(() => h.disclosure.vmOutput(other, "vm")).toThrow("outside_scope");
  const same = h.admit([ref("account")]); h.disclosure.vmOutput(same, "vm"); expect(h.disclosure.lineage(same)[0]!.botIds).toEqual(["bot"]);
});

test("disabling computer use fences ordinary VM input too, including text-only instructions; unrelated private sources retain their own gates", async () => {
  const h = await setup(); await h.review(h.active, { kind: "team" }, false); const active = h.directory.record(h.active.id)!;
  h.f.input.resources = [ref("account"), active.resource]; h.f.input.rules[0]!.resources = [...h.f.input.resources]; h.f.install();
  const actor = h.admit(h.f.input.resources); h.disclosure.read(actor, active.source);
  expect(() => h.disclosure.vmInput(actor, "vm")).toThrow("skill_computer_use_disabled");
  h.unrelated.set("private", { ref: ref("private"), resource: ref("account"), classification: "private", active: true, ownerReleasable: true }); h.disclosure.read(actor, ref("private"));
  expect(() => h.guard(actor)).toThrow("recipient_unapproved");
});

test("actual later VM observations retain DATA15 ancestry in MEM, including correction, forget, private scope and fresh-recipient guards", async () => {
  const h = await setup(); h.privateBot = "bot"; const first = h.admit(); h.disclosure.read(first, h.active.source); h.disclosure.vmInput(first, "vm");
  const actor = h.admit([ref("account")]); h.disclosure.vmOutput(actor, "vm"); const { memory, team, data } = h.memory(), context = team.bind(actor);
  const evidence = { id: "actual_vm_read", tool: "vm_bash", inputHash: "a".repeat(64), outputHash: "b".repeat(64), isError: false, content: "The test command is bun test.", at: h.f.now };
  const refs = data.conversation.observed({ actor, authority: h.f.service.work.guard(actor) }, evidence);
  const claim = memory.retain(context, { id: "observed", text: evidence.content, origin: { kind: "work", id: evidence.id, conversationId: "conversation", at: h.f.now }, scope: { kind: "team" }, resources: [ref("account")], parents: [], dataRefs: refs })[0]!;
  expect(claim.provenance.scope).toEqual({ kind: "bot", botId: "bot", origin: "s15" }); expect(claim.provenance.dataRefs).toEqual(refs);
  const other = h.admit([ref("account")], "bot2"); expect(memory.prepare(team.bind(other), "other_packet", "test command").claims).toEqual([]);
  const correction = memory.command(h.f.owner, { contract: "s15-memory-command/v1", requestId: uid(), kind: "memory.correct", claim: { id: claim.id, revision: claim.revision }, text: "The test command is bun test --timeout 30000." }) as { claim: { id: string } };
  const next = h.admit([ref("account")]), nextContext = team.bind(next), packet = memory.prepare(nextContext, "next_packet", "test command"); expect(packet.claims[0]!.provenance.dataRefs).toEqual(refs); expect(packet.claims[0]!.id).toBe(correction.claim.id);
  expect(() => h.guard(next)).not.toThrow(); h.providers.push(ref("other")); expect(() => h.guard(next, "other")).toThrow("recipient_unapproved");
  memory.command(h.f.owner, { contract: "s15-memory-command/v1", requestId: uid(), kind: "memory.forget", claim: { id: packet.claims[0]!.id, revision: packet.claims[0]!.revision } });
  expect(() => memory.guard(nextContext, packet.id)).toThrow("memory_context_stale");
});


test("DATA15 metadata survives extraction with no claim, retains every ancestor and stamps rollback-safe TEAM/MEM formats", async () => {
  const h = await setup(), actor = h.admit(); h.disclosure.read(actor, h.active.source);
  const f = h.memory(), context = f.team.bind(actor), ref1 = ref("derived1"), ref2 = ref("derived2");
  h.disclosure.derive(actor, ref1, "text"); h.disclosure.derive(actor, ref2, "text");
  const packet = f.memory.prepare(context, "empty_packet", "ordinary instruction"); f.memory.includeData(context, packet.id, [ref1, ref2]);
  expect(f.memory.derivative(context, packet.id)).toMatchObject({ claimIds: [], dataRefs: [ref1, ref2] });
  // A private first ancestor must not short-circuit validation of every later descendant.
  expect(() => f.data.lineage.inspect(h.f.service.work.guard(actor), [ref1, ref("missing")])).toThrow();
  f.team.capture(context, { id: "captured", text: "Observed text.", origin: { kind: "work", id: "tool", conversationId: null, at: h.f.now }, scope: { kind: "team" }, resources: [h.active.resource], parents: [], dataRefs: [ref1] });
  expect(f.memory.contextLineage(context, packet.id).dataRefs).toEqual([ref1, ref2]);
  f.checkRollback(); const fresh = f.team.bind(actor); expect(f.memory.dataAncestry(fresh, packet.id)).toEqual([ref1, ref2]);
  expect(f.team.source(fresh, "captured").dataRefs).toEqual([ref1]);
});

import { join } from "node:path";
import { TeamService, type TeamContext, type TeamOptions, type TeamResource } from "../../src/s15/team";
import { MemoryService, type MemoryInput, type MemoryOptions } from "../../src/s15/memory";
import { fixture as policyFixture, ref } from "./s15-policy";

/** Real protected POLICY + explicit finite TEAM/MEM stores; no provider, VM, website or paid call. */
export function teamMemoryFixture() {
  const f = policyFixture();
  for (const name of ["bot2", "bot3"]) { f.add("bot", ref(name)); f.input.bots.push(ref(name)); f.input.rules[0]!.bots.push(ref(name)); }
  for (const name of ["browser", "private", "alias"]) { f.add("resource", ref(name)); f.input.resources.push(ref(name)); }
  f.input.budget!.ceiling.calls = 100; f.input.budget!.ceiling.spendMinor = "1000";
  f.install();
  let sequence = 0, producerLive = true;
  const options: TeamOptions = { runtime: "s15", path: join(f.dir, "team.sqlite"), create: true, installationId: "test_installation", policy: f.service, now: () => f.now, maxConcurrentOperations: 8, producerCurrent: () => producerLive };
  let team = new TeamService(options);
  const registration = (id: string, extra: Partial<TeamResource> = {}): TeamResource => ({ ...ref(id), contract: "s15-team-resource/v1", label: id, kind: id === "browser" ? "browser" : "workspace", scope: { kind: "team" }, purposes: ["purpose"], allowedBots: null, deniedBots: [], operations: ["read", "write", "input"], active: true, coordinationKey: id === "alias" ? "repo" : id, ...extra });
  for (const name of ["account", "repo", "browser", "alias"]) team.register(f.owner, `register_${name}`, 0, registration(name));
  team.register(f.owner, "register_private", 0, registration("private", { scope: { kind: "bot", botId: "bot", origin: "s14" } }));
  let retention: MemoryOptions["retention"] = () => ({ kind: "team" });
  const memoryOptions: MemoryOptions = { runtime: "s15", path: join(f.dir, "memory.sqlite"), create: true, installationId: "test_installation", team, retention: work => retention(work), now: () => f.now };
  let memory = new MemoryService(memoryOptions);
  const actors = new Map<TeamContext, NonNullable<ReturnType<typeof f.admit>["actor"]>>();
  const context = (botId = "bot", overrides: Parameters<typeof f.admit>[0] = {}) => {
    const { actor } = f.admit({ bot: ref(botId), resources: f.input.resources, access: "reversible_write", ...overrides });
    if (!actor) throw new Error("fixture work was not admitted");
    const result = team.bind(actor); actors.set(result, actor); return result;
  };
  const source = (text = "I prefer concise replies.", extra: Partial<MemoryInput> = {}): MemoryInput => ({ id: `source_${sequence++}`, text, origin: { kind: "owner_message", id: `message_${sequence++}`, conversationId: "conversation", at: f.now }, scope: { kind: "team" }, resources: [], parents: [], ...extra });
  return { f, options, registration, actors, context, source, get team() { return team; }, get memory() { return memory; }, set producerLive(value: boolean) { producerLive = value; }, set retention(value: MemoryOptions["retention"]) { retention = value; },
    reopen() { memory.close(); team.close(); team = new TeamService({ ...options, create: false }); memory = new MemoryService({ ...memoryOptions, team, create: false }); },
    cleanup() { memory.close(); team.close(); f.cleanup(); },
  };
}

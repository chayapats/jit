import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors";
import type { SourceRecord } from "../src/s16/connections/types";
import type { WorkAuthority } from "../src/s15/policy";
import { SkillDirectory } from "../src/s16/skills/service";
import type { SkillCommand, SkillRecord, SkillUse } from "../src/s16/skills/types";
import { githubSkillFixture, commit } from "./fixtures/s16-skills";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ref = (id: string) => ({ id, revision: 1, generation: 1 });
const uid = () => crypto.randomUUID().replaceAll("-", "");
const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString("base64") });
const folder = (text = "Use the observed changes.") => ({ kind: "folder" as const, label: "Fixture folder", files: [file("SKILL.md", `---\nname: notes\ndescription: Work with the notes.\n---\n${text}\n`), file("LICENSE", "MIT License\nSelf-authored fixture.\n"), file("scripts/notes.py", "print(7)\n")] });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-skills-")), path = join(root, "skills.sqlite"), owner = Object.freeze({}), github = githubSkillFixture();
  let generation = 1, memberFails = false, membership = 0;
  const source: SourceRecord = { contract: "s16-source/v1", id: "src_fixture", revision: 1, kind: "mcp", label: "Docs", endpoint: "https://docs.example.com/mcp", auth: { kind: "none", header: null, fingerprint: null, oauth: null }, state: "active", code: null, resource: ref("srcr_fixture"), recipient: ref("srcs_fixture"), source: ref("srcc_fixture"), catalog: { contract: "s16-source-catalog/v1", hash: "f".repeat(64), tools: [{ name: "read_notes", title: "Read notes", description: "Read fixture notes", inputSchema: { type: "object" }, schemaHash: "f".repeat(64), hint: { readOnly: true, destructive: false, method: null, operation: null }, suggested: "read", allowed: ["read", "change", "approval", "off"], binding: { kind: "mcp", tool: "read_notes" } }], skipped: [], truncated: false, server: { name: null, version: null, protocol: null }, discoveredAt: 1000 }, review: { revision: 1, catalogHash: "f".repeat(64), decisions: { read_notes: "read" }, reviewedAt: 1000 }, document: null, origin: { kind: "owner" }, createdAt: 1000, updatedAt: 1000, verifiedAt: 1000 };
  const options = (create: boolean) => ({ path, installationId: "fixture", create, now: () => 1000, ownerGeneration: () => generation, requireOwner(actor: object) { if (actor !== owner) throw new AppError("authentication_required", 401); }, network: github.network, bots: () => [{ id: "a", name: "A" }, { id: "b", name: "B" }], dependency: (id: string) => id === source.id ? source : null, membership() { membership++; if (memberFails) throw Error("controlled membership failure"); return "installed" as const; } });
  let directory = new SkillDirectory(options(true));
  const h = { owner, github, source, get directory() { return directory; }, get membership() { return membership; }, set memberFails(value: boolean) { memberFails = value; }, set generation(value: number) { generation = value; },
    async reopen() { await directory.close(); directory = new SkillDirectory(options(false)); },
    async close() { await directory.close(); rmSync(root, { recursive: true, force: true }); },
    command(command: Omit<SkillCommand, "contract" | "requestId"> & Record<string, unknown>, requestId = uid()) { return directory.command(owner, { contract: "s16-skill-command/v1", requestId, ...command }); },
    async imported() { const receipt = await directory.command(owner, { contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.import", input: folder() }); return directory.record(receipt.skillId)!; },
    review(record: SkillRecord, availability = { kind: "team" as const }) { return directory.command(owner, { contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.review", skillId: record.id, expectedRevision: record.revision, pin: record.candidatePin, availability, executable: true, dependencies: {} }); },
  };
  cleanups.push(() => h.close()); return h;
}
/** Host work facts for this directory's narrowing checks; POLICY/TEAM/DATA15 composition is separately tested. */
function work(record: SkillRecord, bot = "a", resources = [record.resource]): WorkAuthority {
  return { id: "work", mode: "work", readLimit: 32, ownerGeneration: 1, policyRevision: 1, policyHash: "f".repeat(64), createdAt: 1000, expiresAt: 100000, request: { requestId: "owner_command", intent: "execute", access: "reversible_write", purpose: ref("purpose"), bot: ref(bot), resources, recipients: [], selection: { route: ref("route"), model: ref("model"), effort: "low" }, selectionPin: null, expiresAt: 100000 } };
}
const use = (h: Awaited<ReturnType<typeof fixture>>, record: SkillRecord): SkillUse => ({ skillId: record.id, pin: record.activePin!, resource: record.resource, unitId: h.directory.package(record.activePin!).units[0]?.id ?? null });

test("folder import is inert, exact review enables scoped data, and duplicates/reopen preserve one review and use provenance", async () => {
  const h = await fixture(), candidate = await h.imported(); expect(candidate.state).toBe("needs_review"); expect(h.membership).toBe(0);
  await h.review(candidate); const active = h.directory.record(candidate.id)!, pin = use(h, active);
  expect(h.directory.guard(work(active), pin).id).toBe(active.id); h.directory.used(work(active), "request", pin);
  await h.reopen(); expect(h.directory.guard(work(active), pin).id).toBe(active.id);
  expect(h.directory.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM reviews").get()!.n).toBe(1);
  expect(h.directory.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM uses").get()!.n).toBe(1);
});

test("checking updates leaves the active pin and resource current until a new exact review fences earlier uses", async () => {
  const h = await fixture(), first = await h.imported(); await h.review(first); const active = h.directory.record(first.id)!, oldUse = use(h, active);
  await h.command({ kind: "skill.update", skillId: first.id, expectedRevision: active.revision, input: folder("Changed notes.") });
  const candidate = h.directory.record(first.id)!; expect(candidate.candidatePin).not.toBe(candidate.activePin); expect(candidate.resource).toEqual(active.resource);
  expect(h.directory.guard(work(active), oldUse).activePin).toBe(active.activePin); await h.review(candidate);
  expect(() => h.directory.guard(work(active), oldUse)).toThrow("skill_unavailable");
});

test("team/Bot availability is a narrowing check and missing work resources never become authority", async () => {
  const h = await fixture(), candidate = await h.imported();
  await h.command({ kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "bots", botIds: ["a"] }, executable: false, dependencies: {} });
  const active = h.directory.record(candidate.id)!, pin = use(h, active);
  expect(h.directory.guard(work(active), pin).review!.executable).toBe(false);
  expect(() => h.directory.guard({ ...work(active), mode: "interpretation" }, pin)).toThrow("outside_scope");
  expect(() => h.directory.guard(work(active, "b"), pin)).toThrow("outside_scope"); expect(() => h.directory.guard(work(active, "a", []), pin)).toThrow("outside_scope");
});

test("revocation is immediate even before membership settles and a replay cannot reinstall an older review", async () => {
  const h = await fixture(), candidate = await h.imported(), reviewId = uid();
  const command = { contract: "s16-skill-command/v1", requestId: reviewId, kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: true, dependencies: {} };
  const oldReceipt = await h.directory.command(h.owner, command), active = h.directory.record(candidate.id)!; h.memberFails = true;
  await expect(h.command({ kind: "skill.revoke", skillId: active.id, expectedRevision: active.revision })).rejects.toThrow("controlled membership failure");
  expect(() => h.directory.guard(work(active), use(h, active))).toThrow("skill_unavailable");
  h.memberFails = false; const calls = h.membership; expect(await h.directory.command(h.owner, command)).toEqual(oldReceipt); expect(h.membership).toBe(calls);
  await h.reopen(); expect(h.directory.record(active.id)!.state).toBe("revoked");
});

test("a lost membership reply reuses the committed exact review without bumping its revision", async () => {
  const h = await fixture(), candidate = await h.imported(), requestId = uid();
  const command = { contract: "s16-skill-command/v1", requestId, kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: true, dependencies: {} };
  h.memberFails = true; await expect(h.directory.command(h.owner, command)).rejects.toThrow(); const committed = h.directory.record(candidate.id)!;
  await h.reopen(); h.memberFails = false; const receipt = await h.directory.command(h.owner, command); expect(receipt.revision).toBe(committed.revision); expect(receipt.policy).toBe("installed");
  expect(h.directory.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM reviews").get()!.n).toBe(1);
});

test("a dependency must match the current reviewed connection and remain in the admitted work", async () => {
  const h = await fixture(), imported = await h.command({ kind: "skill.import", input: { kind: "github", url: "https://github.com/owner/repo/tree/main/example" } });
  const candidate = h.directory.record(imported.skillId)!;
  await expect(h.review(candidate)).rejects.toThrow("skill_dependency_unavailable");
  await h.command({ kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: false, dependencies: { docs: { sourceId: h.source.id, catalogHash: h.source.catalog!.hash, reviewRevision: 1 } } });
  const active = h.directory.record(candidate.id)!, pin = use(h, active);
  expect(() => h.directory.guard(work(active), pin)).toThrow("skill_dependency_outside_scope");
  expect(h.directory.guard(work(active, "a", [active.resource, h.source.resource]), pin).id).toBe(active.id);
  h.source.review!.decisions.read_notes = "off"; expect(() => h.directory.guard(work(active, "a", [active.resource, h.source.resource]), pin)).toThrow("skill_dependency_unavailable");
  h.source.state = "removed"; expect(() => h.directory.guard(work(active, "a", [active.resource, h.source.resource]), pin)).toThrow("skill_dependency_unavailable");
});

test("an interrupted GitHub import resumes the saved commit rather than re-resolving a moving branch", async () => {
  const h = await fixture(), requestId = uid(), command = { contract: "s16-skill-command/v1", requestId, kind: "skill.import", input: { kind: "github", url: "https://github.com/owner/repo/tree/main/example" } };
  h.github.failBlobs = true; await expect(h.directory.command(h.owner, command)).rejects.toThrow("skill_source_unavailable");
  const pending = h.directory.store.db.query<{ resolved_json: string }, [string]>("SELECT resolved_json FROM pending WHERE id=?").get(requestId)!; expect(JSON.parse(pending.resolved_json).commit).toBe(commit);
  expect(h.directory.records()).toHaveLength(0); await h.reopen(); h.github.failBlobs = false;
  const result = await h.directory.command(h.owner, command); expect(h.directory.package(result.pin!).origin).toMatchObject({ commit });
  expect(h.github.hits.filter(url => url.includes("/git/ref/heads/"))).toHaveLength(1);
});

test("command snapshots are immutable and changed bytes, forged provenance or another owner cannot reuse their identity", async () => {
  const h = await fixture(), requestId = uid(), input = folder(), command = { contract: "s16-skill-command/v1", requestId, kind: "skill.import", input };
  const pending = h.directory.command(h.owner, command); input.files[0]!.base64 = Buffer.from("changed").toString("base64");
  const result = await pending; expect(h.directory.package(result.pin!).units).toHaveLength(1);
  await expect(h.directory.command(h.owner, command)).rejects.toThrow("request_id_conflict");
  await expect(h.directory.command({}, { ...command, requestId: uid() })).rejects.toThrow("authentication_required");
  await expect(h.command({ kind: "skill.import", input: { kind: "folder", label: "forged", files: folder().files, origin: { kind: "github", commit } } })).rejects.toThrow();
  h.generation = 2; expect(() => h.directory.detail(h.owner, result.skillId)).toThrow("owner_changed");
});


test("unsupported-only candidates stay reviewable data and cannot be advertised as an active package", async () => {
  const h = await fixture(), receipt = await h.command({ kind: "skill.import", input: { kind: "folder", label: "Unsupported", files: [file("plugin.json", '{"name":"unsupported"}'), file("hooks/hooks.json", '{"start":"touch /protected/marker"}')] } });
  const candidate = h.directory.record(receipt.skillId)!;
  await expect(h.review(candidate)).rejects.toThrow("skill_parts_unavailable"); expect(h.directory.record(candidate.id)!.state).toBe("needs_review"); expect(h.membership).toBe(0);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors";
import type { SourceRecord } from "../src/s16/connections/types";
import { digest } from "../src/s15/policy/validation";
import type { WorkAuthority } from "../src/s15/policy";
import { SkillDirectory } from "../src/s16/skills/service";
import type { SkillCommand, SkillRecord, SkillUse } from "../src/s16/skills/types";
import { githubSkillFixture, commit } from "./fixtures/s16-skills";
import { canonicalSkill, skillCommandHash } from "../src/s16/skills/encoding";
import { canonical } from "../src/s15/policy/validation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ref = (id: string) => ({ id, revision: 1, generation: 1 });
const recipientsHash = digest("s16.skill.recipients.v1", []);
const uid = () => crypto.randomUUID().replaceAll("-", "");
const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString("base64") });
const folder = (text = "Use the observed changes.") => ({ kind: "folder" as const, label: "Fixture folder", files: [file("SKILL.md", `---\nname: notes\ndescription: Work with the notes.\n---\n${text}\n`), file("LICENSE", "MIT License\nSelf-authored fixture.\n"), file("scripts/notes.py", "print(7)\n")] });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-skills-")), path = join(root, "skills.sqlite"), owner = Object.freeze({}), github = githubSkillFixture();
  let generation = 1, memberFails = false, membership = 0;
  const source: SourceRecord = { contract: "s16-source/v1", id: "src_fixture", revision: 1, kind: "mcp", label: "Docs", endpoint: "https://docs.example.com/mcp", auth: { kind: "none", header: null, fingerprint: null, oauth: null }, state: "active", code: null, resource: ref("srcr_fixture"), recipient: ref("srcs_fixture"), source: ref("srcc_fixture"), catalog: { contract: "s16-source-catalog/v1", hash: "f".repeat(64), tools: [{ name: "read_notes", title: "Read notes", description: "Read fixture notes", inputSchema: { type: "object" }, schemaHash: "f".repeat(64), hint: { readOnly: true, destructive: false, method: null, operation: null }, suggested: "read", allowed: ["read", "change", "approval", "off"], binding: { kind: "mcp", tool: "read_notes" } }], skipped: [], truncated: false, server: { name: null, version: null, protocol: null }, discoveredAt: 1000 }, review: { revision: 1, catalogHash: "f".repeat(64), decisions: { read_notes: "read" }, reviewedAt: 1000 }, document: null, origin: { kind: "owner" }, createdAt: 1000, updatedAt: 1000, verifiedAt: 1000 };
  const options = (create: boolean) => ({ path, installationId: "fixture", create, now: () => 1000, ownerGeneration: () => generation, requireOwner(actor: object) { if (actor !== owner) throw new AppError("authentication_required", 401); }, network: github.network, bots: () => [{ id: "a", name: "A" }, { id: "b", name: "B" }], recipients: () => [], dependency: (id: string) => id === source.id ? source : null, membership() { membership++; if (memberFails) throw Error("controlled membership failure"); return "installed" as const; } });
  let directory = new SkillDirectory(options(true));
  const h = { owner, github, source, get directory() { return directory; }, get membership() { return membership; }, set memberFails(value: boolean) { memberFails = value; }, set generation(value: number) { generation = value; },
    async reopen() { await directory.close(); directory = new SkillDirectory(options(false)); },
    async close() { await directory.close(); rmSync(root, { recursive: true, force: true }); },
    command(command: Omit<SkillCommand, "contract" | "requestId"> & Record<string, unknown>, requestId = uid()) { return directory.command(owner, { contract: "s16-skill-command/v1", requestId, ...command }); },
    async imported() { const receipt = await directory.command(owner, { contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.import", input: folder() }); return directory.record(receipt.skillId)!; },
    review(record: SkillRecord, availability = { kind: "team" as const }) { return directory.command(owner, { contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.review", skillId: record.id, expectedRevision: record.revision, pin: record.candidatePin, availability, executable: true, dependencies: {}, recipientsHash }); },
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

for (const kind of ["skill.import", "skill.update"] as const) test(`revocation fences active use while ${kind} is waiting on its first network read`, async () => {
  const h = await fixture(), candidate = await h.imported(); await h.review(candidate); const active = h.directory.record(candidate.id)!;
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), original = h.github.network.request;
  h.github.network.request = async (...args) => { entered.resolve(); await resume.promise; return original(...args); };
  const pending = h.command({ kind, ...(kind === "skill.update" ? { skillId: active.id, expectedRevision: active.revision } : {}), input: { kind: "github", url: "https://github.com/owner/repo/tree/main/example" } }).then(value => value, error => error);
  try {
    await entered.promise; const revoked = h.command({ kind: "skill.revoke", skillId: active.id, expectedRevision: active.revision });
    expect(h.directory.record(active.id)!.state).toBe("revoked"); expect(() => h.directory.guard(work(active), use(h, active))).toThrow("skill_unavailable");
    resume.resolve(); await revoked;
    const result = await pending;
    if (kind === "skill.update") expect(result.message).toBe("stale_revision"); else expect(result.state).toBe("needs_review");
    expect(h.directory.record(active.id)!.state).toBe("revoked"); await h.reopen(); expect(h.directory.record(active.id)!.state).toBe("revoked");
  } finally { resume.resolve(); await pending; }
});

test("package encoding preserves small command identities and accepts a full 2 MiB folder without changing POLICY's limit", async () => {
  const h = await fixture(), input = folder(), small = { contract: "s16-skill-command/v1", requestId: uid(), kind: "skill.import", input: folder() };
  expect(canonicalSkill(small)).toBe(canonical(small)); expect(skillCommandHash(small)).toBe(digest("s16.skills.command.v1", small));
  let remaining = 2 * 1024 * 1024 - input.files.reduce((n, file) => n + Buffer.from(file.base64, "base64").length, 0);
  for (let i = 0; remaining; i++) { const bytes = Math.min(remaining, 65536); input.files.push(file(`resources/part_${i}.txt`, "a".repeat(bytes))); remaining -= bytes; }
  expect(() => canonical(input)).toThrow("input_too_large");
  const requestId = uid(), command = { ...small, requestId, input }, result = await h.directory.command(h.owner, command);
  expect(h.directory.package(result.pin!).files.reduce((n, file) => n + file.bytes, 0)).toBe(2 * 1024 * 1024);
  await h.reopen(); expect(await h.directory.command(h.owner, command)).toEqual(result); await h.review(h.directory.record(result.skillId)!);
  expect(h.directory.detail(h.owner, result.skillId).active!.files.find(file => file.path === input.files.at(-1)!.path)!.base64).toBe(input.files.at(-1)!.base64);
});

test("verified GitHub packages above the policy envelope retain all immutable blob bytes", async () => {
  const h = await fixture(), github = githubSkillFixture(new Map([["SKILL.md", Buffer.from(folder().files[0]!.base64, "base64").toString()], ["one.txt", "a".repeat(65536)], ["two.txt", "b".repeat(65536)]]));
  h.github.network.request = github.network.request;
  const result = await h.command({ kind: "skill.import", input: { kind: "github", url: "https://github.com/owner/repo" } });
  expect(h.directory.package(result.pin!).files.filter(file => file.bytes === 65536)).toHaveLength(2); await h.reopen();
  expect(h.directory.package(result.pin!).files.find(file => file.path === "two.txt")!.base64).toBe(Buffer.from("b".repeat(65536)).toString("base64"));
});

test("an unchanged update retains the active review without advertising a candidate or fencing current work", async () => {
  const h = await fixture(), first = await h.imported(); await h.review(first);
  const active = h.directory.record(first.id)!, oldUse = use(h, active), requestId = uid();
  const command = { contract: "s16-skill-command/v1", requestId, kind: "skill.update", skillId: first.id, expectedRevision: active.revision, input: folder() };
  const receipt = await h.directory.command(h.owner, command), current = h.directory.record(first.id)!;
  expect(current.activePin).toBe(active.activePin); expect(current.candidatePin).toBeNull(); expect(current.review).toEqual(active.review);
  expect(current.resource).toEqual(active.resource); expect(current.source).toEqual(active.source);
  expect(h.directory.guard(work(active), oldUse).id).toBe(first.id);
  await h.reopen(); expect(await h.directory.command(h.owner, command)).toEqual(receipt); expect(h.directory.detail(h.owner, first.id).candidate).toBeNull();
});

test("sharing previews bind the record's active or candidate pin and cannot borrow another retained package", async () => {
  const h = await fixture(), first = await h.imported(); await h.review(first);
  const active = h.directory.record(first.id)!, other = await h.command({ kind: "skill.import", input: folder("Unrelated package.") });
  expect(() => h.directory.recipients(h.owner, first.id, other.pin!, {})).toThrow("skill_pin_invalid");
  expect(h.directory.recipients(h.owner, first.id, active.activePin!, {}).hash).toBe(recipientsHash);
  await h.command({ kind: "skill.update", skillId: first.id, expectedRevision: active.revision, input: folder("Reviewed separately.") });
  const candidate = h.directory.record(first.id)!;
  expect(h.directory.recipients(h.owner, first.id, candidate.candidatePin!, {}).hash).toBe(recipientsHash);
  expect(h.directory.recipients(h.owner, first.id, candidate.activePin!, {}).hash).toBe(recipientsHash);
});

test("team/Bot availability is a narrowing check and missing work resources never become authority", async () => {
  const h = await fixture(), candidate = await h.imported();
  await h.command({ kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "bots", botIds: ["a"] }, executable: false, dependencies: {}, recipientsHash });
  const active = h.directory.record(candidate.id)!, pin = use(h, active);
  expect(h.directory.guard(work(active), pin).review!.executable).toBe(false);
  expect(() => h.directory.guard({ ...work(active), mode: "interpretation" }, pin)).toThrow("outside_scope");
  expect(() => h.directory.guard(work(active, "b"), pin)).toThrow("outside_scope"); expect(() => h.directory.guard(work(active, "a", []), pin)).toThrow("outside_scope");
});

test("revocation is immediate even before membership settles and a replay cannot reinstall an older review", async () => {
  const h = await fixture(), candidate = await h.imported(), reviewId = uid();
  const command = { contract: "s16-skill-command/v1", requestId: reviewId, kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: true, dependencies: {}, recipientsHash };
  const oldReceipt = await h.directory.command(h.owner, command), active = h.directory.record(candidate.id)!; h.memberFails = true;
  await expect(h.command({ kind: "skill.revoke", skillId: active.id, expectedRevision: active.revision })).rejects.toThrow("controlled membership failure");
  expect(() => h.directory.guard(work(active), use(h, active))).toThrow("skill_unavailable");
  h.memberFails = false; const calls = h.membership; expect(await h.directory.command(h.owner, command)).toEqual(oldReceipt); expect(h.membership).toBe(calls);
  await h.reopen(); expect(h.directory.record(active.id)!.state).toBe("revoked");
});

test("a lost membership reply reuses the committed exact review without bumping its revision", async () => {
  const h = await fixture(), candidate = await h.imported(), requestId = uid();
  const command = { contract: "s16-skill-command/v1", requestId, kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: true, dependencies: {}, recipientsHash };
  h.memberFails = true; await expect(h.directory.command(h.owner, command)).rejects.toThrow(); const committed = h.directory.record(candidate.id)!;
  await h.reopen(); h.memberFails = false; const receipt = await h.directory.command(h.owner, command); expect(receipt.revision).toBe(committed.revision); expect(receipt.policy).toBe("installed");
  expect(h.directory.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM reviews").get()!.n).toBe(1);
});

test("a dependency must match the current reviewed connection and remain in the admitted work", async () => {
  const h = await fixture(), imported = await h.command({ kind: "skill.import", input: { kind: "github", url: "https://github.com/owner/repo/tree/main/example" } });
  const candidate = h.directory.record(imported.skillId)!;
  await expect(h.review(candidate)).rejects.toThrow("skill_dependency_unavailable");
  await h.command({ kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: false, dependencies: { docs: { sourceId: h.source.id, catalogHash: h.source.catalog!.hash, reviewRevision: 1 } }, recipientsHash: digest("s16.skill.recipients.v1", [h.source.recipient]) });
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
  const hits = h.github.hits.length; expect(h.directory.status(h.owner, requestId).state).toBe("interrupted"); expect(h.github.hits).toHaveLength(hits);
  const result = await h.directory.resume(h.owner, requestId); expect(h.directory.package(result.pin!).origin).toMatchObject({ commit });
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

test("a folder import interrupted before candidate commit resumes by identity without reselecting or changing its bytes", async () => {
  const h = await fixture(), requestId = uid(), original = folder("Original frozen instructions.");
  h.directory.store.db.exec("CREATE TRIGGER fixture_commit_stop BEFORE INSERT ON skills BEGIN SELECT RAISE(ABORT,'fixture_commit_stop'); END");
  await expect(h.directory.command(h.owner, { contract: "s16-skill-command/v1", requestId, kind: "skill.import", input: original })).rejects.toThrow("fixture_commit_stop");
  original.files[0]!.base64 = Buffer.from("Caller changed its local files.").toString("base64");
  expect(h.directory.status(h.owner, requestId).state).toBe("interrupted"); await h.reopen();
  h.directory.store.db.exec("DROP TRIGGER fixture_commit_stop");
  const result = await h.directory.resume(h.owner, requestId);
  expect(h.directory.package(result.pin!).units[0]!.body).toBe("Original frozen instructions.\n"); expect(result.state).toBe("needs_review"); expect(h.membership).toBe(0);
});

test("status reads never reconcile membership; explicit identity recovery reconciles only its committed exact review", async () => {
  const h = await fixture(), candidate = await h.imported(), requestId = uid(); h.memberFails = true;
  await expect(h.command({ kind: "skill.review", skillId: candidate.id, expectedRevision: candidate.revision, pin: candidate.candidatePin, availability: { kind: "team" }, executable: true, dependencies: {}, recipientsHash }, requestId)).rejects.toThrow("controlled membership failure");
  const status = h.directory.status(h.owner, requestId); expect(status.state).toBe("complete");
  if (status.state === "complete") expect(status.receipt.policy).toBe("review_required");
  const before = h.membership; h.directory.status(h.owner, requestId); expect(h.membership).toBe(before);
  await h.reopen(); h.memberFails = false; const restored = await h.directory.resume(h.owner, requestId); expect(restored.policy).toBe("installed"); expect(h.directory.record(candidate.id)!.revision).toBe(restored.revision);
});

test("the owner generation is bound at queue ingress, before another command or microtask can run", async () => {
  const h = await fixture(), requestId = uid();
  const queued = h.command({ kind: "skill.import", input: folder() }, requestId); expect(h.directory.status(h.owner, requestId).state).toBe("queued");
  h.generation = 2; await expect(queued).rejects.toThrow("owner_changed"); expect(h.directory.records()).toEqual([]);
  expect(h.directory.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM pending").get()!.n).toBe(0);
});


test("the owner can re-review an unchanged pin against a newly reviewed dependency without re-importing its bytes", async () => {
  const h = await fixture(), receipt = await h.command({ kind: "skill.import", input: { kind: "github", url: "https://github.com/owner/repo/tree/main/example" } });
  let current = h.directory.record(receipt.skillId)!;
  const review = () => h.command({ kind: "skill.review", skillId: current.id, expectedRevision: current.revision, pin: current.candidatePin ?? current.activePin, availability: { kind: "team" }, executable: false, dependencies: { docs: { sourceId: h.source.id, catalogHash: h.source.catalog!.hash, reviewRevision: h.source.review!.revision } }, recipientsHash: digest("s16.skill.recipients.v1", [h.source.recipient]) });
  await review(); current = h.directory.record(current.id)!; const old = use(h, current); h.source.review!.revision++;
  expect(() => h.directory.guard(work(current, "a", [current.resource, h.source.resource]), old)).toThrow("skill_dependency_unavailable");
  await review(); const fresh = h.directory.record(current.id)!; expect(fresh.activePin).toBe(current.activePin); expect(fresh.resource.revision).toBe(current.resource.revision + 1);
  expect(h.directory.guard(work(fresh, "a", [fresh.resource, h.source.resource]), use(h, fresh)).id).toBe(fresh.id);
});


test("package-sized encoding still refuses accessors, cycles, exotic values, credentials and an oversized envelope", () => {
  let reads = 0; const getter = { get value() { reads++; return "no"; } }, cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const value of [getter, cyclic, new Date(), [undefined], { value: "Bearer " + "a".repeat(32) }]) expect(() => canonicalSkill(value)).toThrow();
  expect(reads).toBe(0);
  expect(() => canonicalSkill(Array.from({ length: 129 }, () => "a".repeat(65536)))).toThrow("input_too_large");
});

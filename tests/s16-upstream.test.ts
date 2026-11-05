import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { browserLicenseHeader, validateUpstream } from "../ops/package/upstream";
import { buildPackage, validateArtifact } from "../ops/package/bun-build";

const repo = resolve(import.meta.dir, ".."), roots: string[] = [], inventory = "third_party/rakazo/provenance.json";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch() { const root = mkdtempSync(join(tmpdir(), "jit-upstream-")); roots.push(root); return root; }
function fixture() {
  const root = scratch();
  for (const entry of ["package.json", "bun.lock", "LICENSE", "NOTICE", "third_party"]) cpSync(join(repo, entry), join(root, entry), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, inventory), "utf8"));
  for (const item of manifest.files) { const dest = join(root, item.destination); mkdirSync(dirname(dest), { recursive: true }); cpSync(join(repo, item.destination), dest); }
  const reseal = () => { const path = join(root, inventory); writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n"); writeFileSync(join(root, "third_party/rakazo/provenance.sha256"), hash(readFileSync(path)) + "\n"); };
  return { root, manifest, reseal };
}

test("the checked originals, adaptations, dependencies and licenses pass without modifying inventory bytes", () => {
  const before = readFileSync(join(repo, inventory)); const result = validateUpstream(repo);
  expect(result?.files).toHaveLength(2); expect(result?.licenses).toHaveLength(6);
  expect(validateUpstream(repo)).toEqual(result); expect(readFileSync(join(repo, inventory))).toEqual(before);
});

test.each(["NOTICE", "third_party/rakazo/LICENSE", "third_party/rakazo/provenance.sha256"])("missing distribution member refuses validation: %s", missing => {
  const f = fixture(); rmSync(join(f.root, missing)); expect(() => validateUpstream(f.root)).toThrow();
});

test("altered upstream pins fail both before and after an inconsistent inventory reseal", () => {
  const f = fixture(); f.manifest.upstream.tree = "f".repeat(40);
  writeFileSync(join(f.root, inventory), JSON.stringify(f.manifest)); expect(() => validateUpstream(f.root)).toThrow("invalid_upstream_review_pin");
  f.manifest.upstream.commit = f.manifest.files[0].commit = f.manifest.files[1].commit = "e".repeat(40); f.reseal();
  expect(() => validateUpstream(f.root)).toThrow();
});

test("original source drift and adapted drift fail; restoring the exact previous adaptation is a valid code rollback", () => {
  const f = fixture(), item = f.manifest.files[0], dest = join(f.root, item.destination), original = readFileSync(dest);
  writeFileSync(dest, original.toString() + "\nexport const accidentalChange = true;\n"); expect(() => validateUpstream(f.root)).toThrow("invalid_upstream_destination_pin");
  writeFileSync(dest, original); expect(validateUpstream(f.root)?.files).toHaveLength(2);
  const reference = join(f.root, "third_party/rakazo/sources", item.commit, item.source); writeFileSync(reference, "changed original");
  expect(() => validateUpstream(f.root)).toThrow("invalid_upstream_source_pin");
});

test("removing the modification notice cannot pass merely by updating the destination hash", () => {
  const f = fixture(), item = f.manifest.files[0], dest = join(f.root, item.destination);
  const bytes = readFileSync(dest, "utf8").replace("Modified for Jit:", "Adaptation:"); writeFileSync(dest, bytes); item.destinationSha256 = hash(bytes); f.reseal();
  expect(() => validateUpstream(f.root)).toThrow("invalid_upstream_modified_notice");
});

test.each(["package", "lock", "import", "unlisted"])("unreviewed dependency/import/source changes are rejected: %s", kind => {
  const f = fixture();
  if (kind === "package") { const path = join(f.root, "package.json"), pkg = JSON.parse(readFileSync(path, "utf8")); pkg.dependencies["unreviewed-runtime"] = "1.0.0"; writeFileSync(path, JSON.stringify(pkg)); }
  if (kind === "lock") writeFileSync(join(f.root, "bun.lock"), readFileSync(join(f.root, "bun.lock"), "utf8") + "\nchanged lock\n");
  if (kind === "import") { const item = f.manifest.files[0], dest = join(f.root, item.destination); const source = readFileSync(dest, "utf8") + '\nimport "@rakazo/runtime";\n'; writeFileSync(dest, source); item.destinationSha256 = hash(source); item.imports = ["@rakazo/runtime"]; f.reseal(); }
  if (kind === "unlisted") writeFileSync(join(f.root, "src/new-copy.ts"), "/** Adapted from Rakazo */\nexport const copied = true;\n");
  expect(() => validateUpstream(f.root)).toThrow(kind === "package" || kind === "lock" ? "invalid_upstream_dependency_review" : kind === "import" ? "invalid_upstream_imports" : "invalid_upstream_unlisted_source");
});

test("symlinked originals cannot substitute an external audit source", () => {
  const f = fixture(), item = f.manifest.files[0], path = join(f.root, "third_party/rakazo/sources", item.commit, item.source);
  rmSync(path); symlinkSync(join(repo, "third_party/rakazo/sources", item.commit, item.source), path);
  expect(() => validateUpstream(f.root)).toThrow("invalid_upstream_file");
});

test("historical v1 attribution remains readable but new builds require the current inventory", () => {
  const f = fixture(); writeFileSync(join(f.root, inventory), JSON.stringify({ contract: "jit.upstream-provenance/v1", files: [] }));
  expect(validateUpstream(f.root, { historical: true })).toBeNull(); expect(() => validateUpstream(f.root)).toThrow();
  rmSync(join(f.root, inventory)); expect(validateUpstream(f.root, { historical: true })).toBeNull(); expect(() => validateUpstream(f.root)).toThrow();
});

test("packaging refuses missing notices before output and seals the actual accepted source/license files", () => {
  const root = scratch(), source = join(root, "checkout");
  for (const entry of ["package.json", "bun.lock", "src", "ops/package", "ops/box", "vendor", "LICENSE", "NOTICE", "third_party"]) cpSync(join(repo, entry), join(source, entry), { recursive: true });
  const notice = readFileSync(join(source, "NOTICE")); rmSync(join(source, "NOTICE")); const output = join(root, "refused");
  expect(() => buildPackage({ srcDir: source, outDir: output, engineContract: "jit.schway.bridge/v1", engineRevision: null })).toThrow(); expect(existsSync(output)).toBe(false);
  writeFileSync(join(source, "NOTICE"), notice); const accepted = join(root, "release");
  buildPackage({ srcDir: source, outDir: accepted, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  expect(validateArtifact(accepted).ok).toBe(true);
  const review = validateUpstream(accepted)!;
  for (const license of review.licenses) expect(readFileSync(join(accepted, license.path))).toEqual(readFileSync(join(repo, license.path)));
  const reference = join(accepted, "third_party/rakazo/sources", review.files[0]!.commit, review.files[0]!.source);
  writeFileSync(reference, "altered after release");
  expect(validateArtifact(accepted).checks).toContainEqual({ check: "upstream-provenance", ok: false });
});

test("actual packed browser consumer distributes complete notices and modification provenance", async () => {
  const root = scratch(), output = join(root, "release");
  buildPackage({ srcDir: repo, outDir: output, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  for (const name of ["react", "react-dom", "scheduler"]) cpSync(join(repo, "node_modules", name), join(output, "node_modules", name), { recursive: true });
  const program = `import {createS16WebHandler} from ${JSON.stringify(pathToFileURL(join(output, "src/s16/web/handler.ts")).href)};
    import {readFileSync} from 'node:fs'; import {join} from 'node:path';
    const root=${JSON.stringify(output)}, review=JSON.parse(readFileSync(join(root,${JSON.stringify(inventory)}),'utf8'));
    const handler=await createS16WebHandler(async()=>new Response('authenticated'));
    const response=await handler(new Request('http://localhost/s16/client.js')), source=await response.text();
    console.log(JSON.stringify({status:response.status, preserved:review.licenses.every(l=>source.includes(readFileSync(join(root,l.path),'utf8'))), modified:review.files.every(f=>source.includes(f.commit)&&source.includes(f.modifications)), bytes:source.length}));`;
  const child = Bun.spawn([process.execPath, "-e", program], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" }); expect(JSON.parse(stdout)).toMatchObject({ status: 200, preserved: true, modified: true });
}, 30000);

test("inert upstream originals and unreviewed runtime packages cannot enter the browser input graph", () => {
  const item = validateUpstream(repo)!.files[0]!;
  expect(() => browserLicenseHeader(repo, { [join(repo, "third_party/rakazo/sources", item.commit, item.source)]: {} })).toThrow("invalid_upstream_browser_input");
  expect(() => browserLicenseHeader(repo, { [join(repo, "node_modules/playwright-core/index.mjs")]: {} })).toThrow("invalid_upstream_browser_input");
});

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

interface ImportedFile {
  repository: string; commit: string; source: string; sha256: string; destination: string;
  destinationSha256: string; license: string; modifications: string; imports: string[]; review: string;
}
interface UpstreamManifest {
  contract: "jit.upstream-provenance/v2";
  upstream: { repository: string; commit: string; tree: string; archiveSha256: string; notice: null };
  files: ImportedFile[]; dependencies: Record<string, string>; lockSha256: string;
  browserDependencies: Record<string, string>; licenses: { path: string; sha256: string }[]; assets: [];
}
const inventory = "third_party/rakazo/provenance.json";
const requiredLicenses = ["LICENSE", "NOTICE", "third_party/rakazo/LICENSE", "third_party/react/react-LICENSE", "third_party/react/react-dom-LICENSE", "third_party/react/scheduler-LICENSE"].sort();
function fail(code = "invalid_upstream_provenance"): never { throw new Error(code); }
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value);
function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail();
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("*/")) fail(); }
function dictionary(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) fail();
  for (const [name, version] of Object.entries(value)) { text(name); text(version); }
}
/** Read bounded regular inventory members; references cannot follow symlinks or escape the release. */
function member(root: string, path: string): Buffer {
  if (typeof path !== "string" || path.length > 512 || isAbsolute(path) || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) fail("invalid_upstream_file");
  let current = root;
  for (const part of path.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) fail("invalid_upstream_file"); }
  const stat = lstatSync(current); if (!stat.isFile() || stat.size > 2097152) fail("invalid_upstream_file");
  return readFileSync(current);
}
function sourceFiles(root: string, prefix = "src"): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix + "/" + name, stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) fail("invalid_upstream_file");
    if (stat.isDirectory()) files.push(...sourceFiles(root, path));
    else if (stat.isFile() && /\.[jt]sx?$/.test(name)) files.push(path);
  }
  return files;
}

/** Offline byte/import/license conformance. Historical artifacts retain their original content seal. */
export function validateUpstream(rootPath: string, options: { historical?: boolean } = {}): UpstreamManifest | null {
  const root = realpathSync(rootPath);
  if (options.historical && !existsSync(join(root, inventory))) return null;
  const bytes = member(root, inventory), raw = JSON.parse(bytes.toString()) as UpstreamManifest;
  if (options.historical && raw.contract === "jit.upstream-provenance/v1" as string) return null;
  if (member(root, "third_party/rakazo/provenance.sha256").toString() !== hash(bytes) + "\n") fail("invalid_upstream_review_pin");
  exact(raw, ["contract", "upstream", "files", "dependencies", "lockSha256", "browserDependencies", "licenses", "assets"]);
  if (raw.contract !== "jit.upstream-provenance/v2") fail();
  exact(raw.upstream, ["repository", "commit", "tree", "archiveSha256", "notice"]);
  const upstream = raw.upstream;
  if (upstream.repository !== "https://github.com/elie222/rakazo" || !commit(upstream.commit) || !commit(upstream.tree) || !sha(upstream.archiveSha256) || upstream.notice !== null) fail();
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 64 || !Array.isArray(raw.assets) || raw.assets.length) fail();
  const destinations = new Set<string>();
  for (const file of raw.files) {
    exact(file, ["repository", "commit", "source", "sha256", "destination", "destinationSha256", "license", "modifications", "imports", "review"]);
    if (file.repository !== upstream.repository || file.commit !== upstream.commit || file.license !== "Apache-2.0" || !sha(file.sha256) || !sha(file.destinationSha256)) fail();
    text(file.modifications); text(file.review); text(file.source); text(file.destination);
    if (!/^src\/.+\.[jt]sx?$/.test(file.destination) || destinations.has(file.destination)) fail(); destinations.add(file.destination);
    if (hash(member(root, `third_party/rakazo/sources/${file.commit}/${file.source}`)) !== file.sha256) fail("invalid_upstream_source_pin");
    const destination = member(root, file.destination);
    if (hash(destination) !== file.destinationSha256) fail("invalid_upstream_destination_pin");
    const adapted = destination.toString();
    const header = adapted.slice(0, adapted.indexOf("*/") + 2);
    if (!["Adapted from Rakazo", "copyright 2026 Rakazo contributors", "Apache-2.0", file.source, file.commit, "Modified for Jit:", "third_party/rakazo/LICENSE"].every(value => header.includes(value))) fail("invalid_upstream_modified_notice");
    if (!Array.isArray(file.imports) || file.imports.length > 64 || file.imports.some(value => typeof value !== "string" || value.length > 512)) fail();
    const imports = [...new Set(new Bun.Transpiler({ loader: file.destination.endsWith("tsx") ? "tsx" : "ts" }).scanImports(adapted).map(item => item.path))].sort();
    if (JSON.stringify(imports) !== JSON.stringify(file.imports) || imports.some(path => path.startsWith("@rakazo/") || !path.startsWith(".") && !["react", "react/jsx-runtime", "react/jsx-dev-runtime"].includes(path))) fail("invalid_upstream_imports");
  }
  for (const file of sourceFiles(root)) {
    const source = member(root, file).toString();
    if (/Adapted from Rakazo|https:\/\/github\.com\/elie222\/rakazo/.test(source) && !destinations.has(file)) fail("invalid_upstream_unlisted_source");
  }
  dictionary(raw.dependencies); dictionary(raw.browserDependencies);
  const pkg = JSON.parse(member(root, "package.json").toString()) as { dependencies: unknown };
  if (!sha(raw.lockSha256) || hash(member(root, "bun.lock")) !== raw.lockSha256 || canonical(pkg.dependencies) !== canonical(raw.dependencies) || Object.keys(raw.browserDependencies).sort().join() !== "react,react-dom,scheduler") fail("invalid_upstream_dependency_review");
  if (!Array.isArray(raw.licenses) || raw.licenses.length !== requiredLicenses.length || raw.licenses.map(item => item.path).sort().join() !== requiredLicenses.join()) fail("invalid_upstream_license");
  for (const license of raw.licenses) {
    exact(license, ["path", "sha256"]);
    const bytes = member(root, license.path);
    if (!sha(license.sha256) || hash(bytes) !== license.sha256 || bytes.includes(Buffer.from("*/"))) fail("invalid_upstream_license");
  }
  const notice = member(root, "NOTICE").toString();
  if (!["Copyright 2026 Rakazo contributors", "Apache License 2.0", "React, React DOM and Scheduler"].every(value => notice.includes(value))) fail("invalid_upstream_license");
  return raw;
}

/** Validate the actual browser input graph and return the complete preserved distribution notices. */
export function browserLicenseHeader(rootPath: string, inputs: Readonly<Record<string, unknown>>): string {
  const root = realpathSync(rootPath), review = validateUpstream(root); if (!review) fail();
  for (const input of Object.keys(inputs)) {
    const path = realpathSync(resolve(input)), dependency = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (dependency) {
      const name = dependency[1]!, version = review.browserDependencies[name];
      if (!version) fail("invalid_upstream_browser_input");
      const packageRoot = path.slice(0, path.indexOf(`/node_modules/${name}/`)) + `/node_modules/${name}`;
      if ((JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version !== version) fail("invalid_upstream_browser_input");
    } else if (!relative(root, path).startsWith("src/") || !/\.[jt]sx?$/.test(path)) fail("invalid_upstream_browser_input");
  }
  if (!Object.keys(inputs).length) fail("invalid_upstream_browser_input");
  const modifications = review.files.map(file => `Adapted from ${file.repository}/blob/${file.commit}/${file.source}\nCopyright 2026 Rakazo contributors; Apache-2.0.\nModified for Jit: ${file.modifications}`).join("\n\n");
  return "/*!\n" + modifications + "\n\n" + review.licenses.map(license => member(root, license.path).toString()).join("\n\n") + "\n*/\n";
}

if (import.meta.main) {
  try { const review = validateUpstream(resolve(import.meta.dir, "../..")); console.log(JSON.stringify({ ok: true, contract: review!.contract, files: review!.files.length, licenses: review!.licenses.length })); }
  catch (error) { console.error(error instanceof Error ? error.message : "invalid_upstream_provenance"); process.exitCode = 1; }
}

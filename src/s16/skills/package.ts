import { createHash } from "node:crypto";
import { AppError } from "../../errors";
import { containsCredential } from "../../security/credentials";
import { content, exact, parseCommandJson } from "../../s15/conversation/validation";
import { skillLimits, type SkillDependency, type SkillFile, type SkillOrigin, type SkillPackage, type SkillScript, type SkillUnit, type UnsupportedSkillPart } from "./types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fail = (code = "skill_package_invalid"): never => { throw new AppError(code, 400); };
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) return fail(); return value as Record<string, unknown>; };
const text = (value: unknown, max: number): string => { content(value, max); return value as string; };
const token = (value: unknown): string => { const name = text(value, 80); if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name) || /\.\.|--/.test(name)) return fail("skill_name_invalid"); return name; };
/** Portable literal relative path, validated before hashing/storage/staging; URL and OS normalization cannot widen it. */
export function skillPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 240 || value !== value.normalize("NFC") || /[\\%:\x00-\x1f\x7f]/.test(value)) return fail("skill_path_invalid");
  const parts = value.split("/");
  if (parts.some(part => !part || [".", ".."].includes(part) || part !== part.trim())) return fail("skill_path_invalid");
  if (parts.some(part => /^(?:\.git|\.ssh|\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519|dsa)(?:\.pub)?)$/i.test(part))) return fail("skill_sensitive_file");
  return value;
}
/** Canonical provenance does not assert that an owner-uploaded folder came from a remote repository. */
export function skillOrigin(value: unknown): SkillOrigin {
  const v = object(value);
  if (v.kind === "upload") { exact(v, ["kind", "label"]); return { kind: "upload", label: text(v.label, 160) }; }
  exact(v, ["kind", "repository", "commit", "folder"]);
  if (v.kind !== "github" || typeof v.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repository) || typeof v.commit !== "string" || !/^[a-f0-9]{40}$/.test(v.commit)) return fail("skill_origin_invalid");
  return { kind: "github", repository: v.repository, commit: v.commit, folder: v.folder === "" ? "" : skillPath(v.folder) };
}
const decode = (file: SkillFile): Uint8Array => Buffer.from(file.base64, "base64");
/** Decode only actual UTF-8 resource bytes; binary resources remain inert byte files for VM transfer. */
export function skillText(file: SkillFile): string {
  let value: string; try { value = new TextDecoder("utf-8", { fatal: true }).decode(decode(file)); } catch { return fail("skill_resource_binary"); }
  if (!value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail("skill_resource_binary");
  return value;
}
const json = (file: SkillFile): Record<string, unknown> => object(parseCommandJson(skillText(file), skillLimits.metadataBytes));

function unit(file: SkillFile, unsupported: UnsupportedSkillPart[]): SkillUnit {
  const source = text(skillText(file), skillLimits.fileBytes), match = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match || Buffer.byteLength(match[1]!) > skillLimits.metadataBytes) return fail("skill_frontmatter_invalid");
  const fields = new Map<string, string>(), lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; if (!line.trim() || /^\s*#/.test(line)) continue;
    const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line); if (!field) return fail("skill_frontmatter_invalid");
    const key = field[1]!, pieces: string[] = []; let value = field[2]!;
    while (index + 1 < lines.length && /^[ \t]/.test(lines[index + 1]!)) pieces.push(lines[++index]!.replace(/^[ \t]+/, ""));
    if (fields.has(key)) return fail("skill_frontmatter_invalid");
    if (!["name", "description", "disable-model-invocation", "license"].includes(key)) { unsupported.push({ path: file.path, code: `frontmatter_${key.slice(0, 64)}_ignored` }); continue; }
    if (/^[>|][+-]?$/.test(value)) value = pieces.join(value[0] === ">" ? " " : "\n");
    else if (pieces.length || /^[&*!\[{]/.test(value)) return fail("skill_frontmatter_unsupported");
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { return fail("skill_frontmatter_invalid"); } }
    else if (value.startsWith("'")) { if (!value.endsWith("'")) return fail("skill_frontmatter_invalid"); value = value.slice(1, -1).replaceAll("''", "'"); }
    if (typeof value !== "string") return fail("skill_frontmatter_invalid"); fields.set(key, value);
  }
  const flag = fields.get("disable-model-invocation") ?? "false"; if (!["true", "false"].includes(flag)) return fail("skill_frontmatter_invalid");
  if (Buffer.byteLength(match[2]!) > skillLimits.bodyBytes) return fail("skill_body_limit");
  const body = text(match[2], skillLimits.bodyBytes);
  return { id: `unit_${hash(file.path).slice(0, 24)}`, path: file.path, name: token(fields.get("name")), description: text(fields.get("description"), 2000), body, bodyHash: hash(body), license: fields.has("license") ? text(fields.get("license"), 200) : null, userOnly: flag === "true" };
}

function dependencies(files: SkillFile[], unsupported: UnsupportedSkillPart[]): SkillDependency[] {
  const result: SkillDependency[] = [], keys = new Set<string>();
  for (const file of files.filter(file => ["mcp.json", ".mcp.json"].includes(file.path))) {
    const manifest = json(file), servers = object(manifest.mcpServers);
    for (const key of Object.keys(manifest).filter(key => !["$schema", "mcpServers"].includes(key))) unsupported.push({ path: file.path, code: `mcp_${key.slice(0, 64)}_ignored` });
    for (const [key, input] of Object.entries(servers)) {
      token(key); if (keys.has(key) || keys.size >= skillLimits.dependencies) return fail("skill_dependency_invalid"); keys.add(key);
      const server = object(input);
      if (server.type !== "streamable-http" || Object.keys(server).some(key => !["type", "url"].includes(key))) { unsupported.push({ path: `${file.path}#${key}`, code: "mcp_configuration_unsupported" }); continue; }
      let url: URL; try { url = new URL(text(server.url, 2048)); } catch { return fail("skill_dependency_invalid"); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || /\$\{|[\x00-\x20\x7f]/.test(server.url as string)) return fail("skill_dependency_invalid");
      result.push({ key, endpoint: url.href, transport: "streamable-http" });
    }
  }
  return result;
}

/** Pure bounded import: bytes are inspected as data only; this module never reads host paths or executes a package. */
export function parseSkillPackage(value: unknown): SkillPackage {
  const input = object(value); exact(input, ["origin", "files"]); const origin = skillOrigin(input.origin);
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > skillLimits.files) return fail("skill_package_limit");
  const paths = new Set<string>(); let total = 0;
  const files = input.files.map((item): SkillFile => {
    const row = object(item); exact(row, ["path", "base64"]); const path = skillPath(row.path), key = path.toLowerCase();
    if (paths.has(key)) return fail("skill_path_duplicate"); paths.add(key);
    if (typeof row.base64 !== "string" || row.base64.length > Math.ceil(skillLimits.fileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.base64)) return fail("skill_file_invalid");
    const bytes = Buffer.from(row.base64, "base64"); if (bytes.toString("base64") !== row.base64 || bytes.length > skillLimits.fileBytes || (total += bytes.length) > skillLimits.totalBytes) return fail("skill_package_limit");
    if (containsCredential(bytes.toString("utf8"))) return fail("credential_content_refused");
    return { path, base64: row.base64, sha256: hash(bytes), bytes: bytes.length };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const unsupported: UnsupportedSkillPart[] = [], manifests = files.filter(file => ["plugin.json", ".claude-plugin/plugin.json"].includes(file.path));
  if (manifests.length > 1) return fail("skill_manifest_ambiguous");
  const manifest = manifests[0] ? json(manifests[0]) : null;
  if (manifest) for (const key of Object.keys(manifest).filter(key => !["$schema", "name", "version", "description", "license", "author", "homepage", "repository", "keywords"].includes(key))) unsupported.push({ path: manifests[0]!.path, code: `plugin_${key.slice(0, 64)}_ignored` });
  const units: SkillUnit[] = [];
  for (const file of files.filter(file => file.path === "SKILL.md" || /^skills\/[^/]+\/SKILL\.md$/.test(file.path))) {
    if (units.length >= skillLimits.units) return fail("skill_package_limit");
    try { const next = unit(file, unsupported); if (units.some(prior => prior.name === next.name)) return fail("skill_name_duplicate"); units.push(next); }
    catch (error) { if (error instanceof AppError && (error.code.startsWith("skill_frontmatter") || ["invalid_text", "skill_name_invalid", "skill_body_limit"].includes(error.code))) unsupported.push({ path: file.path, code: error.code === "invalid_text" || error.code === "skill_name_invalid" ? "skill_frontmatter_invalid" : error.code }); else throw error; }
  }
  for (const file of files) {
    if (/^(?:hooks|commands|agents)\//.test(file.path) || /(?:^|\/)hooks\.json$/.test(file.path)) unsupported.push({ path: file.path, code: "automatic_hooks_unsupported" });
    if (file.path === "package.json") {
      try { const packageJson = json(file); if (packageJson.scripts) unsupported.push({ path: file.path, code: "install_hooks_refused" });
        if (packageJson.dependencies || packageJson.devDependencies) unsupported.push({ path: file.path, code: "automatic_dependencies_refused" });
      } catch { unsupported.push({ path: file.path, code: "package_installation_unsupported" }); }
    }
  }
  const scripts: SkillScript[] = files.flatMap(file => {
    if (!/^(?:scripts\/|skills\/[^/]+\/scripts\/)/.test(file.path)) return [];
    const extension = file.path.split(".").at(-1), runtime = extension === "sh" ? "bash" : extension === "py" ? "python3" : extension === "js" || extension === "mjs" ? "node" : extension === "ts" ? "bun" : null;
    if (!runtime) { unsupported.push({ path: file.path, code: "script_runtime_unsupported" }); return []; }
    return [{ path: file.path, runtime }];
  });
  const deps = dependencies(files, unsupported), first = units[0];
  if (!manifest && !first) return fail("skill_definition_missing");
  const licenseFiles = files.filter(file => /(?:^|\/)(?:LICENSE(?:\.[A-Za-z0-9_-]+)?|NOTICE(?:\.[A-Za-z0-9_-]+)?|COPYING)$/i.test(file.path)).map(file => file.path);
  if (!licenseFiles.length) unsupported.push({ path: ".", code: "license_file_missing" });
  const pin = hash(JSON.stringify({ contract: "s16-skill-pin/v1", origin, files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }));
  return { contract: "s16-skill-package/v1", pin, origin, name: token(manifest?.name ?? first?.name), description: manifest?.description === undefined ? first?.description ?? "" : text(manifest.description, 2000), version: manifest?.version === undefined ? null : text(manifest.version, 128), license: manifest?.license === undefined ? first?.license ?? null : text(manifest.license, 200), licenseFiles, files, units, scripts, dependencies: deps, unsupported };
}

import { createHash } from "node:crypto";
import { AppError } from "../../errors";
import type { SourceNetwork } from "../connections/net";
import { parseSkillPackage, skillPath } from "./package";
import { skillLimits, type SkillPackage, type SkillOrigin } from "./types";

const refuse = (code: string): never => { throw new AppError(code, 409); };
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
/** Public repository/folder source. Ref resolution is preview data; only the resulting immutable commit is pinned. */
export function githubSkillSource(value: unknown): { repository: string; ref: string | null; folder: string } {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f?#\\]/.test(value)) return refuse("skill_origin_invalid");
  const match = /^https:\/\/github\.com\/([^?#]*)$/i.exec(value); if (!match) return refuse("skill_origin_invalid");
  let parts: string[]; try { parts = match[1]!.replace(/\/$/, "").split("/").map(part => decodeURIComponent(part)); } catch { return refuse("skill_origin_invalid"); }
  if (parts.some(part => !part || [".", ".."].includes(part) || /[/%\\:\x00-\x1f\x7f]/.test(part))) return refuse("skill_origin_invalid");
  const owner = parts[0], repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !/[A-Za-z0-9]/.test(owner) || !/[A-Za-z0-9]/.test(repo)) return refuse("skill_origin_invalid");
  if (parts.length === 2) return { repository: `${owner}/${repo}`, ref: null, folder: "" };
  if (parts[2] !== "tree" || !parts[3]) return refuse("skill_origin_invalid");
  return { repository: `${owner}/${repo}`, ref: parts[3], folder: parts.length > 4 ? skillPath(parts.slice(4).join("/")) : "" };
}

/**
 * Bounded data-only GitHub import: unauthenticated API reads, immutable commit/tree/blob verification and no
 * redirects/archive extraction/local git/npm execution. `guard` reacquires the owner after every awaited read.
 */
export async function importGithubSkill(value: unknown, options: { network: SourceNetwork; guard(): void; signal?: AbortSignal; now?: () => number; resolved?(origin: Extract<SkillOrigin, { kind: "github" }>): void }): Promise<SkillPackage> {
  const source = githubSkillSource(value), now = options.now ?? Date.now, end = now() + skillLimits.importMs, controller = new AbortController();
  let count = 0;
  const cancel = () => controller.abort(); if (options.signal?.aborted) cancel(); else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, skillLimits.importMs);
  async function read(path: string, maxBytes: number, missing = false): Promise<Record<string, unknown> | null> {
    options.guard(); if (controller.signal.aborted || now() >= end) return refuse("skill_import_timeout");
    if (++count > skillLimits.importRequests) return refuse("skill_package_limit");
    const response = await options.network.request(`https://api.github.com/repos/${source.repository}${path ? `/${path}` : ""}`, { method: "GET", headers: { Accept: "application/vnd.github+json", "User-Agent": "Jit-skill-import/1" }, timeoutMs: Math.min(15000, end - now()), maxBytes, signal: controller.signal });
    options.guard(); if (controller.signal.aborted || now() >= end) return refuse("skill_import_timeout");
    if (missing && response.status === 404) return null;
    if (response.status !== 200) return refuse("skill_source_unavailable");
    let data: unknown; try { data = JSON.parse(response.text); } catch { return refuse("skill_source_invalid"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return refuse("skill_source_invalid");
    return data as Record<string, unknown>;
  }
  try {
    const repository = await read("", 65536);
    if (repository?.private !== false || typeof repository.default_branch !== "string" || !repository.default_branch) return refuse("skill_public_repository_required");
    const ref = source.ref ?? repository.default_branch; let commit = ref.toLowerCase();
    if (!sha(commit)) {
      let object = (await read(`git/ref/heads/${encodeURIComponent(ref)}`, 8192, true))?.object as Record<string, unknown> | undefined;
      if (!object) object = (await read(`git/ref/tags/${encodeURIComponent(ref)}`, 8192, true))?.object as Record<string, unknown> | undefined;
      for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
        if (!sha(object.sha)) return refuse("skill_source_invalid");
        object = (await read(`git/tags/${object.sha}`, 16384))?.object as Record<string, unknown> | undefined;
      }
      if (object?.type !== "commit" || !sha(object.sha)) return refuse("skill_ref_unavailable"); commit = object.sha;
    }
    const committed = await read(`git/commits/${commit}`, 65536), treeId = (committed?.tree as Record<string, unknown> | undefined)?.sha;
    if (committed?.sha !== commit || !sha(treeId)) return refuse("skill_source_invalid");
    options.resolved?.({ kind: "github", repository: source.repository, commit, folder: source.folder });
    const tree = await read(`git/trees/${treeId}?recursive=1`, 2 * 1024 * 1024);
    if (tree?.truncated !== false || tree.sha !== treeId || !Array.isArray(tree.tree)) return refuse("skill_tree_incomplete");
    const selected: { path: string; original: string; sha: string; size: number }[] = []; let total = 0;
    const prefix = source.folder ? `${source.folder}/` : "";
    for (const item of tree.tree) {
      if (!item || typeof item !== "object") return refuse("skill_source_invalid");
      const row = item as Record<string, unknown>; if (typeof row.path !== "string") return refuse("skill_source_invalid");
      const inside = row.path.startsWith(prefix), rootLicense = !!prefix && /^(?:LICENSE(?:\.[A-Za-z0-9_-]+)?|NOTICE(?:\.[A-Za-z0-9_-]+)?|COPYING)$/i.test(row.path);
      if (!inside && !rootLicense) continue;
      if (row.type === "tree" && row.mode === "040000") continue;
      if (row.type !== "blob" || !["100644", "100755"].includes(String(row.mode))) return refuse("skill_special_file_refused");
      const path = skillPath(inside ? row.path.slice(prefix.length) : `repository-licenses/${row.path}`);
      if (!sha(row.sha) || !Number.isSafeInteger(row.size) || (row.size as number) < 0 || (row.size as number) > skillLimits.fileBytes || (total += row.size as number) > skillLimits.totalBytes || selected.length >= skillLimits.files) return refuse("skill_package_limit");
      selected.push({ path, original: row.path, sha: row.sha, size: row.size as number });
    }
    if (!selected.length) return refuse("skill_definition_missing");
    const files: { path: string; base64: string }[] = [];
    for (const entry of selected) {
      const blob = await read(`git/blobs/${entry.sha}`, skillLimits.fileBytes * 2 + 8192);
      if (blob?.sha !== entry.sha || blob.encoding !== "base64" || blob.size !== entry.size || typeof blob.content !== "string") return refuse("skill_blob_invalid");
      const base64 = blob.content.replace(/[\r\n]/g, ""), bytes = Buffer.from(base64, "base64");
      const digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (bytes.length !== entry.size || bytes.toString("base64") !== base64 || digest !== entry.sha) return refuse("skill_blob_invalid");
      files.push({ path: entry.path, base64 });
    }
    options.guard(); return parseSkillPackage({ origin: { kind: "github", repository: source.repository, commit, folder: source.folder }, files });
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
}

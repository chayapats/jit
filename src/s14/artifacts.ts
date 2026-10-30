import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionBackend, ToolDefinition } from "schway/host";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import { type S14Application } from "./application";
import type { Attempt } from "./authority-types";
import type { SnapshotTarget } from "./sharing-types";
import type { MemoryRef, MemorySource } from "./memory-types";
import { record } from "./application";
import type { Artifact, ArtifactRequest, StagedArtifact } from "./report-types";
import type { OwnerActor } from "./types";
import { canonical, exact, identity, integer } from "./validation";

const id = () => crypto.randomUUID().replaceAll("-", "");
const types = new Map<string, string>([["text/markdown", ".md"], ["text/plain", ".txt"], ["application/json", ".json"]]);
/** Hashes exact immutable output bytes, without involving a path or model-provided digest implementation. */
export const artifactHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Validates bounded credential-free text/JSON output; active media is never an app-origin artifact. */
export function validateArtifact(bytes: Uint8Array, request: Omit<ArtifactRequest, "path">, maximum: number): void {
  if (containsCredential(request.name) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(request.name) || !types.has(request.mediaType) || !request.name.endsWith(types.get(request.mediaType)!)) throw new AppError("artifact_type_refused", 403);
  integer(request.size, 1, maximum);
  if (bytes.length !== request.size || !/^[a-f0-9]{64}$/.test(request.sha256) || artifactHash(bytes) !== request.sha256) throw new AppError("artifact_integrity_mismatch", 409);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AppError("artifact_encoding_refused"); }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(content) || containsCredential(content)) throw new AppError("artifact_content_refused", 403);
  if (request.mediaType === "application/json") {
    try { JSON.parse(content); } catch { throw new AppError("artifact_json_refused"); }
  }
}

/** Service-owned snapshot and opaque download gateway; a workspace file alone is never published output. */
export class S14Artifacts {
  constructor(readonly app: S14Application) {}

  /** Snapshots an exact file through the producing attempt's isolated backend and live computer authority. */
  async stageWorkspace(attemptId: string, backend: ExecutionBackend, request: ArtifactRequest, signal?: AbortSignal): Promise<StagedArtifact> {
    exact(request, ["path", "name", "mediaType", "size", "sha256"]);
    if (typeof request.path !== "string" || !request.path || request.path.length > 512 || request.path.includes("\\") || request.path.includes("%") ||
        request.path.split("/").some(part => !part || part === "." || part === ".." || !/^[a-zA-Z0-9._-]+$/.test(part))) throw new AppError("artifact_path_refused", 403);
    const check = () => {
      if (signal?.aborted) throw new AppError("artifact_cancelled", 409);
      return this.app.store.read(tx => this.app.authority.assertTool(tx, attemptId, "computer"));
    };
    const attempt = check();
    integer(request.size, 1, Math.min(1048576, attempt.snapshot.outputBytes));
    const root = backend.workspaceRoot, path = posix.join(root, request.path);
    if (root !== "/workspace" || !path.startsWith(`${root}/`)) throw new AppError("artifact_path_refused", 403);
    // Each own entry must be regular; equal realpaths also reject parent/final links.
    const parts = request.path.split("/");
    let parent = root;
    for (const part of parts) {
      check();
      const entries = await backend.list(parent, signal ? { signal } : {});
      const entry = entries.find(e => e.name === part);
      if (!entry || entry.type === "symlink") throw new AppError("artifact_symlink_refused", 403);
      parent = posix.join(parent, part);
      if (await backend.realpath(parent) !== parent) throw new AppError("artifact_symlink_refused", 403);
    }
    if ((await backend.stat(path)).type !== "file") throw new AppError("artifact_type_refused", 403);
    check();
    // The supported runner observation verifies unchanged entry/content before returning snapshot bytes.
    const snapshot = await backend.observeFile(path, { content: true, ...(signal ? { signal } : {}) });
    check();
    if (!snapshot?.targetExists || !snapshot.bytes || await backend.realpath(path) !== path) throw new AppError("artifact_snapshot_changed", 409);
    validateArtifact(snapshot.bytes, request, Math.min(1048576, attempt.snapshot.outputBytes));
    return this.app.store.transaction(tx => {
      const current = this.app.authority.assertTool(tx, attemptId, "computer");
      return this.stage(tx, current, request, snapshot.bytes!);
    });
  }

  /** Stages bounded bytes under a captured attempt; only trusted publication can expose their opaque identity. */
  stage(tx: AppTransaction, attempt: Attempt, request: Omit<ArtifactRequest, "path">, bytes: Uint8Array): StagedArtifact {
    this.app.authority.guard(tx, attempt.id);
    validateArtifact(bytes, request, Math.min(1048576, attempt.snapshot.outputBytes));
    const usage = tx.get<{ n: number; bytes: number }>("SELECT count(*) n,coalesce(sum(length(content)),0) bytes FROM artifact_staging WHERE attempt_id=?", attempt.id)!;
    if (usage.n >= 4 || usage.bytes + bytes.length > attempt.snapshot.outputBytes) throw new AppError("artifact_budget_exhausted", 409);
    const packet = this.app.memory.attemptPacket(tx, attempt.id), key = id();
    const source = this.app.memory.source(tx, { id: key, botId: attempt.snapshot.bot.id, conversationId: packet.conversationId,
      attribution: "bot", text: `Staged artifact ${key}; sha256 ${request.sha256}`, ...this.app.memory.derive(tx, packet) });
    const artifact: StagedArtifact = { id: key, workId: attempt.workId, attemptId: attempt.id, name: request.name, mediaType: request.mediaType,
      size: bytes.length, sha256: request.sha256, source: { id: source.id, revision: 1, generation: 1 }, createdAt: this.app.now() };
    tx.run("INSERT INTO artifact_staging VALUES (?,?,?,?)", key, attempt.id, canonical(artifact), bytes);
    return artifact;
  }

  /** Adds only the bounded local export tool to a currently granted computer backend. */
  definition(attempt: Attempt, backend: ExecutionBackend): ToolDefinition {
    return { name: "artifact_export", description: "Stage one exact Markdown/text/JSON file from your own workspace. Supply exact byte size and SHA-256. Staging alone does not publish or finish work.",
      effect: "read-only", execution: "exclusive", inputSchema: { type: "object", properties: {
        path: { type: "string" }, name: { type: "string" }, mediaType: { enum: [...types.keys()] }, size: { type: "integer" }, sha256: { type: "string" },
      }, required: ["path", "name", "mediaType", "size", "sha256"], additionalProperties: false },
      execute: async (input, context) => {
        const artifact = await this.stageWorkspace(attempt.id, backend, input as ArtifactRequest, context.signal);
        return { content: canonical(artifact) };
      } };
  }

  /** Returns exact authorized immutable bytes with independent hash/type/size and lineage validation. */
  download(actor: OwnerActor, artifactId: string): { artifact: Artifact; bytes: Uint8Array } {
    if (!/^[a-f0-9]{32}$/.test(artifactId)) throw new AppError("not_found", 404);
    return this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor);
      this.app.reports.reconcile(tx);
      const row = tx.get<{ record_json: string; content: Uint8Array | null }>("SELECT record_json,content FROM artifacts WHERE id=?", artifactId);
      if (!row?.content) throw new AppError("artifact_unavailable", 404);
      const artifact = JSON.parse(row.record_json) as Artifact;
      const report = this.app.reports.read(tx, artifact.reportId);
      if (report.state !== "available") throw new AppError("artifact_unavailable", 404);
      validateArtifact(row.content, artifact, 1048576);
      return { artifact, bytes: new Uint8Array(row.content) };
    });
  }

  /** Copies one exact live source or delivered artifact through the common bounded integrity gateway. */
  snapshot(tx: AppTransaction, target: SnapshotTarget): { ownerBotId: string; source: MemoryRef; name: string; mediaType: Artifact["mediaType"]; size: number; sha256: string; bytes: Uint8Array } {
    let bytes: Uint8Array, name: string, mediaType: Artifact["mediaType"], source: MemoryRef;
    if (target.kind === "artifact") {
      this.app.reports.reconcile(tx);
      const row = tx.get<{ record_json: string; content: Uint8Array | null }>("SELECT record_json,content FROM artifacts WHERE id=?", target.id);
      if (!row?.content || target.revision !== 1 || target.generation !== 1) throw new AppError("snapshot_unavailable", 403);
      const artifact = JSON.parse(row.record_json) as Artifact;
      if (this.app.reports.read(tx, artifact.reportId).state !== "available") throw new AppError("snapshot_unavailable", 403);
      validateArtifact(row.content, artifact, 32768);
      bytes = new Uint8Array(row.content); name = artifact.name; mediaType = artifact.mediaType; source = artifact.source;
    } else if (target.kind === "source") {
      const original = record<MemorySource>(tx, "memory_sources", target.id);
      if (!this.app.memory.sourceCurrent(tx, target)) throw new AppError("snapshot_unavailable", 403);
      bytes = new TextEncoder().encode(original.text!); name = "source.txt"; mediaType = "text/plain";
      source = { id: original.id, revision: original.revision, generation: original.generation };
    } else throw new AppError("snapshot_type_refused", 403);
    // Owner sharing is nontransitive: a received or derived shared copy cannot be forwarded as a new source.
    const pending = [source], seen = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      const item = record<MemorySource>(tx, "memory_sources", next.id);
      if (item.snapshotShare || item.access?.some(pin => pin.shareId !== null)) throw new AppError("snapshot_forward_refused", 403);
      pending.push(...item.derived);
    }
    const metadata = { name, mediaType, size: bytes.length, sha256: artifactHash(bytes) };
    validateArtifact(bytes, metadata, 32768);
    return { ...metadata, bytes, source, ownerBotId: record<MemorySource>(tx, "memory_sources", source.id).botId };
  }

  /** Purges unreachable private staging after settlement; it never deletes a delivered artifact. */
  discard(tx: AppTransaction, attemptId: string): void { identity(attemptId); tx.run("DELETE FROM artifact_staging WHERE attempt_id=?", attemptId); }
}

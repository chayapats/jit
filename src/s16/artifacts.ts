import { AppError } from "../errors";
import type { ConversationApplication } from "../s15/conversation";
import type { ClientArtifactDetail, ClientArtifactItem, ClientArtifactList, ClientArtifactQuery } from "./client/contracts";
import type { FileStore } from "./files/store";
import type { FileArtifactLineage, FileUpload } from "./files/types";

/** Fixed page size. A cursor only names the last returned position, never a cached result set. */
export const artifactPageSize = 50;
/** Detail returns at most this many family members: the viewed file, all its ancestors, then the newest others. */
export const artifactFamilyLimit = 256;
const types = { all: null, text: "text/plain", markdown: "text/markdown", csv: "text/csv", html: "text/html" } as const;
interface Committed { entry: FileArtifactLineage; label: string }

/** Exact bounded query; unknown keys, repeated keys and malformed cursors refuse instead of widening. */
export function parseArtifactQuery(params: URLSearchParams): ClientArtifactQuery {
  const allowed = ["q", "type", "conversation", "before"];
  if ([...params.keys()].some(key => !allowed.includes(key)) || allowed.some(key => params.getAll(key).length > 1)) throw new AppError("invalid_query");
  const q = params.get("q") ?? "", type = params.get("type") ?? "all", conversation = params.get("conversation"), before = params.get("before");
  if (q.length > 128 || !q.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(q)) throw new AppError("invalid_query");
  if (!(type in types)) throw new AppError("invalid_query");
  if (conversation !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(conversation)) throw new AppError("invalid_query");
  if (before !== null && !/^(?:0|[1-9]\d{0,15})\.[A-Za-z0-9_-]{1,128}$/.test(before)) throw new AppError("cursor_invalid", 409);
  return { q, type: type as ClientArtifactQuery["type"], conversation, before };
}

/**
 * The current library: staged artifacts whose CHAT request is completed and committed this exact reference,
 * whose producer still passes CHAT's publication guard, and whose every transitive source is current. This
 * is recomputed on every read, so a withdrawn or no-longer-published artifact disappears from all pages.
 */
function committed<Actor, Work>(app: ConversationApplication<Actor, Work>, files: FileStore<Actor>, actor: Actor): { items: Committed[]; revisions: Map<string, number> } {
  const lineage = files.lineage(actor), views = new Map<string, ReturnType<ConversationApplication<Actor, Work>["view"]> | null>();
  const items = lineage.flatMap(entry => {
    if (!entry.current) return [];
    const { artifact } = entry;
    let row = views.get(artifact.requestId);
    if (row === undefined) { try { row = app.view(actor, artifact.requestId); } catch { row = null; } views.set(artifact.requestId, row); }
    if (!row || row.state !== "completed" || row.result === null || row.authority?.id !== artifact.workId || row.receipt.rootRequestId !== artifact.requestId || row.receipt.conversationId !== artifact.conversationId) return [];
    if (!row.artifacts?.some(item => item.id === artifact.id && item.sha256 === artifact.sha256)) return [];
    return [{ entry, label: Array.from(row.command.text.replace(/\s+/g, " ").trim()).slice(0, 120).join("") }];
  });
  // Revision depth over the whole staged lineage; only committed rows are ever projected.
  const byId = new Map(lineage.map(entry => [entry.artifact.id, entry])), revisions = new Map<string, number>();
  const revision = (id: string, depth = 0): number => {
    const known = revisions.get(id); if (known !== undefined) return known;
    const entry = byId.get(id); if (!entry || depth > 64) return 1;
    const value = 1 + Math.max(0, ...entry.parents.map(parent => revision(parent.id, depth + 1)));
    revisions.set(id, value); return value;
  };
  for (const item of items) revision(item.entry.artifact.id);
  return { items, revisions };
}
function project(item: Committed, revisions: Map<string, number>): ClientArtifactItem {
  const { artifact, parents, inputs } = item.entry;
  return { artifact: structuredClone(artifact), conversationId: artifact.conversationId, label: item.label, revision: revisions.get(artifact.id) ?? 1, parent: parents[0]?.id ?? null, inputs: inputs.length };
}

/** One bounded page of the current library, newest first, filtered before the cursor is applied. */
export function listArtifacts<Actor, Work>(app: ConversationApplication<Actor, Work>, files: FileStore<Actor>, actor: Actor, query: ClientArtifactQuery): ClientArtifactList {
  const { items, revisions } = committed(app, files, actor), needle = query.q.toLocaleLowerCase(), mime = types[query.type];
  const [cursorAt, cursorId] = query.before ? [Number(query.before.slice(0, query.before.indexOf("."))), query.before.slice(query.before.indexOf(".") + 1)] : [null, null];
  const matching = items.filter(({ entry: { artifact } }) => (!mime || artifact.mime === mime) && (!query.conversation || artifact.conversationId === query.conversation) && (!needle || artifact.name.toLocaleLowerCase().includes(needle)))
    .filter(({ entry: { artifact } }) => cursorAt === null || artifact.createdAt < cursorAt || artifact.createdAt === cursorAt && artifact.id < cursorId!);
  const page = matching.slice(0, artifactPageSize), last = page.at(-1)?.entry.artifact;
  return { contract: "s16-client-artifacts/v1", query, limit: artifactPageSize, items: page.map(item => project(item, revisions)), next: matching.length > artifactPageSize && last ? `${last.createdAt}.${last.id}` : null };
}

/** Current detail with exact source receipts and the committed revision family (oldest first). */
export function artifactDetail<Actor, Work>(app: ConversationApplication<Actor, Work>, files: FileStore<Actor>, actor: Actor, id: string): ClientArtifactDetail {
  const { items, revisions } = committed(app, files, actor), item = items.find(entry => entry.entry.artifact.id === id);
  if (!item) throw new AppError("artifact_unavailable", 409);
  const family = new Set([id]), parentsOf = (entryId: string) => items.find(entry => entry.entry.artifact.id === entryId)?.entry.parents ?? [];
  for (const queue = [id]; queue.length;) for (const parent of parentsOf(queue.shift()!)) if (!family.has(parent.id)) { family.add(parent.id); queue.push(parent.id); }
  for (let grew = true; grew;) { grew = false; for (const entry of items) if (!family.has(entry.entry.artifact.id) && entry.entry.parents.some(parent => family.has(parent.id))) { family.add(entry.entry.artifact.id); grew = true; } }
  const inputs = item.entry.inputs.map(ref => {
    const upload: FileUpload = files.status(actor, ref.id);
    if (upload.state !== "ready" || !upload.receipt || upload.receipt.sha256 !== ref.sha256) throw new AppError("artifact_unavailable", 409);
    return { id: ref.id, name: upload.receipt.name, mime: upload.receipt.mime, bytes: upload.receipt.bytes, sha256: ref.sha256, origin: files.origin(actor, ref.id)?.id ?? null };
  });
  const ancestors = new Set([id]);
  for (const queue = [id]; queue.length;) for (const parent of parentsOf(queue.shift()!)) if (!ancestors.has(parent.id)) { ancestors.add(parent.id); queue.push(parent.id); }
  const members = items.filter(entry => family.has(entry.entry.artifact.id));
  // Ancestors are at most the 32-level chain; siblings are unbounded, so keep the newest within the limit.
  const kept = [...members.filter(entry => ancestors.has(entry.entry.artifact.id)), ...members.filter(entry => !ancestors.has(entry.entry.artifact.id))].slice(0, artifactFamilyLimit);
  const revisionsList = kept.map(entry => project(entry, revisions))
    .sort((a, b) => a.revision - b.revision || a.artifact.createdAt - b.artifact.createdAt || (a.artifact.id < b.artifact.id ? -1 : 1));
  return { contract: "s16-client-artifact/v1", item: project(item, revisions), inputs, revisions: revisionsList, familyTotal: members.length, preview: item.entry.artifact.mime === "text/html" ? "sandboxed_html" : "escaped_text" };
}

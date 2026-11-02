import { AppError } from "../../errors";
import { canonical, content, exact, identity, integer } from "../conversation/validation";
import type { DataScope, Ref, SourceOrigin, TeamResource } from "./types";
export { canonical, content, exact, identity, integer };
/** Closed current privacy label; empty/wildcard Bot identities have no meaning. */
export function scope(value: unknown): asserts value is DataScope {
  if (value && typeof value === "object" && "kind" in value && value.kind === "team") { exact(value, ["kind"]); return; }
  exact(value, ["kind", "botId", "origin"]);
  if (value.kind !== "bot" || !["s14", "s15"].includes(value.origin as string)) throw new AppError("invalid_scope");
  identity(value.botId);
}
/** Finite exact unique IDs. Null is handled separately by each owning field. */
export function ids(value: unknown, max = 64): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) throw new AppError("invalid_shape");
  value.forEach(identity);
}
/** Closed references use the same revision/generation contract as POLICY. */
export function reference(value: unknown): asserts value is Ref {
  exact(value, ["id", "revision", "generation"]); identity(value.id); integer(value.revision, 1); integer(value.generation, 1);
}
/** Owner metadata contains no reusable account material, arbitrary paths, endpoints or secret slots. */
export function resource(value: unknown): asserts value is TeamResource {
  canonical(value); exact(value, ["contract", "id", "revision", "generation", "label", "kind", "scope", "purposes", "allowedBots", "deniedBots", "operations", "active", "coordinationKey"]);
  if (value.contract !== "s15-team-resource/v1" || !["account", "browser", "workspace", "data"].includes(value.kind as string) || typeof value.active !== "boolean") throw new AppError("invalid_resource");
  identity(value.id); integer(value.revision, 1); integer(value.generation, 1); content(value.label, 256); identity(value.coordinationKey); scope(value.scope); ids(value.purposes);
  if (value.allowedBots !== null) ids(value.allowedBots); ids(value.deniedBots);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 3 || new Set(value.operations).size !== value.operations.length || value.operations.some(op => !["read", "write", "input"].includes(op))) throw new AppError("invalid_resource");
}
/** Provenance fields are supplied by trusted owner/work ingress, never inferred from a quotation. */
export function origin(value: unknown): asserts value is SourceOrigin {
  exact(value, ["kind", "id", "conversationId", "at"]);
  if (!["owner_message", "work", "historical"].includes(value.kind as string)) throw new AppError("invalid_source");
  identity(value.id); if (value.conversationId !== null) identity(value.conversationId); integer(value.at, 0, Number.MAX_SAFE_INTEGER);
}
/** Private checks happen before relevance/content. A descendant can never erase an ancestor's label. */
export function inScope(value: DataScope, botId: string): boolean { return value.kind === "team" || value.botId === botId; }

import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

/** Stable vault metadata labels used to locate reusable vendor keys; display text belongs to the dictionaries. */
export const webSearchKeyLabels = Object.freeze({ tavily: "Tavily", exa: "Exa" });

/** Revisioned project switch; revision zero means the default, enabled. */
export interface WebSettings { enabled: boolean; revision: number }
/** Installation provider metadata only; a credential is always a connection reference. */
export interface WebProviderSetting { id: string | null; connectionId: string | null; revision: number }
/** Web-only owner commands, with receipt identity and optimistic revision checks. */
export type WebCommand = { kind: "web.settings.set"; requestId: string; projectId: string; expectedRevision: number; payload: { enabled: boolean } }
  | { kind: "web.provider.set"; requestId: string; projectId: null; expectedRevision: number; payload: { id: string | null; connectionId: string | null } };
/** Receipt contains the committed setting, never a credential. */
export type WebReceipt = { web: WebSettings } | { provider: WebProviderSetting };
/** Reads the latest project switch; no row means on. */
export function readWebSettings(tx: AppTransaction, projectId: string): WebSettings {
  const row = tx.get<{ enabled: number; revision: number }>("SELECT enabled, revision FROM web_settings WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
  return { enabled: row ? row.enabled === 1 : true, revision: row?.revision ?? 0 };
}
/** Reads the installation's selected provider; no row (or legacy null) means managed Built-in search. */
export function readWebProvider(tx: AppTransaction): WebProviderSetting {
  const row = tx.get<WebProviderSetting>("SELECT provider_id AS id, connection_id AS connectionId, revision FROM web_provider ORDER BY revision DESC LIMIT 1");
  return row ? { ...row, id: row.id ?? "searxng" } : { id: "searxng", connectionId: null, revision: 0 };
}
/** Recognizes only the two owner configuration commands. */
export function isWebCommand(value: { kind?: unknown }): value is WebCommand { return value.kind === "web.settings.set" || value.kind === "web.provider.set"; }
/** Validates exact command fields before computing a credential-free receipt identity. */
export function webCommandIdentity(command: WebCommand): string {
  const exact = (v: unknown, keys: string) => !!v && typeof v === "object" && Object.keys(v).sort().join(",") === keys;
  if (!exact(command, "expectedRevision,kind,payload,projectId,requestId") || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw new AppError("invalid_web_command");
  if (command.kind === "web.settings.set") {
    requireId(command.projectId);
    if (!exact(command.payload, "enabled") || typeof command.payload.enabled !== "boolean") throw new AppError("invalid_web_command");
  } else {
    const p = command.payload;
    if (command.projectId !== null || !exact(p, "connectionId,id") || !(p.id === null || (typeof p.id === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(p.id))) || (p.id === null && p.connectionId !== null)) throw new AppError("invalid_web_command");
    if (p.connectionId !== null) requireId(p.connectionId);
  }
  return JSON.stringify(command);
}
/** Applies one Web owner command inside its receipt transaction; no model-facing writer exists. */
export function writeWebCommand(tx: AppTransaction, command: WebCommand, channel: string, now: number): WebReceipt {
  if (channel !== "web") throw new AppError("web_settings_requires_web", 403);
  if (command.kind === "web.settings.set") {
    if (readWebSettings(tx, command.projectId).revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    tx.run("INSERT INTO web_settings VALUES (?, ?, ?, ?)", command.projectId, command.expectedRevision + 1, Number(command.payload.enabled), now);
    return { web: readWebSettings(tx, command.projectId) };
  }
  if (readWebProvider(tx).revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const keyed = command.payload.id === "tavily" || command.payload.id === "exa";
  if ((command.payload.id === "searxng" && command.payload.connectionId !== null) || (keyed && command.payload.connectionId === null)) throw new AppError("web_search_key_missing", 409);
  if (command.payload.connectionId !== null) {
    const row = tx.get<{ kind: string; removed: number | null; secret: string }>("SELECT kind, removed_at AS removed, secret_state AS secret FROM connections WHERE id = ?", command.payload.connectionId);
    if (!row || row.removed !== null || row.kind !== "web_search_key" || (keyed && row.secret !== "set")) throw new AppError("web_search_key_missing", 409);
  }
  tx.run("INSERT INTO web_provider VALUES (?, ?, ?, ?)", command.expectedRevision + 1, command.payload.id, command.payload.connectionId, now);
  return { provider: readWebProvider(tx) };
}

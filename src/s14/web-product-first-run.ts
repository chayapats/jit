import { AppError } from "../errors";
import type { S14Application, S14Command } from "./application";
import type { OwnerActor, Route } from "./types";
import { defaultWorkLimits, type S14Draft } from "./web-product";

/** One provider as the owner sees it: readiness is local protected-store state and never proves a working subscription. */
export type S14Provider = Awaited<ReturnType<S14Application["signIns"]["providers"]>>[number];
/** Setup's provider step. `selected` is a provider the owner chose that is signed in; null asks. */
export interface S14SetupProviders { items: S14Provider[]; selected: Route["id"] | null; choosing: boolean }
/** Signed-in provider page; it can renew a sign-in and never changes which route a Bot uses. */
export interface S14ProviderSettings { kind: "settings-provider"; providers: S14Provider[] }
/** First-run surfaces added to the product view union. */
export type S14FirstRunSurface = S14ProviderSettings;

const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
/** Only credentials present locally can continue. Unknown states keep the sign-in step, so setup cannot finish with a route that cannot answer. */
export const signedIn = (provider: S14Provider) => provider.readiness === "configured-unverified";

/** Reads readiness for setup. `?provider=` only chooses among signed-in providers and `?change` returns to the list. */
export async function setupProviders(app: S14Application, actor: OwnerActor, url: URL | null, chosen = ""): Promise<S14SetupProviders> {
  const items = await app.signIns.providers(actor), wanted = url?.searchParams.get("provider") ?? "";
  const ready = items.filter(signedIn), match = ready.find(item => item.provider === wanted || item.id === wanted || item.id === chosen);
  return { items, selected: match?.id ?? (ready.length === 1 ? ready[0]!.id : null), choosing: !ready.length || url?.searchParams.has("change") === true };
}
/** Provider settings query; a stalled store read stays bounded by the host's five-second limit. */
export async function providerView(app: S14Application, actor: OwnerActor): Promise<S14ProviderSettings> {
  return { kind: "settings-provider", providers: await app.signIns.providers(actor) };
}
/** Prefills the composer for a fresh start from finished work. It fills text only, so nothing starts until the owner sends. */
export function redoDraft(app: S14Application, actor: OwnerActor, conversationId: string, workId: string | null): S14Draft | null {
  if (!workId || !/^[a-zA-Z0-9_-]{1,128}$/.test(workId)) return null;
  const work = app.authority.list(actor).find(item => item.id === workId && item.conversationId === conversationId);
  return work ? { ...defaultWorkLimits, text: work.purpose, work: true, completion: work.completionRule, bots: [] } : null;
}
const allow = (fields: Record<string, unknown>, keys: string[]) => { for (const key of Object.keys(fields)) if (!["csrf", "requestId", "expectedRevision", ...keys].includes(key)) throw new AppError("invalid_body"); };
/** Translates the preference and new-chat forms into typed commands; it decides nothing and refuses unknown fields. */
export function firstRunCommand(form: string, fields: Record<string, unknown>): S14Command | null {
  const requestId = single(fields, "requestId"), expectedRevision = Number(single(fields, "expectedRevision"));
  if (form === "new-chat") { allow(fields, ["botId"]); return { kind: "conversation.create", requestId, expectedRevision, payload: { botId: single(fields, "botId") } }; }
  if (form !== "preferences") return null;
  allow(fields, ["language", "theme"]);
  return { kind: "owner.preferences.set", requestId, expectedRevision, payload: { language: single(fields, "language") as "th" | "en", theme: single(fields, "theme") as "system" | "light" | "dark" } };
}
/** Where a refused preference, conversation or sign-in post leads; null leaves it to the core product. */
export function firstRunNext(form: string | null, value: unknown): string | null {
  if (form === "preferences") return "/more";
  if (form === "new-chat") return `/team/${single((value ?? {}) as Record<string, unknown>, "botId")}`;
  return null;
}

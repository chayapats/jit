import { AppError } from "../errors";
import { lexicalScore, lexicalTerms } from "../memory/lexical";
import type { MemoryClaimView, MemoryOwnerIndex } from "../s15/memory/types";
import type { ClientMemoryDetail, ClientMemoryItem, ClientMemoryList, ClientMemoryQuery, ClientMemoryState } from "./client/contracts";

/** Existing MEM owner authority consumed by the S16 client adapter. No second memory store or command path. */
export interface S16MemoryPort<Actor> { ownerIndex(actor: Actor): MemoryOwnerIndex; command(actor: Actor, input: unknown): unknown }

const pageSize = 50, snippetLength = 280;
const kinds = ["all", "fact", "inference"] as const, categories = ["all", "fact", "preference", "working_knowledge"] as const, states = ["active", "inactive", "all"] as const;
const one = (params: URLSearchParams, key: string) => { const values = params.getAll(key); if (values.length > 1) throw new AppError("invalid_memory_query"); return values[0] ?? null; };
const choice = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => { if (value === null) return fallback; if (!(allowed as readonly string[]).includes(value)) throw new AppError("invalid_memory_query"); return value as T; };
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/gu, " ").trim();

/** Strict query grammar: known keys only, each at most once; unknown filters refuse rather than widen. */
export function parseMemoryQuery(params: URLSearchParams): ClientMemoryQuery {
  for (const key of params.keys()) if (!["q", "kind", "category", "state", "bot", "offset"].includes(key)) throw new AppError("invalid_memory_query");
  const q = one(params, "q") ?? "", bot = one(params, "bot"), offset = one(params, "offset") ?? "0";
  if (q.length > 256 || /[\u0000-\u001f\u007f]/u.test(q)) throw new AppError("invalid_memory_query");
  if (bot !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(bot)) throw new AppError("invalid_memory_query");
  if (!/^(?:0|[1-9]\d{0,5})$/.test(offset)) throw new AppError("invalid_memory_query");
  return { q, kind: choice(one(params, "kind"), kinds, "all"), category: choice(one(params, "category"), categories, "all"), state: choice(one(params, "state"), states, "active"), bot, offset: Number(offset) };
}

const stateOf = (claim: MemoryClaimView): ClientMemoryState => claim.lifecycle !== "active" ? claim.lifecycle : claim.sourceState === "withdrawn" ? "withdrawn" : "active";
/**
 * A Bot may retrieve a claim only when its own and every transitive dependency's scope admits that Bot.
 * `path` detects real cycles; `memo` lets shared ancestors (diamonds) be checked once without being
 * mistaken for a cycle.
 */
function visibleTo(byId: Map<string, MemoryClaimView>, claim: MemoryClaimView, botId: string, memo: Map<string, boolean>, path = new Set<string>()): boolean {
  const known = memo.get(claim.id); if (known !== undefined) return known;
  if (path.has(claim.id)) return false; path.add(claim.id);
  try {
    const scope = claim.provenance.scope;
    const allowed = (scope.kind !== "bot" || scope.botId === botId) && claim.dependencies.every(parent => { const value = byId.get(parent); return !!value && visibleTo(byId, value, botId, memo, path); });
    memo.set(claim.id, allowed); return allowed;
  } finally { path.delete(claim.id); }
}
function item(index: MemoryOwnerIndex, claim: MemoryClaimView): ClientMemoryItem {
  const state = stateOf(claim), text = state === "active" ? claim.text : "", chars = Array.from(text), scope = claim.provenance.scope;
  return { id: claim.id, revision: claim.revision, kind: claim.kind, category: claim.category, confirmation: claim.confirmation, state,
    snippet: chars.length > snippetLength ? chars.slice(0, snippetLength - 1).join("") + "…" : text,
    scope: scope.kind === "team" ? { kind: "team" } : { kind: "bot", botId: scope.botId },
    source: { kind: claim.provenance.origin.kind, conversationId: claim.provenance.origin.conversationId, at: claim.provenance.origin.at, files: index.files[claim.id]?.length ?? 0 },
    supersedes: claim.supersedes, correction: claim.correction, createdAt: claim.createdAt, lastUsedAt: index.usage[claim.id]?.lastUsedAt ?? null, contexts: index.usage[claim.id]?.contexts ?? 0 };
}

/**
 * Bounded owner search. Every scope/state/kind filter runs before relevance scoring and before any
 * snippet is produced, so a Bot-filtered search never ranks or excerpts another Bot's private item.
 * Withdrawn or erased text never matches a query.
 */
export function searchMemory(index: MemoryOwnerIndex, query: ClientMemoryQuery): ClientMemoryList {
  const byId = new Map(index.claims.map(claim => [claim.id, claim])), memo = new Map<string, boolean>();
  const bots = [...new Set(index.claims.flatMap(claim => claim.provenance.scope.kind === "bot" ? [claim.provenance.scope.botId] : []))].sort();
  const eligible = index.claims.filter(claim => {
    const state = stateOf(claim);
    if (query.state === "active" && state !== "active" || query.state === "inactive" && state === "active") return false;
    if (query.kind !== "all" && claim.kind !== query.kind || query.category !== "all" && claim.category !== query.category) return false;
    return query.bot === null || visibleTo(byId, claim, query.bot, memo);
  });
  const needle = normalize(query.q), terms = needle ? lexicalTerms(needle) : null;
  const ranked = eligible.flatMap(claim => {
    if (!terms) return [{ claim, score: 0 }];
    const text = stateOf(claim) === "active" ? claim.text : "";
    if (!text) return [];
    const score = (normalize(text).includes(needle) ? 100 : 0) + lexicalScore(terms, text);
    return score >= 3 ? [{ claim, score }] : [];
  }).sort((a, b) => b.score - a.score || b.claim.createdAt - a.claim.createdAt || (a.claim.id < b.claim.id ? -1 : 1));
  return { contract: "s16-client-memory/v1", query, total: ranked.length, limit: pageSize, items: ranked.slice(query.offset, query.offset + pageSize).map(({ claim }) => item(index, claim)), bots };
}

/** Owner detail with exact text/quote while active, file pin state, correction chain and retained usage. */
export function memoryDetail(index: MemoryOwnerIndex, claimId: string): ClientMemoryDetail {
  const byId = new Map(index.claims.map(claim => [claim.id, claim])), claim = byId.get(claimId);
  if (!claim) throw new AppError("not_found", 404);
  const before: MemoryClaimView[] = [], after: MemoryClaimView[] = [], seen = new Set([claim.id]);
  for (let current = claim.supersedes ? byId.get(claim.supersedes) : undefined; current && !seen.has(current.id) && before.length < 32; current = current.supersedes ? byId.get(current.supersedes) : undefined) { seen.add(current.id); before.unshift(current); }
  for (let current = claim.correction ? byId.get(claim.correction) : undefined; current && !seen.has(current.id) && after.length < 32; current = current.correction ? byId.get(current.correction) : undefined) { seen.add(current.id); after.push(current); }
  const value = item(index, claim), active = value.state === "active", usage = index.usage[claim.id];
  return { contract: "s16-client-memory-detail/v1", item: { ...value, text: active ? claim.text : "", quote: active ? claim.quote : "" }, files: index.files[claim.id] ?? [],
    chain: [...before, ...after].map(entry => item(index, entry)), uses: { contexts: usage?.contexts ?? 0, summaries: usage?.summaries ?? 0, artifacts: usage?.artifacts ?? 0, workItems: usage?.workItems ?? 0 } };
}

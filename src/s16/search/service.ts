import { AppError } from '../../errors';
import { lexicalScore, lexicalTerms } from '../../memory/lexical';
import type { ConversationStore } from '../../s15/conversation/store';
import type { ConversationOwner } from '../../s15/conversation/types';
import type { SearchDocument, SearchItem, SearchLabelCommand, SearchLabelReceipt, SearchLabels, SearchPage, SearchQuery, SearchTarget, SearchKind } from './contracts';
import { parseSearchQuery, searchCapacity, searchFilter, searchHash, searchId, searchKey, searchLabel, searchNormalize, searchPosition, searchTarget } from './query';

interface OrganizationRow { revision: number; labels: string }
const clip = (text: string, length: number) => { const chars = Array.from(text.replace(/\s+/gu, ' ').trim()); return chars.length > length ? chars.slice(0, length - 1).join('') + '…' : chars.join(''); };
/**
 * Fresh owning-service search with exact owner-only organization in additive CHAT tables. No text
 * index, query history or result cache exists; `documents` must reacquire every owning guard before
 * returning a document. `resolve` does the same for one old result independently of search windows.
 */
export class SearchDirectory<Actor> {
  constructor(readonly options: { store: ConversationStore; owner(actor: Actor): ConversationOwner; documents(actor: Actor): SearchDocument[]; resolve(actor: Actor, target: SearchTarget): SearchDocument | null; /** Protected full current content iterator; ordinary search still emits bounded snippets. */ content?(actor: Actor, kinds?: readonly SearchKind[]): Iterable<SearchDocument> }) {}
  /** Protected current owning content, independently guarded per item; never a cached search page. */
  content(actor: Actor, kinds?: readonly SearchKind[]): Iterable<SearchDocument> {
    this.options.owner(actor);
    if (!this.options.content) throw new AppError('owner_export_unavailable', 503);
    return this.options.content(actor, kinds);
  }
  #labels(owner: ConversationOwner, target: SearchTarget): SearchLabels {
    const row = this.options.store.db.query<OrganizationRow, [string, number, string]>('SELECT revision,labels FROM search_labels WHERE owner_id=? AND owner_generation=? AND target=?').get(owner.id, owner.generation, searchKey(target));
    return row ? { revision: row.revision, labels: JSON.parse(row.labels) as string[] } : { revision: 0, labels: [] };
  }
  #project(owner: ConversationOwner, doc: SearchDocument): SearchItem {
    return { target: { ...doc.target }, title: clip(doc.title, 120), snippet: clip(doc.text, 280), state: doc.state, at: doc.at, botId: doc.botId, source: { ...doc.source }, organization: this.#labels(owner, doc.target) };
  }
  /** Scope/current-state filters run before matching, relevance, snippets, counts, facets and cursors. */
  search(actor: Actor, params: URLSearchParams): SearchPage {
    const owner = this.options.owner(actor), query = parseSearchQuery(params), position = searchPosition(query), documents = this.options.documents(actor);
    if (documents.length > searchCapacity) throw new AppError('search_capacity', 413);
    const eligible = documents.filter(doc => (query.kind === 'all' || query.kind === doc.target.kind) && (query.bot === null || doc.botId === query.bot && (!doc.visibleToBot || doc.visibleToBot(query.bot))) && (query.from === null || doc.at >= query.from) && (query.to === null || doc.at <= query.to));
    const labels = new Map<string, number>(), needle = searchNormalize(query.q), terms = lexicalTerms(needle);
    const ranked = eligible.flatMap(doc => {
      const organization = this.#labels(owner, doc.target);
      for (const name of organization.labels) labels.set(name, (labels.get(name) ?? 0) + 1);
      if (query.label !== null && !organization.labels.includes(query.label)) return [];
      const text = `${doc.title}\n${doc.text}`, score = needle ? (searchNormalize(text).includes(needle) ? 100 : 0) + lexicalScore(terms, text) : 0;
      return !needle || score >= 3 ? [{ doc, score, key: searchKey(doc.target) }] : [];
    }).sort((a, b) => b.score - a.score || b.doc.at - a.doc.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const remaining = position ? ranked.filter(row => row.score < position.score || row.score === position.score && (row.doc.at < position.at || row.doc.at === position.at && row.key > position.key)) : ranked;
    const page = remaining.slice(0, 25), last = page.at(-1);
    this.options.owner(actor);
    return { contract: 's16-client-search/v1', query, total: ranked.length, limit: 25, items: page.map(row => this.#project(owner, row.doc)), next: remaining.length > 25 && last ? Buffer.from(JSON.stringify({ version: 1, filter: searchFilter(query), score: last.score, at: last.doc.at, key: last.key })).toString('base64url') : null, labels: [...labels].sort(([a], [b]) => a < b ? -1 : 1).map(([name, count]) => ({ name, count })) };
  }
  /** Freshly resolves an old identity; no cursor, label or cached result can make it readable. */
  object(actor: Actor, raw: unknown): SearchItem {
    const owner = this.options.owner(actor), target = searchTarget(raw), doc = this.options.resolve(actor, target);
    if (!doc) throw new AppError('search_object_unavailable', 409);
    this.options.owner(actor); return this.#project(owner, doc);
  }
  /** Exact revisioned label replacement; retries bind all original bytes and never execute work. */
  command(actor: Actor, raw: unknown): SearchLabelReceipt {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'contract,labels,requestId,revision,target') throw new AppError('invalid_search_command');
    const input = raw as SearchLabelCommand, target = searchTarget(input.target);
    if (input.contract !== 's16-search-labels/v1' || !searchId(input.requestId) || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.labels) || input.labels.length > 8) throw new AppError('invalid_search_command');
    const labels = input.labels.map(searchLabel);
    if (new Set(labels).size !== labels.length) throw new AppError('invalid_search_label');
    // Include original (not normalized) label bytes, so altered retry content cannot alias a command.
    const fingerprint = searchHash({ contract: input.contract, requestId: input.requestId, target, revision: input.revision, labels: input.labels });
    return this.options.store.transaction(() => {
      const owner = this.options.owner(actor); this.object(actor, target);
      const db = this.options.store.db, old = db.query<{ hash: string }, [string, number, string]>('SELECT hash FROM search_label_commands WHERE owner_id=? AND owner_generation=? AND id=?').get(owner.id, owner.generation, input.requestId);
      if (old) { if (old.hash !== fingerprint) throw new AppError('search_command_conflict', 409); return this.receipt(actor, input.requestId); }
      this.options.store.capacity();
      const current = this.#labels(owner, target);
      if (current.revision !== input.revision) throw new AppError('search_labels_changed', 409);
      const sets = db.query<{ labels: string }, [string, number, string]>('SELECT labels FROM search_labels WHERE owner_id=? AND owner_generation=? AND target<>?').all(owner.id, owner.generation, searchKey(target));
      const names = new Set([...sets.flatMap(row => JSON.parse(row.labels) as string[]), ...labels]);
      const commands = db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_label_commands').get()!.n;
      const objects = db.query<{ n: number }, []>('SELECT count(*) AS n FROM search_labels').get()!.n;
      if (names.size > 128 || commands >= searchCapacity || current.revision === 0 && objects >= searchCapacity) throw new AppError('search_label_capacity', 409);
      const revision = current.revision + 1;
      db.query('INSERT INTO search_labels VALUES (?,?,?,?,?) ON CONFLICT(owner_id,owner_generation,target) DO UPDATE SET revision=excluded.revision,labels=excluded.labels').run(owner.id, owner.generation, searchKey(target), revision, JSON.stringify(labels));
      db.query('INSERT INTO search_label_commands VALUES (?,?,?,?,?,?)').run(owner.id, owner.generation, input.requestId, fingerprint, searchKey(target), revision);
      return { contract: 's16-search-label-receipt/v1', requestId: input.requestId, target, appliedRevision: revision, current: { revision, labels } };
    });
  }
  /** Original-command read-back after loss/restart; withdrawn targets never expose retained labels. */
  receipt(actor: Actor, requestId: string): SearchLabelReceipt {
    if (!searchId(requestId)) throw new AppError('invalid_search_command');
    const owner = this.options.owner(actor), row = this.options.store.db.query<{ target: string; revision: number }, [string, number, string]>('SELECT target,revision FROM search_label_commands WHERE owner_id=? AND owner_generation=? AND id=?').get(owner.id, owner.generation, requestId);
    if (!row) throw new AppError('not_found', 404);
    const separator = row.target.indexOf(':'), target = searchTarget({ kind: row.target.slice(0, separator), id: row.target.slice(separator + 1) });
    this.object(actor, target);
    return { contract: 's16-search-label-receipt/v1', requestId, target, appliedRevision: row.revision, current: this.#labels(owner, target) };
  }
}

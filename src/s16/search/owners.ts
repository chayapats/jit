import { AppError } from '../../errors';
import type { ConversationApplication, ConversationRequest } from '../../s15/conversation';
import type { MemoryClaimView, MemoryOwnerIndex } from '../../s15/memory/types';
import type { ResponsibilityProjection } from '../../s15/work';
import { committedArtifacts } from '../artifacts';
import type { BotDirectory } from '../bots/service';
import type { FileStore } from '../files/store';
import type { S16MemoryPort } from '../memory';
import type { RoutineService } from '../routines/service';
import type { SearchDocument, SearchTarget } from './contracts';
import { searchCapacity, searchId } from './query';
import { SearchDirectory } from './service';

/** Protected composition of existing owners. No raw journal row is itself a public search result. */
export function createSearchDirectory<Actor, Work>(app: ConversationApplication<Actor, Work>, options: {
  memory: S16MemoryPort<Actor>; files?: FileStore<Actor>; routines?: RoutineService<Actor>; bots?: BotDirectory<Actor>;
  /** Owning current resource/DATA15 metadata check; it grants no work or source release. */
  memoryCurrent(actor: Actor, claim: MemoryClaimView, botId?: string): boolean;
  work: { search(actor: Actor): ResponsibilityProjection[] };
}): SearchDirectory<Actor> {
  const owner = (actor: Actor) => app.options.policy.requireOwner(actor);
  const bot = (conversationId: string | null) => conversationId ? options.bots?.conversationBot(conversationId) ?? null : null;
  const historySafe = (requestId: string, text: string) => !app.options.memory || app.options.memory.allowHistory(requestId, text);
  function request(actor: Actor, id: string): ConversationRequest | null {
    try {
      const current = app.view(actor, id);
      // Publication failure withholds the whole search row, not just its result snippet/title.
      const original = app.store.db.query<{ had_result: number }, [string]>("SELECT json_type(record_json,'$.result')='text' AS had_result FROM requests WHERE id=?").get(id);
      if (original?.had_result && current.result === null) return null;
      const text = `${current.command.text}\n${current.result ?? ''}`;
      if (!historySafe(id, text) || !historySafe(current.command.requestId, current.command.text)) return null;
      for (const input of current.fileInputs ?? []) {
        if (!options.files) return null;
        const file = options.files.status(actor, input.id);
        if (file.state !== 'ready' || file.receipt?.sha256 !== input.sha256) return null;
      }
      // A delegated task is Bot-authored and inherits its live work/source restrictions even while
      // unfinished; it is not harmless owner ingress when its original authority has been withdrawn.
      if (current.delegation) {
        if (!current.authority) return null;
        app.options.policy.guard(app.options.policy.open(current.authority), 'publication');
      }
      return current;
    } catch (error) {
      owner(actor); // Authentication failures must fence the whole response rather than resemble no hits.
      if (error instanceof AppError && error.status >= 500) throw error;
      return null;
    }
  }
  const fromCommand = (current: ConversationRequest, id: string, text: string): SearchDocument => ({
    target: { kind: 'history', id }, title: text || id,
    text: `${text}\n${id === current.receipt.rootRequestId ? current.result ?? '' : ''}`.slice(0, 65536), state: current.state,
    at: current.receipt.receivedAt, botId: current.delegation?.botId ?? bot(current.receipt.conversationId),
    source: { kind: 'chat', conversationId: current.receipt.conversationId, requestId: current.receipt.rootRequestId },
  });
  function memoryDocuments(actor: Actor): SearchDocument[] {
    const index: MemoryOwnerIndex = options.memory.ownerIndex(actor), byId = new Map(index.claims.map(claim => [claim.id, claim]));
    const active = new Map<string, boolean>(), scopes = new Map<string, Map<string, boolean>>();
    const current = (claim: MemoryClaimView, path = new Set<string>()): boolean => {
      const known = active.get(claim.id); if (known !== undefined) return known;
      if (path.has(claim.id)) return false; path.add(claim.id);
      const value = claim.lifecycle === 'active' && claim.sourceState === 'current' && options.memoryCurrent(actor, claim) && (index.files[claim.id] ?? []).every(pin => pin.current) && claim.dependencies.every(id => { const parent = byId.get(id); return !!parent && current(parent, path); });
      path.delete(claim.id); active.set(claim.id, value); return value;
    };
    const visible = (claim: MemoryClaimView, selected: string, path = new Set<string>()): boolean => {
      let memo = scopes.get(selected); if (!memo) { memo = new Map(); scopes.set(selected, memo); }
      const known = memo.get(claim.id); if (known !== undefined) return known;
      if (path.has(claim.id)) return false; path.add(claim.id);
      const scope = claim.provenance.scope;
      const value = (scope.kind !== 'bot' || scope.botId === selected) && options.memoryCurrent(actor, claim, selected) && claim.dependencies.every(id => { const parent = byId.get(id); return !!parent && visible(parent, selected, path); });
      path.delete(claim.id); memo.set(claim.id, value); return value;
    };
    return index.claims.filter(claim => current(claim)).map(claim => ({ target: { kind: 'memory', id: claim.id }, title: claim.text, text: claim.text, state: claim.kind,
      at: claim.createdAt, botId: claim.provenance.scope.kind === 'bot' ? claim.provenance.scope.botId : bot(claim.provenance.origin.conversationId),
      source: { kind: 'memory', id: claim.id }, visibleToBot: selected => visible(claim, selected) }));
  }
  function documents(actor: Actor): SearchDocument[] {
    const principal = owner(actor);
    const ids = app.store.db.query<{ id: string; root_id: string; text: string }, [string, number]>(`SELECT c.id,c.root_id,json_extract(c.command_json,'$.text') AS text FROM commands c JOIN requests r ON r.id=c.root_id
      WHERE json_extract(r.record_json,'$.owner.id')=? AND json_extract(r.record_json,'$.owner.generation')=? AND json_type(c.command_json,'$.text')='text' ORDER BY c.rowid LIMIT 10001`).all(principal.id, principal.generation);
    if (ids.length > searchCapacity) throw new AppError('search_capacity', 413);
    const roots = new Map<string, ConversationRequest | null>();
    const items = ids.flatMap(({ id, root_id, text }) => {
      if (!roots.has(root_id)) roots.set(root_id, request(actor, root_id));
      const row = roots.get(root_id);
      return row && historySafe(id, text) && historySafe(root_id, text) ? [fromCommand(row, id, text)] : [];
    });
    for (const responsibility of options.work.search(actor)) {
      const origin = request(actor, responsibility.sourceRequestId);
      if (!origin || !historySafe(responsibility.sourceRequestId, responsibility.completion)) continue;
      items.push({ target: { kind: 'work', id: responsibility.id }, title: responsibility.originalText, text: `${responsibility.originalText}\n${responsibility.completion}`.slice(0, 32768), state: responsibility.state,
        at: responsibility.createdAt, botId: bot(responsibility.conversationId), source: { kind: 'chat', conversationId: responsibility.conversationId, requestId: responsibility.sourceRequestId } });
    }
    for (const routine of options.routines?.search(actor) ?? []) {
      if (!historySafe(routine.id, `${routine.draft.name}\n${routine.draft.instruction}`)) continue;
      items.push({ target: { kind: 'routine', id: routine.id }, title: routine.draft.name, text: `${routine.draft.name}\n${routine.draft.instruction}`, state: routine.state, at: routine.createdAt,
        botId: bot(routine.draft.conversationId), source: { kind: 'routine', id: routine.id } });
    }
    items.push(...memoryDocuments(actor));
    if (options.files) for (const entry of committedArtifacts(app, options.files, actor)) {
      const artifact = entry.artifact, origin = request(actor, artifact.requestId);
      if (!origin || !historySafe(artifact.requestId, artifact.name)) continue;
      items.push({ target: { kind: 'artifact', id: artifact.id }, title: artifact.name, text: `${artifact.name}\n${artifact.mime}\n${origin.command.text}`.slice(0, 32768), state: 'available', at: artifact.createdAt,
        botId: origin.delegation?.botId ?? bot(artifact.conversationId), source: { kind: 'artifact', id: artifact.id } });
    }
    if (items.length > searchCapacity) throw new AppError('search_capacity', 413);
    owner(actor); return items;
  }
  // Resolve by the exact owning ID, independently of search capacity and every navigation window.
  const resolve = (actor: Actor, target: SearchTarget): SearchDocument | null => {
    owner(actor);
    if (!searchId(target.id)) return null;
    if (target.kind === 'history') {
      const command = app.store.db.query<{ root_id: string; text: string }, [string]>("SELECT root_id,json_extract(command_json,'$.text') AS text FROM commands WHERE id=? AND json_type(command_json,'$.text')='text'").get(target.id);
      if (!command) return null;
      const row = request(actor, command.root_id);
      return row && historySafe(target.id, command.text) && historySafe(command.root_id, command.text) ? fromCommand(row, target.id, command.text) : null;
    }
    if (target.kind === 'memory') return memoryDocuments(actor).find(doc => doc.target.id === target.id) ?? null;
    if (target.kind === 'work') {
      const row = options.work.search(actor).find(row => row.id === target.id);
      if (!row || !request(actor, row.sourceRequestId) || !historySafe(row.sourceRequestId, row.completion)) return null;
      return { target, title: row.originalText, text: `${row.originalText}\n${row.completion}`, state: row.state, at: row.createdAt, botId: bot(row.conversationId), source: { kind: 'chat', conversationId: row.conversationId, requestId: row.sourceRequestId } };
    }
    if (target.kind === 'routine') {
      const row = options.routines?.search(actor).find(row => row.id === target.id);
      if (!row || !historySafe(row.id, `${row.draft.name}\n${row.draft.instruction}`)) return null;
      return { target, title: row.draft.name, text: `${row.draft.name}\n${row.draft.instruction}`, state: row.state, at: row.createdAt, botId: bot(row.draft.conversationId), source: { kind: 'routine', id: row.id } };
    }
    if (!options.files) return null;
    const artifact = committedArtifacts(app, options.files, actor).find(entry => entry.artifact.id === target.id)?.artifact;
    if (!artifact) return null;
    const origin = request(actor, artifact.requestId);
    if (!origin || !historySafe(artifact.requestId, artifact.name)) return null;
    return { target, title: artifact.name, text: `${artifact.name}\n${artifact.mime}\n${origin.command.text}`, state: 'available', at: artifact.createdAt, botId: origin.delegation?.botId ?? bot(artifact.conversationId), source: { kind: 'artifact', id: artifact.id } };
  };
  return new SearchDirectory({ store: app.store, owner, documents, resolve });
}

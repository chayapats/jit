import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { containsCredential, redactCredentials } from '../../security/credentials';
import type { ConversationApplication } from '../../s15/conversation';
import type { BotDirectory } from '../bots/service';
import type { ConnectionDirectory } from '../connections/service';
import type { FileStore } from '../files/store';
import type { S16MemoryPort } from '../memory';
import type { RoutineService } from '../routines/service';
import type { SearchKind } from '../search/contracts';
import type { SearchDirectory } from '../search/service';
import type { SkillDirectory } from '../skills/service';
import { ownerExportMatches, type OwnerExportConfiguration, type OwnerExportFile, type OwnerExportSection } from './contracts';
import { OwnerExportService } from './service';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return redactCredentials(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, scrub(part)]));
  return value;
}
/** Current owning configuration/content composition; no raw maintenance source or protected byte path enters it. */
export function createOwnerExport<Actor, Work>(app: ConversationApplication<Actor, Work>, options: {
  search: SearchDirectory<Actor>; memory: S16MemoryPort<Actor>; files?: FileStore<Actor>; bots?: BotDirectory<Actor>;
  routines?: RoutineService<Actor>; connections?: ConnectionDirectory<Actor>; skills?: SkillDirectory<Actor>; now?: () => number;
}): OwnerExportService<Actor> {
  const sections: OwnerExportSection[] = ['history', 'memory', 'work', ...(options.routines ? ['routine' as const] : []), ...(options.files ? ['artifact' as const, 'file' as const] : []), ...(options.bots ? ['bot' as const] : []), ...(options.connections ? ['connection' as const] : []), ...(options.skills ? ['skill' as const] : [])];
  return new OwnerExportService({ sections, owner(actor) { app.options.policy.requireOwner(actor); }, visit(current, scope, append, reserveMember) {
    const owner = current(), memoryOrigins = new Map(scope.sections.includes('memory') ? options.memory.ownerIndex(owner).claims.map(claim => [claim.id, claim.provenance.origin.conversationId] as const) : []);
    const routines = new Map(scope.sections.includes('routine') ? options.routines?.search(owner).map(routine => [routine.id, routine] as const) ?? [] : []), files = new Set<string>();
    const artifacts = new Map(scope.sections.includes('artifact') ? options.files?.lineage(owner).map(entry => [entry.artifact.id, entry.artifact] as const) ?? [] : []);
    const kinds = [...new Set([...scope.sections.filter(section => ['history', 'memory', 'work', 'routine', 'artifact'].includes(section)), ...(scope.sections.includes('file') ? ['history'] : [])])] as SearchKind[];
    const configuration = (base: Omit<OwnerExportConfiguration, 'configuration' | 'redacted'>, raw: Record<string, unknown>) => {
      if (!ownerExportMatches(scope, base.at, base.conversationId)) return;
      const clean = scrub(raw) as Record<string, unknown>, title = redactCredentials(base.title);
      append({ ...base, title, configuration: clean, redacted: title !== base.title || JSON.stringify(raw) !== JSON.stringify(clean) });
    };
    for (const doc of options.search.content(current(), kinds)) {
      current();
      const conversationId = doc.source.kind === 'chat' ? doc.source.conversationId : doc.target.kind === 'memory' ? memoryOrigins.get(doc.target.id) ?? null : doc.target.kind === 'routine' ? routines.get(doc.target.id)?.draft.conversationId ?? null : doc.target.kind === 'artifact' ? artifacts.get(doc.target.id)?.conversationId ?? null : null;
      if (scope.sections.includes(doc.target.kind) && ownerExportMatches(scope, doc.at, conversationId)) {
        const title = redactCredentials(doc.title), text = redactCredentials(doc.text);
        if (['history', 'memory', 'work'].includes(doc.target.kind)) append({ kind: doc.target.kind as 'history' | 'memory' | 'work', id: doc.target.id, title, text, state: doc.state, at: doc.at, conversationId, redacted: title !== doc.title || text !== doc.text });
        if (doc.target.kind === 'routine') {
          const routine = routines.get(doc.target.id); if (!routine) throw new AppError('owner_export_source_changed', 409); const draft = routine.draft;
          configuration({ kind: 'routine', id: routine.id, title: draft.name, state: routine.state, at: routine.createdAt, conversationId: draft.conversationId }, {
            name: draft.name, instruction: draft.instruction, schedule: draft.schedule, timezone: draft.timezone, misfire: draft.misfire, quiet: draft.quiet,
            limits: { maxRuns: draft.limits.maxRuns, endsAt: draft.limits.endsAt }, requestedScope: { purposeId: draft.scope.purposeId, resourceIds: [...draft.scope.resourceIds], access: draft.scope.access } });
        }
        if (doc.target.kind === 'artifact') {
          const output = artifacts.get(doc.target.id); if (!output) throw new AppError('owner_export_source_changed', 409);
          if (scope.conversationId !== null && output.conversationId !== scope.conversationId) continue;
          reserveMember(output.bytes); const read = options.files!.artifact(current(), doc.target.id); if (read.artifact.sha256 !== output.sha256) throw new AppError('owner_export_source_changed', 409);
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes), body = redactCredentials(raw), bytes = Buffer.from(body, 'utf8');
          append({ kind: 'artifact', id: output.id, title: redactCredentials(output.name), state: 'available', at: output.createdAt, conversationId: output.conversationId,
            mime: output.mime, representation: 'utf8', text: body, bytes: bytes.length, sha256: hash(bytes), redacted: body !== raw || redactCredentials(output.name) !== output.name });
        }
      }
      if (scope.sections.includes('file') && doc.target.kind === 'history' && doc.source.kind === 'chat') {
        const source = app.readContent(current(), doc.source.requestId); if (!source) throw new AppError('owner_export_source_changed', 409);
        for (const input of source.fileInputs ?? []) {
          if (files.has(input.id)) continue;
          const file = options.files!.status(current(), input.id), receipt = file.receipt;
          if (!receipt || file.state !== 'ready' || receipt.sha256 !== input.sha256) throw new AppError('owner_export_source_changed', 409);
          if (!ownerExportMatches(scope, file.createdAt, file.conversationId)) continue;
          files.add(input.id); const title = redactCredentials(receipt.name), binary = receipt.contract === 's16-file-receipt/v2' && receipt.representation.mime !== 'text/plain';
          let value: OwnerExportFile;
          if (binary) {
            reserveMember(4 * Math.ceil(receipt.representation.bytes / 3));
            const image = options.files!.image(current(), file.conversationId, { id: input.id, sha256: input.sha256 });
            if (containsCredential(new TextDecoder('utf-8').decode(image.bytes))) throw new AppError('owner_export_credential_refused', 409);
            value = { kind: 'file', id: input.id, title, state: 'ready', at: file.createdAt, conversationId: file.conversationId, mime: receipt.representation.mime, representation: 'base64', text: Buffer.from(image.bytes).toString('base64'), bytes: image.bytes.length, sha256: hash(image.bytes), redacted: title !== receipt.name };
          }
          else {
            reserveMember(receipt.contract === 's16-file-receipt/v2' ? receipt.representation.bytes : receipt.bytes);
            const read = options.files!.read(current(), file.conversationId, { id: input.id, sha256: input.sha256 }), body = redactCredentials(read.text), bytes = Buffer.from(body, 'utf8');
            value = { kind: 'file', id: input.id, title, state: 'ready', at: file.createdAt, conversationId: file.conversationId, mime: 'text/plain', representation: 'utf8', text: body, bytes: bytes.length, sha256: hash(bytes), redacted: body !== read.text || title !== receipt.name };
          }
          append(value);
        }
      }
    }
    if (scope.sections.includes('bot') && options.bots) for (const bot of options.bots.view(current()).bots) {
      if (scope.conversationId !== null && options.bots.conversationBot(scope.conversationId) !== bot.id) continue;
      const value = options.bots.exportBot(current(), bot.id);
      configuration({ kind: 'bot', id: bot.id, title: value.name, state: bot.state, at: bot.createdAt, conversationId: scope.conversationId }, { name: value.name, responsibility: value.responsibility, model: value.model, excluded: value.excluded, assignments: value.assignments });
    }
    if (scope.sections.includes('connection') && options.connections) {
      const view = options.connections.view(current());
      for (const source of view.sources) configuration({ kind: 'connection', id: source.id, title: source.label, state: source.state, at: source.createdAt, conversationId: source.origin?.conversationId ?? null }, {
        kind: source.kind, endpoint: source.endpoint, authentication: 'reconnect_required', tools: source.tools.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, requestedClass: tool.decision })), truncated: source.truncated });
      if (view.github && view.github.state !== 'not_connected' && view.github.state !== 'removed') configuration({ kind: 'connection', id: 'github', title: 'GitHub', state: view.github.state, at: view.github.verifiedAt ?? 0, conversationId: null }, { kind: 'github', selectedRepositories: [...view.github.selected], authentication: 'reconnect_required' });
    }
    if (scope.sections.includes('skill') && options.skills) {
      options.skills.options.requireOwner(current());
      for (const record of options.skills.records()) {
        if (record.ownerGeneration !== options.skills.options.ownerGeneration() || record.state !== 'active' || !record.activePin) continue;
        const detail = options.skills.detail(current(), record.id), pkg = detail.active; if (!pkg || pkg.pin !== record.activePin) throw new AppError('owner_export_source_changed', 409);
        configuration({ kind: 'skill', id: record.id, title: pkg.name, state: record.state, at: record.createdAt, conversationId: null }, {
          name: pkg.name, description: pkg.description, version: pkg.version, license: pkg.license, pin: pkg.pin, origin: pkg.origin, importSource: record.importSource ?? null,
          requestedAvailability: record.review?.availability ?? null, requestedExecutable: record.review?.executable ?? false,
          dependencies: pkg.dependencies.map(dependency => ({ key: dependency.key, endpoint: dependency.endpoint, transport: dependency.transport })) });
      }
    }
    current();
  } }, options.now);
}

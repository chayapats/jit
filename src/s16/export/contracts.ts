import { AppError } from '../../errors';

/** Finite fresh owner projection; never the size limits or schema of protected recovery custody. */
export const ownerExportLimits = Object.freeze({ items: 4096, bytes: 16777216, memberBytes: 8388608 });
/** Current content/configuration sections, advertised only when their actual owning ports are composed. */
export const ownerExportSections = ['history', 'memory', 'work', 'routine', 'artifact', 'file', 'bot', 'connection', 'skill'] as const;
export type OwnerExportSection = typeof ownerExportSections[number];
/** Closed explicit read scope. IDs/filters are selectors, never authority or command/effect identities. */
export interface OwnerExportRequest {
  contract: 's16-owner-export-request/v1'; sections: OwnerExportSection[];
  conversationId: string | null; from: number | null; to: number | null;
}
/** Plain current content with original navigation identity, excluding grants/action payloads and raw journals. */
export interface OwnerExportText {
  kind: 'history' | 'memory' | 'work'; id: string; title: string; text: string; state: string; at: number;
  conversationId: string | null; redacted: boolean;
}
/** Readable bytes/metadata only. An altered representation cannot claim the original uploaded byte identity. */
export interface OwnerExportFile {
  kind: 'file' | 'artifact'; id: string; title: string; state: string; at: number; conversationId: string;
  mime: string; representation: 'utf8' | 'base64'; text: string; bytes: number; sha256: string; redacted: boolean;
}
/** Reusable owner-authored configuration is data; no import, activation or installed authority is included. */
export interface OwnerExportConfiguration {
  kind: 'routine' | 'bot' | 'connection' | 'skill'; id: string; title: string; state: string; at: number; conversationId: string | null;
  configuration: Record<string, unknown>; redacted: boolean;
}
export type OwnerExportRecord = OwnerExportText | OwnerExportFile | OwnerExportConfiguration;
/** The entire selected current projection. Capacity/auth/current-source failure releases no partial attachment. */
export interface OwnerExport {
  contract: 's16-owner-export/v1'; generatedAt: number; scope: OwnerExportRequest;
  counts: Partial<Record<OwnerExportSection, number>>; records: OwnerExportRecord[];
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const timestamp = (value: unknown): value is number | null => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
/** Validates exact available sections and finite filters without silently widening malformed scope. */
export function parseOwnerExportRequest(raw: unknown, available: readonly OwnerExportSection[]): OwnerExportRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'contract,conversationId,from,sections,to') throw new AppError('invalid_owner_export');
  const value = raw as OwnerExportRequest;
  if (value.contract !== 's16-owner-export-request/v1' || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > ownerExportSections.length ||
    value.sections.some(section => !available.includes(section)) || new Set(value.sections).size !== value.sections.length || value.conversationId !== null && !identifier(value.conversationId) ||
    !timestamp(value.from) || !timestamp(value.to) || value.from !== null && value.to !== null && value.from > value.to) throw new AppError('invalid_owner_export');
  return { contract: value.contract, sections: ownerExportSections.filter(section => value.sections.includes(section)), conversationId: value.conversationId, from: value.from, to: value.to };
}
/** Applies every selected dimension before exported counts; absent conversation metadata never widens a filter. */
export function ownerExportMatches(scope: OwnerExportRequest, at: number, conversationId: string | null): boolean {
  return (scope.conversationId === null || scope.conversationId === conversationId) && (scope.from === null || at >= scope.from) && (scope.to === null || at <= scope.to);
}

/** Validates the closed content DTO before a shared client releases a downloaded attachment. */
export function validateOwnerExport(raw: unknown, expected: OwnerExportRequest): asserts raw is OwnerExport {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value: unknown, fields: string): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
  const nat = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const text = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed();
  const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const invalid = (): never => { throw new AppError('owner_export_invalid', 409); };
  if (!exact(raw, 'contract,generatedAt,scope,counts,records') || raw.contract !== 's16-owner-export/v1' || !nat(raw.generatedAt) || !object(raw.counts) || !Array.isArray(raw.records) || raw.records.length > ownerExportLimits.items) invalid();
  const value = raw as unknown as OwnerExport;
  let parsed: OwnerExportRequest; try { parsed = parseOwnerExportRequest(value.scope, ownerExportSections); } catch { return invalid(); }
  if (JSON.stringify(parsed) !== JSON.stringify(expected) || Object.keys(value.counts).sort().join(',') !== [...expected.sections].sort().join(',')) invalid();
  const ids = new Set<string>(), counts = Object.fromEntries(expected.sections.map(section => [section, 0])) as Partial<Record<OwnerExportSection, number>>;
  for (const item of value.records) {
    if (!object(item) || !expected.sections.includes(item.kind) || !identifier(item.id) || !text(item.title) || typeof item.state !== 'string' || !/^[a-z_]{1,64}$/.test(item.state) || !nat(item.at) || item.conversationId !== null && !identifier(item.conversationId) || typeof item.redacted !== 'boolean' || !ownerExportMatches(expected, item.at, item.conversationId) || new TextEncoder().encode(JSON.stringify(item)).length > ownerExportLimits.memberBytes) invalid();
    const key = item.kind + ':' + item.id; if (ids.has(key)) invalid(); ids.add(key); counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    const base = 'kind,id,title,state,at,conversationId,redacted';
    if (['history', 'memory', 'work'].includes(item.kind)) { if (!exact(item, base + ',text') || !text((item as OwnerExportText).text)) invalid(); }
    else if (item.kind === 'file' || item.kind === 'artifact') {
      if (!exact(item, base + ',mime,representation,text,bytes,sha256') || !text(item.mime) || item.conversationId === null) invalid();
      const file = item as OwnerExportFile;
      if (file.representation === 'utf8') { if (!(file.kind === 'file' ? ['text/plain'] : ['text/plain', 'text/markdown', 'text/csv', 'text/html']).includes(file.mime) || !text(file.text) || !nat(file.bytes) || !sha(file.sha256) || new TextEncoder().encode(file.text).length !== file.bytes) invalid(); }
      else if (file.representation !== 'base64' || file.kind !== 'file' || !['image/png', 'image/jpeg'].includes(file.mime) || !text(file.text) || !nat(file.bytes) || !sha(file.sha256) || (file.text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.text)) || file.text.length / 4 * 3 - (file.text.endsWith('==') ? 2 : file.text.endsWith('=') ? 1 : 0) !== file.bytes) invalid();
    } else {
      if (!exact(item, base + ',configuration') || !object(item.configuration)) invalid();
      const names = { routine: 'name,instruction,schedule,timezone,misfire,quiet,limits,requestedScope', bot: 'name,responsibility,model,excluded,assignments', connection: null, skill: 'name,description,version,license,pin,origin,importSource,requestedAvailability,requestedExecutable,dependencies' } as const;
      const config = (item as OwnerExportConfiguration).configuration;
      if (item.kind === 'connection') {
        if (config.kind === 'github' ? !exact(config, 'kind,selectedRepositories,authentication') : !exact(config, 'kind,endpoint,authentication,tools,truncated')) invalid();
        if (config.authentication !== 'reconnect_required') invalid();
      } else if (!exact(config, names[item.kind as keyof typeof names]!)) invalid();
    }
  }
  for (const section of expected.sections) if (!nat(value.counts[section]) || value.counts[section] !== counts[section]) invalid();
}

import { createHash } from 'node:crypto';
import { containsCredential } from '../../security/credentials';
import { AppError } from '../../errors';
import { ownerExportLimits, ownerExportMatches, parseOwnerExportRequest, validateOwnerExport, type OwnerExport, type OwnerExportRecord, type OwnerExportRequest, type OwnerExportSection } from './contracts';

/** Actual owning projections only. The publisher supplies a fresh authenticated actor on every guard. */
export interface OwnerExportSource<Actor> {
  sections: readonly OwnerExportSection[];
  owner(actor: Actor): void;
  visit(actor: () => Actor, scope: OwnerExportRequest, append: (record: OwnerExportRecord) => void, reserveMember: (bytes: number) => void): void;
}
/** In-memory validated attachment; no path, private cache, work grant or activation authority exists. */
export interface OwnerExportAttachment { bytes: Uint8Array; sha256: string; filename: 'jit-export.json' }
/** Fresh complete selected projection, with owning revalidation immediately before synchronous response release. */
export class OwnerExportService<Actor> {
  constructor(readonly source: OwnerExportSource<Actor>, readonly now: () => number = Date.now) {}
  /** Builds twice through actual current owners; changed content/eligibility or authentication fences the whole release. */
  publish<T>(actor: () => Actor, raw: unknown, release: (attachment: OwnerExportAttachment) => T): T {
    const current = () => { const value = actor(); if ((this.source.owner(value) as unknown) !== undefined) throw new AppError('owner_export_source_invalid', 409); return value; };
    current(); const scope = parseOwnerExportRequest(raw, this.source.sections), generatedAt = this.now();
    if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) throw new AppError('owner_export_clock_invalid', 409);
    const build = (): string => {
      current(); const records: OwnerExportRecord[] = [], counts: OwnerExport['counts'] = {}, ids = new Set<string>(); let measured = 0;
      for (const section of scope.sections) counts[section] = 0;
      const reserveMember = (bytes: number) => { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ownerExportLimits.memberBytes || measured + bytes > ownerExportLimits.bytes) throw new AppError('owner_export_capacity', 413); };
      const visited = this.source.visit(current, scope, record => {
        current(); const id = record.kind + ':' + record.id;
        if (!scope.sections.includes(record.kind) || !ownerExportMatches(scope, record.at, record.conversationId) || ids.has(id)) throw new AppError('owner_export_source_invalid', 409);
        const bytes = Buffer.byteLength(JSON.stringify(record)); measured += bytes;
        if (bytes > ownerExportLimits.memberBytes || measured > ownerExportLimits.bytes || records.length >= ownerExportLimits.items) throw new AppError('owner_export_capacity', 413);
        ids.add(id); counts[record.kind] = (counts[record.kind] ?? 0) + 1; records.push(record);
      }, reserveMember);
      if ((visited as unknown) !== undefined) throw new AppError('owner_export_source_invalid', 409);
      current(); const value: OwnerExport = { contract: 's16-owner-export/v1', generatedAt, scope, counts, records }, text = JSON.stringify(value);
      if (Buffer.byteLength(text) > ownerExportLimits.bytes) throw new AppError('owner_export_capacity', 413);
      validateOwnerExport(value, scope);
      if (containsCredential(text)) throw new AppError('owner_export_credential_refused', 409); return text;
    };
    const first = build(), second = build(); current();
    if (first !== second) throw new AppError('owner_export_source_changed', 409);
    const bytes = Buffer.from(second, 'utf8'); return release({ bytes, sha256: createHash('sha256').update(bytes).digest('hex'), filename: 'jit-export.json' });
  }
}

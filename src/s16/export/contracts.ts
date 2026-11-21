import { AppError } from '../../errors';
import { OwnerExportValidationError, parseOwnerExportRequest as parseClientRequest, validateOwnerExport as validateClientExport, type OwnerExportRequest, type OwnerExportSection, type OwnerExport } from '../client/owner-export';

export { ownerExportLimits, ownerExportSections, ownerExportMatches } from '../client/owner-export';
export type { OwnerExportSection, OwnerExportRequest, OwnerExportText, OwnerExportFile, OwnerExportConfiguration, OwnerExportRecord, OwnerExport } from '../client/owner-export';

function protectedBoundary<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof OwnerExportValidationError) throw new AppError(error.code, error.status); throw error; }
}
/** Retains the protected HTTP error contract over the shared pure request schema. */
export function parseOwnerExportRequest(raw: unknown, available: readonly OwnerExportSection[]): OwnerExportRequest {
  return protectedBoundary(() => parseClientRequest(raw, available));
}
/** Retains protected validation errors while sharing exact browser/native DTO checks. */
export function validateOwnerExport(raw: unknown, expected: OwnerExportRequest): asserts raw is OwnerExport {
  protectedBoundary(() => validateClientExport(raw, expected));
}

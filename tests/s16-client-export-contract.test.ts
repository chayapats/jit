import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { AppError } from '../src/errors';
import { OwnerExportValidationError, ownerExportSections, parseOwnerExportRequest as parseShared, validateOwnerExport as validateShared } from '../src/s16/client/owner-export';
import { parseOwnerExportRequest, validateOwnerExport } from '../src/s16/export/contracts';

const request = { contract: 's16-owner-export-request/v1' as const, sections: ['history'] as const, conversationId: null, from: null, to: null };
function failure(call: () => void): unknown { try { call(); return null; } catch (error) { return error; } }

test('pure export schema keeps protected request/response error contracts at the HTTP boundary', () => {
  expect(failure(() => parseShared({}, ownerExportSections))).toBeInstanceOf(OwnerExportValidationError);
  const input = failure(() => parseOwnerExportRequest({}, ownerExportSections));
  expect(input).toBeInstanceOf(AppError); expect(input).toMatchObject({ code: 'invalid_owner_export', status: 400 });
  const scope = parseOwnerExportRequest({ ...request, sections: [...request.sections] }, ownerExportSections);
  expect(parseShared({ ...request, sections: [...request.sections] }, ownerExportSections)).toEqual(scope);
  expect(failure(() => validateShared({}, scope))).toBeInstanceOf(OwnerExportValidationError);
  const output = failure(() => validateOwnerExport({}, scope));
  expect(output).toBeInstanceOf(AppError); expect(output).toMatchObject({ code: 'owner_export_invalid', status: 409 });
});

test('actual browser bundle of the shared export schema stays inside native shared watch roots', async () => {
  const root = resolve(import.meta.dir, '..');
  const built = await Bun.build({ entrypoints: [resolve(root, 'src/s16/client/owner-export.ts')], target: 'browser', metafile: true });
  expect(built.success).toBe(true); expect(built.metafile).toBeDefined();
  const shared = ['src/i18n', 'src/s16/client', 'src/s16/mobile', 'src/s16/voice'].map(name => resolve(root, name) + '/');
  const files = Object.keys(built.metafile!.inputs).map(name => resolve(root, name));
  expect(files.length).toBeGreaterThan(0); expect(files.every(name => shared.some(prefix => name.startsWith(prefix)))).toBe(true);
});

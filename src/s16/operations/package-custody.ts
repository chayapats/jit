import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { readDependencyRecord, validateArtifact } from '../../../ops/package/bun-build';
import { AppError } from '../../errors';
import { opsRead } from '../../s14/ops-files';
import { canonical } from '../../s15/conversation/validation';
import type { S16LedgerSource } from './ledger-set';
import type { S16PointPackage } from './point-files';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
/** Derives the actual executing sealed service/dependencies/readers/notices; no caller or archive selects its path. */
export function inspectS16ExecutingPackage(sources: readonly S16LedgerSource[]): Readonly<S16PointPackage> {
  const root = resolve(import.meta.dir, '../../..'), checked = validateArtifact(root, { runtime: true }), dependencies = readDependencyRecord(root), manifest = checked.manifest;
  if (!checked.ok || !manifest || !dependencies || manifest.engineContract !== RELEASE_CONTRACT) throw new AppError('s16_ops_verified_package_required', 409);
  return Object.freeze({ contentHash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, lockHash: manifest.lockHash, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
    readersSha256: hash(canonical(sources.map(source => ({ name: source.name, reader: source.reader })))),
    noticesSha256: hash(Buffer.concat([opsRead(join(root, 'LICENSE'), 4194304), Buffer.from('\0'), opsRead(join(root, 'NOTICE'), 4194304)])) });
}

import { readServiceConfigFile, serviceDatabasePath } from '../service-config';
import { opsRead } from '../../../src/s14/ops-files';
import { reportAdoption } from '../../../src/s15/adoption';
import type { AdoptionBuild, AdoptionReport, AdoptionSource } from '../../../src/s15/adoption';

/** Read-only installer handoff; omitted persisted runtime remains legacy, and no service is stopped/reconfigured. */
export interface InstallerAdoptionReportInput { directory: string; source: AdoptionSource; target: AdoptionBuild }
/** Reads the exact named installation only. A local dry run cannot manufacture protected-host acceptance. */
export function installerAdoptionReport(input: InstallerAdoptionReportInput): AdoptionReport {
  const config = readServiceConfigFile(input.source.configPath);
  if ((config.runtime ?? 'legacy') !== input.source.runtime || serviceDatabasePath(config) !== input.source.database) throw new Error('transition_installation_mismatch');
  return reportAdoption({ ...input, runtime: 's15',
    boundary: { observe: () => ({ protected: false, settled: false, priorBuildFenceVerified: false, hostId: 'unverified', evidenceHash: '0'.repeat(64), sourceArtifact: input.source.build.sha256, targetArtifact: input.target.sha256 }) },
    policy: { ownerGeneration: () => 0, verifyOwner: () => null, adapters: [], catalogs: { current: () => null, allows: () => false } },
  });
}
/** Bounded host-local non-secret plan input. It supplies no owner actor, credential or mutation authority. */
export function readInstallerAdoptionReport(path: string): AdoptionReport {
  const input = JSON.parse(opsRead(path, 64 * 1024).toString()) as InstallerAdoptionReportInput;
  if (!input || Object.keys(input).sort().join(',') !== 'directory,source,target') throw new Error('transition_invalid_report_input');
  return installerAdoptionReport(input);
}

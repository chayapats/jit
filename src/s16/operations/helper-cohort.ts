import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import type { ConnectionVault } from '../../exec/connections';
import { identity } from '../../s15/conversation/validation';
import type { FirecrackerControllerCustody } from '../../s15/vm/firecracker/maintenance';
import { firecrackerRpcCustody, type FirecrackerRpcCustody } from '../../s15/vm/firecracker/rpc';
import { requestFirecrackerManagement } from '../../s15/vm/firecracker/request';
import { vmCanonical } from '../../s15/vm/validation';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';

/** Current root-helper references only; private helper journals/disks remain independently retained. */
export interface S16HelperCohort {
  contract: 's16-helper-cohort/v1'; installationId: string;
  helpers: readonly Readonly<{ managerId: string; controllerSource: string; view: Readonly<FirecrackerRpcCustody> }>[];
}
/** Only trusted deterministic composition can inject transport, always labelled protocol_fixture. */
export interface S16HelperCohortOptions { fixture?: { basis: 'protocol_fixture'; fetch: typeof fetch; timeoutMs?: number } }
/** An original current cut can revalidate itself; candidate archives cannot manufacture this live capability. */
export interface S16HelperObservation {
  readonly value: Readonly<S16HelperCohort>; readonly sha256: string;
  assertCurrent(): Promise<void>;
}
/** Current protected composition owns the scope, vault and exclusion; none originates in an archive. */
export interface S16HelperCohortOwner extends S16HelperCohortOptions {
  installationId: string; controllers: readonly FirecrackerControllerCustody[]; vault: ConnectionVault;
  directory: string; lease: S16InstallationLease;
  guard(): void; retain<T>(operation: () => Promise<T>): Promise<T>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_helper_custody_unavailable'): never { throw new AppError(code, 409); }
function text(value: S16HelperCohort): string {
  const encoded = '{"contract":"s16-helper-cohort/v1","helpers":[' + value.helpers.map(helper => vmCanonical(helper)).join(',') + '],"installationId":' + vmCanonical(value.installationId) + '}';
  if (Buffer.byteLength(encoded) > 4194304) refuse('s16_ops_helper_bounds'); return encoded;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value;
}
/**
 * Reads only authenticated custody from every current controller's fixed relay. Never constructs an
 * adapter, settles its original intent or requests physical inspection/recovery. A later revalidation
 * must match the original complete cut; changes never silently replace its expected digest.
 */
export async function captureS16HelperCohort(owner: S16HelperCohortOwner): Promise<S16HelperObservation> {
  identity(owner.installationId);
  const controllers = owner.controllers, fixture = owner.fixture ? Object.freeze({ ...owner.fixture }) : undefined;
  if (controllers.length > 64 || fixture && fixture.basis !== 'protocol_fixture') refuse();
  const guard = () => { assertS16ExclusiveInstallationLease(owner.lease, owner.directory); if ((owner.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; guard();
  const collect = async (): Promise<S16HelperCohort> => {
    guard(); const helpers: S16HelperCohort['helpers'][number][] = [], started = performance.now();
    for (const controller of controllers) {
      guard(); if (performance.now() - started > 60000 || controller.basis !== (fixture ? 'protocol_fixture' : 'protected_host')) refuse();
      const requestId = controller.pending?.requestId ?? null, timeoutMs = fixture?.timeoutMs ?? 10000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) refuse();
      const response = await requestFirecrackerManagement({ origin: controller.origin, installationId: owner.installationId, timeoutMs, credential() { guard(); return owner.vault.readExisting(controller.managerId); }, guard, ...(fixture ? { fetch: fixture.fetch } : {}) }, { operation: 'custody', requestId }); guard();
      const view = firecrackerRpcCustody(response, { computerId: controller.computerId, selectionSha256: controller.selectionSha256, basis: controller.basis }, requestId);
      if (controller.pending) {
        const receipt = view.requested!.receipt;
        if (receipt && hash(vmCanonical(receipt.command)) !== controller.pending.commandSha256) refuse('s16_ops_helper_original_mismatch');
        if (view.computer.revision < controller.pending.expectedRevision) refuse('s16_ops_helper_original_mismatch');
      }
      helpers.push(freeze({ managerId: controller.managerId, controllerSource: controller.source, view }));
    }
    guard(); const value: S16HelperCohort = { contract: 's16-helper-cohort/v1', installationId: owner.installationId, helpers }; text(value); return freeze(value);
  };
  const value = await owner.retain(collect), sha256 = hash(text(value));
  return Object.freeze({ value, sha256, assertCurrent: () => owner.retain(async () => { const latest = await collect(); if (hash(text(latest)) !== sha256) refuse('s16_ops_helper_changed'); }) });
}

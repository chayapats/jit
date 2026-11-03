import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AppError } from '../errors';
import { equal, canonical } from './policy/validation';
import { validateVmm, type QemuVmmOptions } from './vm/vmm';
import type { CatalogKind, PolicyInput, Ref } from './policy';
import type { ApprovedModelRoute, ModelRunLimits } from './model';
import type { EffectBounds } from './effects';
import type { GithubRuntimeConfig } from './github/runtime';
import type { RuntimeDisclosureConfig } from './disclosure/runtime';
import type { S15CompositionOptions } from './composition';

/** Credential-free explicit source/disposable-service configuration; never an existing omitted-runtime service file. */
export interface S15RuntimeConfig {
  contract: 's15-runtime/v1'; installationId: string; directory: string; origin: string;
  policy: PolicyInput | null;
  catalog: { kind: CatalogKind; ref: Ref; active: boolean }[];
  /** Optional narrower per-Bot resource ceilings. Absence never imports an S14-private resource. */
  resourceBots: { resourceId: string; botIds: string[] }[];
  conversation: S15CompositionOptions['conversation']; models: ApprovedModelRoute[]; modelLimits: ModelRunLimits;
  team?: { maxConcurrentOperations: number; memory: 'team' | 'bot' | 'off' };
  disclosure?: RuntimeDisclosureConfig;
  recurring?: import('./policy/recurring').RecurringRuleOptions;
  /**
   * The team's working-computer pool (POOL15-01). `id` names the pool and its default member; with `local` the
   * default member is the Jit-created nested KVM VM that `setup --s15` creates (SETUP15-01). Further members
   * are enrollment records in the protected VM journal, so no pool list is ever written here. The original
   * single-VM shape is exactly this shape and reads as a one-member pool.
   */
  vm: { id: string; resource: Ref; limaInstance: string | null; remote?: { origin: string; credentialRef: string }; upperBound: import('./policy').BudgetVector;
    /** Opt-in Jit-managed nested KVM working VM on this host (2026-11-03 single-host default). */
    local?: boolean;
    /**
     * VM15-03: the separate unprivileged identity that runs the local VM's QEMU, written by `install.sh --s15`.
     * Only valid with `local`. Absent, QEMU runs as the controller identity (developer and evidence hosts).
     */
    vmm?: QemuVmmOptions };
  /**
   * Explicit protected browser (fixtures/staging): a fixed executable and static public origins. `null` selects
   * the provisioned browser when `disclosure` is present (BROW15-02): pinned, checksum-verified Chromium under the
   * state directory and the owner's approved-website journal, managed only in the Web.
   */
  browser: null | { resource: Ref; executablePath: string; publicOrigins: string[]; upperBound: import('./policy').BudgetVector; ownerUi?: Omit<import('./web').S15WebBrowser<import('./policy').OwnerActor>, 'owner'> };
  github: GithubRuntimeConfig | null;
  google: null | { mailConnectionId: string | null; calendarConnectionId: string | null; bounds: EffectBounds; resources: { connectionId: string; resource: Ref }[]; recipients: { ref: Ref; address: string }[] };
}

/** Pool-aware reading of `S15RuntimeConfig.vm`: the pool id, its default member and whether Jit creates that member. */
export function readS15VmPool(vm: S15RuntimeConfig['vm']): { poolId: string; defaultMemberId: string; local: boolean } {
  if (!vm || typeof vm.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(vm.id) || vm.local !== undefined && typeof vm.local !== 'boolean') throw new AppError('invalid_s15_config');
  if (vm.vmm !== undefined) { if (vm.local !== true) throw new AppError('invalid_s15_config'); try { validateVmm(vm.vmm); } catch { throw new AppError('invalid_s15_config'); } }
  return { poolId: vm.id, defaultMemberId: vm.id, local: vm.local === true };
}

/** Validates parsed configuration content. Embedded credentials are refused by canonical validation. */
export function parseS15RuntimeConfig(raw: unknown): S15RuntimeConfig {
  const value = raw as S15RuntimeConfig; canonical(value);
  if (!value || value.contract !== 's15-runtime/v1' || typeof value.directory !== 'string' || !isAbsolute(value.directory) || typeof value.installationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.installationId) || new URL(value.origin).origin !== value.origin || !Array.isArray(value.catalog) || !Array.isArray(value.models) || !value.models.length) throw new AppError('invalid_s15_config');
  if (!value.models.some(r => equal(r.selection, value.conversation.selection) && r.modelId === value.conversation.route.model && r.provider === value.conversation.route.provider)) throw new AppError('route_unavailable');
  readS15VmPool(value.vm);
  if (value.policy && (!value.disclosure || value.policy.resources.some(r => !value.disclosure!.sources.some(s => equal(s.resource, r))))) throw new AppError('classification_unknown');
  return value;
}

/**
 * Reads a bounded owner-controlled configuration. Embedded credentials are refused by canonical validation.
 * The file is private to its owner (no group/other access), or, as `install.sh --s15` writes it, root-owned
 * and readable only by the service group (0640 or narrower), so the service can read but never rewrite it.
 */
export function readS15RuntimeConfig(path: string): S15RuntimeConfig {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.uid === 0 ? s.mode & 0o037 : s.mode & 0o077) || s.size > 65536) throw new AppError('unsafe_s15_config');
  return parseS15RuntimeConfig(JSON.parse(readFileSync(path, 'utf8')));
}


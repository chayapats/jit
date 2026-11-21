import type { Database } from 'bun:sqlite';
import { AppError } from '../../errors';
import type { S16LedgerSource } from './ledger-set';

/** Reviewed binary reader bounds; owning composition must also enable each format's feature dependencies. */
export const s16RuntimeReaders: Readonly<Record<string, Readonly<{ applicationId: number; formats: readonly number[] }>>> = Object.freeze(Object.fromEntries(Object.entries({
  'conversation.sqlite': { applicationId: 0x4a495435, formats: [1, 2, 3, 4, 5] },
  'policy.sqlite': { applicationId: 0x4a503135, formats: [1] },
  'model.sqlite': { applicationId: 0x4a4d5135, formats: [1] },
  'work.sqlite': { applicationId: 0x4a575135, formats: [1] },
  'vm.sqlite': { applicationId: 0x4a495456, formats: [1, 2, 3] },
  'team.sqlite': { applicationId: 0x4a495436, formats: [1, 2, 3, 4] },
  'memory.sqlite': { applicationId: 0x4a495437, formats: [1, 2, 3, 4, 5, 6] },
  'disclosure.sqlite': { applicationId: 0x4a445135, formats: [1] },
  'browser.sqlite': { applicationId: 0, formats: [0] },
  'github.sqlite': { applicationId: 0x4a473135, formats: [1] },
  'files.sqlite': { applicationId: 0x4a495446, formats: [1, 2, 3] },
  'routines.sqlite': { applicationId: 0x52543136, formats: [1] },
  'notifications.sqlite': { applicationId: 0x4e543136, formats: [1] },
  'native-notifications.sqlite': { applicationId: 0x4e503136, formats: [1] },
  'bots.sqlite': { applicationId: 0x4a494236, formats: [1] },
  'connections.sqlite': { applicationId: 0x4a494337, formats: [1] },
  'skills.sqlite': { applicationId: 0x4a49534b, formats: [1] },
  'voice.sqlite': { applicationId: 0x4a565631, formats: [1] },
}).map(([name, value]) => [name, Object.freeze({ ...value, formats: Object.freeze(value.formats) })])));

/**
 * Binds the exact composed runtime inventory to protected owning handles. Missing/foreign/extra live
 * sources refuse rather than silently producing a smaller set. Outer auth/vault/browser-site/helper,
 * byte/native custody and retained disabled stores remain the aggregate coordinator's responsibility.
 */
export function s16SelectedRuntimeSources(names: readonly string[], connections: ReadonlyMap<string, Database | undefined>): readonly S16LedgerSource[] {
  if (!names.length || new Set(names).size !== names.length || [...connections].some(([name, db]) => db && !names.includes(name))) throw new AppError('s16_ops_inventory_changed', 409);
  return Object.freeze(names.map(name => {
    const reader = Object.hasOwn(s16RuntimeReaders, name) ? s16RuntimeReaders[name] : undefined, database = connections.get(name);
    if (!reader || !database) throw new AppError('s16_ops_source_unavailable', 409);
    return Object.freeze({ name, database, reader });
  }));
}

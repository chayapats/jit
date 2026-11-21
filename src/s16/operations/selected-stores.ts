import { AppError } from '../../errors';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16LedgerSource } from './ledger-set';

/** Requires every selected current store without creating it or inferring current authority from history. */
export function assertS16SelectedStores(config: S15RuntimeConfig, sources: readonly S16LedgerSource[]): void {
  const required = ['conversation.sqlite', 'policy.sqlite', 'model.sqlite', 'work.sqlite', 'vm.sqlite', 'team.sqlite', 'memory.sqlite'];
  for (const feature of ['files', 'routines', 'notifications', 'bots', 'connections', 'skills', 'voice'] as const) if (config[feature]) required.push(feature + '.sqlite');
  if (config.disclosure) required.push('disclosure.sqlite');
  if (config.browser || config.disclosure) required.push('browser.sqlite');
  if (config.github || config.disclosure) required.push('github.sqlite');
  const present = new Set(sources.map(row => row.name));
  if (required.some(name => !present.has(name))) throw new AppError('s16_ops_selected_store_missing', 409);
}

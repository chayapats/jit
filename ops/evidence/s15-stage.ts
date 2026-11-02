import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { S15RuntimeConfig } from '../../src/s15/main';
import { zero } from '../../src/s15/policy/validation';

/** Credential-free staging configuration. No policy, budget, personal GitHub rule or host adoption is installed. */
export function s15StageConfig(directory: string, origin: string): S15RuntimeConfig {
  const ref = (id: string) => ({ id, revision: 1, generation: 1 });
  const selection = { route: ref('codex_route'), model: ref('codex_model'), effort: 'high' };
  const bound = { ...zero(), calls: 1, steps: 1, activeMs: 30000, outputBytes: 32768 };
  return { contract: 's15-runtime/v1', installationId: 's15_staged_controller', directory, origin, policy: null,
    catalog: [{ kind: 'bot', ref: ref('jit'), active: true }, { kind: 'resource', ref: ref('computer'), active: true }, { kind: 'route', ref: selection.route, active: true }, { kind: 'model', ref: selection.model, active: true }], resourceBots: [],
    conversation: { ownerId: 'owner', bot: ref('jit'), selection, route: { provider: 'codex', model: 'gpt-6.1-sol' }, limits: { modelCalls: 6, toolCalls: 16, outputBytes: 32768, activeMs: 300000 }, modelCallUpperBound: bound },
    models: [{ selection, provider: 'codex', modelId: 'gpt-6.1-sol', account: ref('codex_account'), billing: ref('codex_subscription'), recipient: ref('codex_provider'), charge: 'subscription', availability: 'unavailable', efforts: ['high'], effortEvidence: 'requested_only', upperBound: bound, rank: { ordinary: 0, difficult: 0 } }],
    modelLimits: { turns: 6, attempts: 1, activeMs: 300000, outputBytes: 32768, contextWindow: 32768, inputChars: 65536 },
    vm: { id: 'working', resource: ref('computer'), limaInstance: null, upperBound: { ...zero(), calls: 1, reads: 1, outputBytes: 1048576, activeMs: 120000 } }, team: { maxConcurrentOperations: 2, memory: 'off' }, browser: null, google: null, github: null };
}
if (import.meta.main) {
  if (process.env.JIT_S15_ARM64_EVIDENCE !== '1') throw Error('explicit_s15_evidence_opt_in_required');
  const [directory, config] = process.argv.slice(2); if (!directory || !config) throw Error('staging_arguments_required');
  writeFileSync(config, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041'), null, 2), { mode: 0o600, flag: 'wx' });
}

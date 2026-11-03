import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import type { Ref } from '../policy';
import type { S15CompositionOptions } from '../composition';
import { GithubApiGateway } from './github-api';
import { ProtectedGithubPush } from './push';
import { createGithubVmWorkspace } from './workspace';
import { createGithubPreload, githubBundleReadHandler } from './composition';
import type { GithubLimits, GithubProduction, GithubRepository } from './types';

/** Protected per-repository coding/production profile; unknown acceptance or deployment semantics never auto-merge. */
export interface GithubRuntimeConfig {
  catalogPurpose?: Ref;
  repositories: { repository: GithubRepository; credentialRef: string; production: GithubProduction }[];
  limits: GithubLimits; tests: { command: string; timeoutMs: number }[];
  criteria: { id: string; text: string; commands: string[] }[];
  maxTurns: number; activeMs: number; maxBundleBytes: number;
}
/** Compose fixed-origin GitHub, credential-free pinned repository preload and immutable protected artifacts. */
export function githubRuntime(config: GithubRuntimeConfig, input: {
  directory: string;
  /** Working-computer pool id (POOL15-01). The composed VM port places each GitHub work on one member and every
   * later attempt of that work returns to the member holding its workspace; this is never a fixed member id. */
  vmId: string; route: S15CompositionOptions['conversation']['route'];
  modelCallUpperBound: S15CompositionOptions['conversation']['modelCallUpperBound']; credential(ref: string): string;
}) {
  const artifacts = join(input.directory, 'github-artifacts'); mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const path = (ref: Ref) => { if (!/^bundle_[a-f0-9]{64}$/.test(ref.id) || ref.revision !== 1 || ref.generation !== 1) throw new AppError('artifact_unavailable'); return join(artifacts, ref.id); };
  const bundle = (ref: Ref) => { const p = path(ref), stat = lstatSync(p); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > config.maxBundleBytes) throw new AppError('artifact_unavailable'); const bytes = readFileSync(p); if (createHash('sha256').update(bytes).digest('hex') !== ref.id.slice(7)) throw new AppError('artifact_unavailable'); return bytes; };
  const repositories = config.repositories.map(r => r.repository);
  const credential = (repo: GithubRepository) => { const r = config.repositories.find(r => r.repository.resource.id === repo.resource.id); if (!r) throw new AppError('outside_scope'); return input.credential(r.credentialRef); };
  const gateway = new GithubApiGateway({ repositories, credential, production: repo => config.repositories.find(r => r.repository.resource.id === repo.resource.id)?.production ?? { consequence: 'unknown', fence: null, evidence: [] }, push: new ProtectedGithubPush({ bundle }) });
  const github: NonNullable<S15CompositionOptions['github']> = { repositories, gateway, limits: config.limits, ...(config.catalogPurpose ? { catalogPurpose: config.catalogPurpose } : {}),
    workspace: ({ policy, vm, disclosure, guardModel, beforeRead, recordRead, routeAuth }) => createGithubVmWorkspace({ vm, vmId: input.vmId, policy, ...(routeAuth ? { routeAuth } : {}), nativeDirectory: join(input.directory, 'native-github'), route: input.route,
      modelCallUpperBound: input.modelCallUpperBound, maxTurns: config.maxTurns, activeMs: config.activeMs, maxBundleBytes: config.maxBundleBytes, tests: config.tests,
      preload: createGithubPreload({ policy, repositories, credential, upperBound: config.limits.readUpperBound, ...(beforeRead ? { beforeRead } : {}), ...(recordRead ? { recordRead } : {}) }),
      ...(guardModel ? { guardModel } : {}), ...(disclosure ? { recordArtifact: (actor, artifact) => disclosure.derive(actor, artifact, 'artifact') } : {}),
      capture(bytes, hash) { const ref = { id: 'bundle_' + hash, revision: 1, generation: 1 }; const file = path(ref); try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!bundle(ref).equals(Buffer.from(bytes))) throw new AppError('artifact_conflict'); } return ref; },
      verifyCriteria({ criteria, evidence }) { return criteria.map(c => { const configured = config.criteria.find(p => p.id === c.id && p.text === c.text); return { id: c.id, passed: !!configured?.commands.length && configured.commands.every(command => evidence.tests.some(t => t.command === command && t.exitCode === 0)), evidence: [evidence.source] }; }); },
    }) };
  return { github, readHandler: githubBundleReadHandler(repositories),
    /** Current artifact fence; it grants no execution or publication by itself. */
    current(id: string): { ref: Ref; active: boolean } | null { if (!/^bundle_[a-f0-9]{64}$/.test(id) || !existsSync(join(artifacts, id))) return null; const ref = { id, revision: 1, generation: 1 }; try { bundle(ref); return { ref, active: true }; } catch { return { ref, active: false }; } },
  };
}

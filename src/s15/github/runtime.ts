import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import type { Ref } from '../policy';
import type { S15CompositionOptions } from '../composition';
import { GithubApiGateway } from './github-api';
import { ProtectedGithubPush } from './push';
import { createGithubVmWorkspace } from './workspace';
import { createGithubPreload, githubBundleMaxBytes, githubBundleReadHandler } from './composition';
import type { GithubLimits, GithubProduction, GithubRepository, ProtectedGithubGateway } from './types';
import { canonical } from './validation';

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
  const repositories = config.repositories.map(r => r.repository);
  const credential = (repo: GithubRepository) => { const r = config.repositories.find(r => r.repository.resource.id === repo.resource.id); if (!r) throw new AppError('outside_scope'); return input.credential(r.credentialRef); };
  return composeGithubRuntime(config, input, repositories, credential, push => new GithubApiGateway({ repositories, credential, production: repo => config.repositories.find(r => r.repository.resource.id === repo.resource.id)?.production ?? { consequence: 'unknown', fence: null, evidence: [] }, push }));
}

function composeGithubRuntime(config: Omit<GithubRuntimeConfig, 'repositories'>, input: { directory: string; vmId: string; route: S15CompositionOptions['conversation']['route']; modelCallUpperBound: S15CompositionOptions['conversation']['modelCallUpperBound'] },
  repositories: readonly GithubRepository[], credential: (repository: GithubRepository) => string, gatewayFor: (push: ProtectedGithubPush) => ProtectedGithubGateway) {
  const artifacts = join(input.directory, 'github-artifacts'); mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const path = (ref: Ref) => { if (!/^bundle_[a-f0-9]{64}$/.test(ref.id) || ref.revision !== 1 || ref.generation !== 1) throw new AppError('artifact_unavailable'); return join(artifacts, ref.id); };
  const bundle = (ref: Ref) => { const p = path(ref), stat = lstatSync(p); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > config.maxBundleBytes) throw new AppError('artifact_unavailable'); const bytes = readFileSync(p); if (createHash('sha256').update(bytes).digest('hex') !== ref.id.slice(7)) throw new AppError('artifact_unavailable'); return bytes; };
  const gateway = gatewayFor(new ProtectedGithubPush({ bundle }));
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

/** GIT15-04 product defaults for a Web-connected account. No acceptance command or production profile is inferred, so
 * criteria never pass automatically and every merge keeps its production and evidence gates (ADR 0073). */
export const s15GithubWebDefaults: Omit<GithubRuntimeConfig, 'repositories' | 'catalogPurpose'> = Object.freeze({
  limits: { snapshotMaxAgeMs: 120_000, waitMs: 60_000, stallMs: 6 * 3_600_000, maxNoProgress: 3, maxAttempts: 6,
    // One read is either a bounded snapshot or a repository bundle, which the protected preload accepts up to
    // `githubBundleMaxBytes`; the reserved bound covers the largest accepted read so a settlement never overruns it.
    readUpperBound: { attempts: 0, steps: 0, calls: 1, reads: 1, outputBytes: githubBundleMaxBytes, activeMs: 60_000, spendMinor: '0' },
    actionUpperBound: { attempts: 0, steps: 0, calls: 1, reads: 0, outputBytes: 1_048_576, activeMs: 60_000, spendMinor: '0' } },
  // A repository's own test command can't be inferred. The default records only a whitespace sanity check of the
  // reviewable commit; no acceptance criterion is ever satisfied by it, so merges stay held for evidence.
  tests: [{ command: 'git diff --check HEAD~1 HEAD', timeoutMs: 60_000 }], criteria: [], maxTurns: 24, activeMs: 1_800_000, maxBundleBytes: 256 * 1_048_576,
});

/** Read-only array view whose contents are re-read from `read` on every access; no copy is kept. */
function liveList<T>(read: () => readonly T[]): readonly T[] {
  return new Proxy([] as T[], { get: (_target, key) => { const current = read(), value = Reflect.get(current, key); return typeof value === 'function' ? value.bind(current) : value; },
    has: (_target, key) => Reflect.has(read(), key), ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, key) => { const d = Reflect.getOwnPropertyDescriptor(read(), key); return d ? { ...d, configurable: true } : undefined; } });
}

/**
 * GIT15-04: the GitHub runtime over the protected Web connection. Repositories are the owner's live selection and the
 * credential is the vault token, both read at each use, so connecting, selecting or removing applies without a restart
 * or configuration edit. A selection change rebuilds the fixed-origin gateway for exactly the new repository set; the
 * production consequence stays unknown, so a merge always keeps its production gate.
 */
export function githubConnectionRuntime(input: {
  directory: string; vmId: string; route: S15CompositionOptions['conversation']['route'];
  modelCallUpperBound: S15CompositionOptions['conversation']['modelCallUpperBound'];
  repositories(): readonly GithubRepository[]; credential(): string; catalogPurpose: Ref; fetch?: typeof fetch; now?: () => number;
}) {
  const live = liveList(input.repositories);
  const credential = (repo: GithubRepository) => { if (!input.repositories().some(r => canonical(r) === canonical(repo))) throw new AppError('outside_scope'); return input.credential(); };
  return composeGithubRuntime({ ...structuredClone(s15GithubWebDefaults), catalogPurpose: input.catalogPurpose }, input, live, credential, push => {
    let cached: { key: string; gateway: GithubApiGateway } | null = null;
    const current = () => { const repos = input.repositories(), key = canonical(repos); if (!cached || cached.key !== key) cached = { key, gateway: new GithubApiGateway({ repositories: repos, credential, production: () => ({ consequence: 'unknown', fence: null, evidence: [] }), push, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.now ? { now: input.now } : {}) }) }; return cached.gateway; };
    return { snapshot: (repo, pull, issue) => current().snapshot(repo, pull, issue), mutate: (effect, dispatch) => current().mutate(effect, dispatch), reconcile: effect => current().reconcile(effect) };
  });
}

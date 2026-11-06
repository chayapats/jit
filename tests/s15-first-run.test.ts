import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { firstRunFixture, fixtureToken } from './fixtures/s15-first-run';
import { composeS15, type S15CompositionOptions } from '../src/s15/composition';
import { githubResourceId } from '../src/s15/github/connection';

const fixtures: Awaited<ReturnType<typeof firstRunFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const fixture = async (tune?: Parameters<typeof firstRunFixture>[0]) => { const f = await firstRunFixture(tune); fixtures.push(f); return f; };
const hashIn = (html: string, name: string) => new RegExp(`name="${name}" value="([a-f0-9]{64})"`).exec(html)?.[1];
/** Every file under a directory, for "the token is nowhere but the vault". */
const files = (root: string): string[] => readdirSync(root).flatMap(name => { const p = join(root, name); return statSync(p).isDirectory() ? files(p) : [p]; });

async function install(f: Awaited<ReturnType<typeof firstRunFixture>>, back: 'setup' | 'rules' = 'setup') {
  const page = await f.page(back === 'setup' ? '/setup' : '/rules', 'en');
  const proposalHash = hashIn(page.html, 'proposalHash'), listHash = hashIn(page.html, 'listHash');
  expect(proposalHash).toBeDefined();
  return f.form('/s15/forms/rules/install', { proposalHash: proposalHash!, ...(listHash ? { listHash } : {}), return: back });
}

test('POLICY15-02: a fresh installer config shows an installable default proposal and one click enables a tool-backed conversation', async () => {
  const f = await fixture();
  expect(f.config.policy).toBeNull(); expect(f.config.github).toBeNull();
  // Nothing is installed until the owner presses the button; work is refused honestly before that.
  expect(f.service.policy.owner.current(f.owner())).toBeNull();
  const setup = await f.page('/setup', 'en');
  expect(setup.status).toBe(200);
  expect(setup.html).toContain('Standing rules Jit proposes for this installation');
  expect(setup.html).toContain('No money budget needed');
  expect(setup.html).toContain('No personal GitHub exception');
  expect(setup.html).toContain('OpenAI Codex');
  expect(setup.html).toContain('No GitHub repository is connected.');
  const proposal = f.service.policy.owner.proposePolicy(f.owner(), null); expect(proposal.installable).toBe(false);
  const installed = await install(f);
  expect(installed.status).toBe(200); expect(installed.html).toContain('Standing rules r1 are now in use');
  const policy = f.service.policy.owner.current(f.owner())!;
  // The exact rows: the installation's own Bot, purposes, computer pool, approved route and its provider recipient only.
  expect(policy.bots.map(r => r.id)).toEqual(['jit']);
  expect(policy.purposes.map(r => r.id)).toEqual(['owner_requested_work', 'conversation_interpretation']);
  expect(policy.interpretationPurpose?.id).toBe('conversation_interpretation');
  // The provisioned protected browser (BROW15-02) is composed, so it is a row too.
  expect(policy.resources.map(r => r.id)).toEqual(['computer', 'browser']);
  expect(policy.rules[0]!.adapters).toEqual(['private_disclosure', 'protected_browser', 'working_vm']);
  expect(policy.recipients.map(r => r.id)).toEqual(['codex_provider']);
  expect(policy.selections).toEqual([f.config.conversation.selection]);
  expect(policy.budget).toBeNull();
  expect(policy.rules.map(r => r.mode)).toEqual(['ordinary', 'owner_named_send']);
  expect(policy.rules.some(r => r.mode.startsWith('personal_github'))).toBe(false);
  expect(policy.expiresAt - f.now).toBeGreaterThan(179 * 86_400_000); expect(policy.expiresAt - f.now).toBeLessThanOrEqual(180 * 86_400_000);
  // The same click registered the exact TEAM list, so setup has nothing left.
  expect(f.service.team.currentResource('computer')?.active).toBe(true); expect(f.service.team.currentResource('browser')?.active).toBe(true);
  const row = await f.chat('Run the requested command in the working computer');
  expect(row.state).toBe('completed'); expect(row.evidence[0]?.tool).toBe('bash'); expect(row.evidence[0]?.content).toContain('first-run');
  expect(f.vmCalls).toContain('spawn');
  expect(f.service.policy.control.reservations().every(r => r.upperBound.spendMinor === '0')).toBe(true);
});

test('POLICY15-02: a metered route needs the owner\'s finite budget, which becomes part of the exact hash', async () => {
  const f = await fixture();
  Object.assign(f.routes[0]!, { charge: 'metered', currency: 'USD', upperBound: { ...f.routes[0]!.upperBound!, spendMinor: '5' } });
  const page = await f.page('/setup', 'en');
  expect(page.html).toContain('A model here charges per use'); expect(page.html).not.toContain('name="proposalHash"');
  const refused = await f.form('/s15/forms/rules/review', { amount: '0', currency: 'USD', periodId: 'days_30', return: 'setup' });
  expect(refused.status).toBe(409);
  const reviewed = await f.form('/s15/forms/rules/review', { amount: '12.50', currency: 'USD', periodId: 'days_30', return: 'setup' });
  expect(reviewed.status).toBe(303);
  const first = hashIn((await f.page('/setup', 'en')).html, 'proposalHash'); expect(first).toBeDefined();
  await f.form('/s15/forms/rules/review', { amount: '13.00', currency: 'USD', periodId: 'days_30', return: 'setup' });
  const second = hashIn((await f.page('/setup', 'en')).html, 'proposalHash'); expect(second).toBeDefined(); expect(second).not.toBe(first);
  const done = await f.form('/s15/forms/rules/install', { proposalHash: second!, return: 'setup' }); expect(done.status).toBe(200);
  const policy = f.service.policy.owner.current(f.owner())!;
  expect(policy.budget).toMatchObject({ currency: 'USD', ceiling: { spendMinor: '1300' } });
  expect(policy.budget!.expiresAt - policy.budget!.startsAt).toBe(30 * 86_400_000);
  // F: once installed, the same metered rules read as current; no new amount is asked for until a change or renewal.
  const rules = await f.page('/rules', 'en');
  expect(rules.html).toContain('Standing rules in use'); expect(rules.html).not.toContain('Updated standing rules to review'); expect(rules.html).not.toContain('name="proposalHash"');
  expect((await f.page('/setup', 'en')).html).not.toContain('Updated standing rules to review');
});

test('POLICY15-02: metered routes in different currencies cannot share one budget and say why', async () => {
  const f = await fixture();
  const other = { selection: { route: { id: 'grok_route', revision: 1, generation: 1 }, model: { id: 'grok_model', revision: 1, generation: 1 }, effort: 'high' }, recipient: { id: 'grok_provider', revision: 1, generation: 1 } };
  for (const [kind, ref] of [['route', other.selection.route], ['model', other.selection.model], ['recipient', other.recipient]] as const) f.config.catalog.push({ kind, ref, active: true });
  Object.assign(f.routes[0]!, { charge: 'metered', currency: 'USD', upperBound: { ...f.routes[0]!.upperBound!, spendMinor: '5' } });
  f.routes.push({ ...structuredClone(f.routes[0]!), ...other, provider: 'grok', modelId: 'grok-5', account: { id: 'grok_account', revision: 1, generation: 1 }, currency: 'EUR' });
  const page = await f.page('/setup', 'en');
  expect(page.html).toContain('priced in different currencies'); expect(page.html).not.toContain('name="proposalHash"');
  // Neither currency is offered, and a typed amount in either is refused.
  for (const currency of ['USD', 'EUR']) expect((await f.form('/s15/forms/rules/review', { amount: '10', currency, periodId: 'days_30', return: 'setup' })).status).toBe(409);
  expect(hashIn((await f.page('/setup', 'en')).html, 'proposalHash')).toBeUndefined();
  // A metered route that states no currency cannot be under a money budget either.
  f.routes.pop(); delete (f.routes[0] as { currency?: string }).currency;
  expect((await f.page('/setup', 'en')).html).toContain('does not state its currency');
});

test('POLICY15-02: a subscription route that is not signed in cannot be installed and says why', async () => {
  const f = await fixture();
  f.routes[0]!.availability = 'unavailable';
  const page = await f.page('/setup', 'en');
  expect(page.html).not.toContain('name="proposalHash"');
  expect(page.html).toContain('The model account isn’t signed in');
});

test('POLICY15-02: expiry is finite and renewable; an expired policy blocks new work with the policy code', async () => {
  const f = await fixture();
  await install(f);
  const first = f.service.policy.owner.current(f.owner())!;
  expect((await f.page('/rules', 'en')).html).toContain('Standing rules in use');
  f.advance(first.expiresAt - f.now + 1000);
  const blocked = await f.chat('Run the requested command in the working computer');
  expect(blocked.state).not.toBe('completed'); expect(JSON.stringify(blocked)).toContain('expired');
  const rules = await f.page('/rules', 'en'); expect(rules.html).toContain('Your standing rules have expired'); expect(rules.html).toContain('Renew these rules');
  const renewed = await install(f, 'rules'); expect(renewed.status).toBe(303);
  const second = f.service.policy.owner.current(f.owner())!;
  expect(second.revision).toBe(first.revision + 1); expect(second.expiresAt).toBeGreaterThan(f.now + 179 * 86_400_000);
  expect({ ...second, revision: 0, expiresAt: 0, rules: second.rules.map(r => ({ ...r, expiresAt: 0 })) }).toEqual({ ...first, revision: 0, expiresAt: 0, rules: first.rules.map(r => ({ ...r, expiresAt: 0 })) });
  expect((await f.chat('Run the requested command in the working computer')).state).toBe('completed');
});

test('GIT15-04: Web token connect, repository selection, updated proposal and readiness; the token is never echoed', async () => {
  const f = await fixture();
  await install(f);
  const empty = await f.page('/resources/github', 'en'); expect(empty.html).toContain('Check and connect'); expect(empty.html).toContain('Administration: Read-only');
  const classic = await f.form('/s15/forms/github-connection/connect', { token: 'ghp_' + 'x'.repeat(36) }); expect(classic.status).toBe(409); expect(classic.html).toContain('classic token');
  const wrong = await f.form('/s15/forms/github-connection/connect', { token: 'github_pat_' + 'Z'.repeat(60) }); expect(wrong.status).toBe(409); expect(wrong.html).toContain('didn’t accept this token');
  const connected = await f.form('/s15/forms/github-connection/connect', { token: fixtureToken }); expect(connected.status).toBe(303);
  const page = await f.page('/resources/github', 'en');
  expect(page.html).toContain('Connected as chayapats'); expect(page.html).toContain('chayapats/jit-s15-sandbox'); expect(page.html).not.toContain(fixtureToken);
  expect(f.github.calls.every(c => c.method === 'GET')).toBe(true);
  const revision = /name="revision" value="(\d+)"/.exec(page.html)![1]!;
  const index = /name="(repo_\d+)" value="chayapats\/jit-s15-sandbox"/.exec(page.html)![1]!;
  expect((await f.form('/s15/forms/github-connection/select', { revision, [index]: 'chayapats/jit-s15-sandbox' })).status).toBe(303);
  const repository = f.service.githubConnections!.repositories()[0]!;
  expect(repository).toMatchObject({ name: 'chayapats/jit-s15-sandbox', target: 'main' });
  // The installed rules don't cover the new repository until the owner installs the updated proposal.
  const rules = await f.page('/rules', 'en'); expect(rules.html).toContain('Updated standing rules to review'); expect(rules.html).toContain('chayapats/jit-s15-sandbox');
  expect((await install(f, 'rules')).status).toBe(303);
  const policy = f.service.policy.owner.current(f.owner())!;
  expect(policy.resources.map(r => r.id)).toEqual(['computer', 'browser', repository.resource.id]);
  expect(policy.recipients.map(r => r.id).sort()).toEqual(['codex_provider', 'github_service']);
  expect(policy.rules.some(r => r.mode.startsWith('personal_github'))).toBe(false);
  // Readiness is report-only and runs through the composed runtime with the vault token.
  f.interpretation = { intent: 'inspect', purposeId: 'owner_requested_work', resourceIds: [repository.resource.id], access: 'read', subject: null };
  f.script = [{ type: 'tool_call', id: 'ready', name: 'github_readiness', arguments: {} }];
  const report = await f.chat('Inspect GitHub issues and report readiness only');
  expect(report.state).toBe('completed'); expect(report.evidence[0]?.content).toContain('waitingForSelection');
  expect(f.github.calls.some(c => c.path.startsWith('/repos/chayapats/jit-s15-sandbox/issues'))).toBe(true);
  expect(f.github.calls.filter(c => c.method !== 'GET' && c.path !== '/graphql')).toHaveLength(0);
  // Token custody: the vault file holds it; no other protected file, page or prompt does.
  const holders = files(f.parent).filter(path => readFileSync(path).includes(fixtureToken));
  expect(holders).toHaveLength(1); expect(holders[0]!.startsWith(join(f.parent, 'vault'))).toBe(true);
  expect(f.prompts.some(p => p.includes(fixtureToken))).toBe(false);
  for (const path of ['/resources/github', '/rules', '/setup', '/resources/accounts']) expect((await f.page(path)).html).not.toContain(fixtureToken);
});

test('GIT15-04: unselected repositories are refused and removal stops new GitHub work while history stays', async () => {
  const f = await fixture();
  await install(f);
  await f.form('/s15/forms/github-connection/connect', { token: fixtureToken });
  let page = await f.page('/resources/github', 'en');
  const index = /name="(repo_\d+)" value="chayapats\/jit-s15-sandbox"/.exec(page.html)![1]!;
  const denied = await f.form('/s15/forms/github-connection/select', { revision: /name="revision" value="(\d+)"/.exec(page.html)![1]!, repo_0: 'chayapats/not-accessible' });
  expect(denied.status).toBe(409);
  page = await f.page('/resources/github', 'en');
  await f.form('/s15/forms/github-connection/select', { revision: /name="revision" value="(\d+)"/.exec(page.html)![1]!, [index]: 'chayapats/jit-s15-sandbox' });
  await install(f, 'rules');
  const repository = f.service.githubConnections!.repositories()[0]!;
  // A repository the token can reach but the owner did not tick is not a resource and its work is refused.
  const other = githubResourceId('chayapats/other-repo');
  expect(f.service.githubConnections!.resource(other)).toBeNull();
  f.interpretation = { intent: 'inspect', purposeId: 'owner_requested_work', resourceIds: [other], access: 'read', subject: null };
  f.script = [{ type: 'tool_call', id: 'ready', name: 'github_readiness', arguments: {} }];
  const outside = await f.chat('Inspect GitHub issues of chayapats/other-repo');
  expect(outside.state).not.toBe('completed'); expect(f.github.calls.some(c => c.path.includes('other-repo'))).toBe(false);
  page = await f.page('/resources/github', 'en');
  expect((await f.form('/s15/forms/github-connection/remove', { revision: /name="revision" value="(\d+)"/.exec(page.html)![1]! })).status).toBe(303);
  expect(f.service.githubConnections!.repositories()).toEqual([]);
  expect(f.service.githubConnections!.resource(repository.resource.id)?.active).toBe(false);
  expect(() => f.service.githubConnections!.credential()).toThrow();
  f.interpretation = { intent: 'inspect', purposeId: 'owner_requested_work', resourceIds: [repository.resource.id], access: 'read', subject: null };
  f.script = [{ type: 'tool_call', id: 'ready', name: 'github_readiness', arguments: {} }];
  const before = f.github.calls.length, refused = await f.chat('Inspect GitHub issues and report readiness only');
  expect(refused.state).not.toBe('completed'); expect(f.github.calls.length).toBe(before);
  expect((await f.page('/resources/github', 'en')).html).toContain('Disconnected');
  // The connection history keeps every revision.
  expect(f.service.githubConnections!.current()).toMatchObject({ state: 'removed', login: 'chayapats' });
});

test('GIT15-04: an installation created before the GitHub store existed adds it once on reopen and refuses a missing listed ledger', async () => {
  const withoutGithub = (options: S15CompositionOptions) => { const { githubWeb: _, ...rest } = options; return rest; };
  const f = await fixture(withoutGithub);
  const manifest = () => JSON.parse(readFileSync(join(f.directory, 'composition.json'), 'utf8'));
  expect(manifest().stores).not.toContain('github.sqlite');
  await f.reopen(options => options);
  expect(manifest().stores).toContain('github.sqlite');
  expect(f.service.githubConnections).toBeDefined();
  await f.reopen(options => options);
  expect(manifest().stores).toContain('github.sqlite');
  // Once listed, a missing GitHub ledger refuses instead of being recreated.
  await f.service.close(); unlinkSync(join(f.directory, 'github.sqlite'));
  await expect(composeS15({ ...withoutGithub(f.options(false)), githubWeb: f.options(false).githubWeb! })).rejects.toThrow(); expect(existsSync(join(f.directory, 'github.sqlite'))).toBe(false);
  f.abandon();
});

test('POLICY15-02/GIT15-04: Thai and English pages render the review and the GitHub connect form', async () => {
  const f = await fixture();
  const th = await f.page('/setup', 'th'); expect(th.html).toContain('กฎประจำที่จิตเสนอสำหรับเครื่องนี้'); expect(th.html).toContain('ไม่ต้องตั้งงบเงิน'); expect(th.html).toContain('ไม่มีข้อยกเว้น GitHub ส่วนตัว');
  const en = await f.page('/setup', 'en'); expect(en.html).toContain('Standing rules Jit proposes for this installation');
  const ghTh = await f.page('/resources/github', 'th'); expect(ghTh.html).toContain('ตรวจและเชื่อม'); expect(ghTh.html).toContain('type="password"'); expect(ghTh.html).not.toContain('value="github_pat_');
  const ghEn = await f.page('/resources/github', 'en'); expect(ghEn.html).toContain('Check and connect');
});

/** Connect the fixture token and select exactly `names` through the Web forms. */
async function selectRepos(f: Awaited<ReturnType<typeof firstRunFixture>>, names: string[]) {
  if (f.service.githubConnections!.current()?.state !== 'connected') await f.form('/s15/forms/github-connection/connect', { token: fixtureToken });
  const page = await f.page('/resources/github', 'en'), fields: Record<string, string> = { revision: /name="revision" value="(\d+)"/.exec(page.html)![1]! };
  const boxes = [...page.html.matchAll(/name="(repo_\d+)" value="([^"]+)"/g)];
  for (const name of names) fields[boxes.find(m => m[2] === name)![1]!] = name;
  expect((await f.form('/s15/forms/github-connection/select', fields)).status).toBe(303);
}
const readiness = async (f: Awaited<ReturnType<typeof firstRunFixture>>, id: string) => {
  f.interpretation = { intent: 'inspect', purposeId: 'owner_requested_work', resourceIds: [id], access: 'read', subject: null };
  f.script = [{ type: 'tool_call', id: 'ready', name: 'github_readiness', arguments: {} }];
  return f.chat('Inspect GitHub issues and report readiness only');
};

test('GIT15-04: a repository selected again after unselecting gets a new identity the owner registers in one reviewed press', async () => {
  const f = await fixture();
  await install(f); await selectRepos(f, ['chayapats/jit-s15-sandbox']); await install(f, 'rules');
  const first = f.service.githubConnections!.repositories()[0]!.resource;
  expect(f.service.team.currentResource(first.id)?.ref).toEqual(first);
  await selectRepos(f, []); await selectRepos(f, ['chayapats/jit-s15-sandbox']);
  const second = f.service.githubConnections!.repositories()[0]!.resource;
  expect(second).toEqual({ id: first.id, revision: first.revision + 1, generation: first.generation + 1 });
  // The live identity wins over the older TEAM row; until the owner reviews it, work on the repository is refused.
  expect(f.service.policy.owner.current(f.owner())!.resources.some(r => r.id === first.id && r.generation === first.generation)).toBe(true);
  expect((await readiness(f, first.id)).state).not.toBe('completed');
  const rules = await f.page('/rules', 'en'); expect(rules.html).toContain('Updated standing rules to review'); expect(hashIn(rules.html, 'listHash')).toBeDefined();
  expect((await install(f, 'rules')).status).toBe(303);
  expect(f.service.policy.owner.current(f.owner())!.resources.find(r => r.id === first.id)).toEqual(second);
  const row = f.service.team.resourceRecord(first.id)!; expect({ revision: row.revision, generation: row.generation }).toEqual({ revision: second.revision, generation: second.generation });
  expect((await readiness(f, first.id)).state).toBe('completed');
});

test('GIT15-04: a repository bundle between the old 4 MiB charge and the 16 MiB accepted limit settles without stopping later work', async () => {
  const { s15GithubWebDefaults } = await import('../src/s15/github/runtime');
  const { createGithubPreload, githubBundleMaxBytes } = await import('../src/s15/github/composition');
  expect(s15GithubWebDefaults.limits.readUpperBound.outputBytes).toBe(githubBundleMaxBytes);
  const f = await fixture();
  await install(f); await selectRepos(f, ['chayapats/jit-s15-sandbox']); await install(f, 'rules');
  const repository = f.service.githubConnections!.repositories()[0]!;
  const report = await readiness(f, repository.resource.id); expect(report.state).toBe('completed');
  const limits: number[] = [], size = 8 * 1024 * 1024;
  const fetchBundle = (async (_repo: unknown, _secret: unknown, _signal: unknown, allowed: () => void, _transport: unknown, l: { packBytes: number }) => {
    limits.push(l.packBytes); allowed(); if (size > l.packBytes) throw new Error('coding_preload_size_limit'); return new Uint8Array(size);
  }) as never;
  const selection = { id: 'selection_fixture', workId: report.authority!.id, repository, base: 'a'.repeat(40), branch: 'jit/issue-7', requestId: 'r', issue: 7, issueVersion: 'v', createdAt: 0, state: 'implementing', evidence: null } as const;
  const backend = { workspaceRoot: '/w', async writeFileAtomically() { throw new Error('stop after the read'); } } as never;
  const preload = (upperBound: typeof s15GithubWebDefaults.limits.readUpperBound) => createGithubPreload({ policy: f.service.policy, repositories: [repository], credential: () => f.service.githubConnections!.credential(), upperBound, fetchBundle });
  // The old 4 MiB reservation now caps the broker itself, so the larger bundle is refused before it is accepted.
  await expect(preload({ ...s15GithubWebDefaults.limits.readUpperBound, outputBytes: 4 * 1024 * 1024 })(backend, selection as never, () => {})).rejects.toThrow('coding_preload_size_limit');
  await expect(preload(s15GithubWebDefaults.limits.readUpperBound)(backend, selection as never, () => {})).rejects.toThrow('stop after the read');
  expect(limits).toEqual([4 * 1024 * 1024, githubBundleMaxBytes]);
  expect(f.service.policy.control.reservations(report.authority!.id).some(r => r.actual.outputBytes === size)).toBe(true);
  // No overrun was recorded: the next charges of the installation still run.
  expect((await readiness(f, repository.resource.id)).state).toBe('completed');
});

test('GIT15-04: Web-selected repository content is private lineage, approved only for the provider and GitHub', async () => {
  const f = await fixture();
  await install(f); await selectRepos(f, ['chayapats/jit-s15-sandbox']); await install(f, 'rules');
  const repository = f.service.githubConnections!.repositories()[0]!;
  const report = await readiness(f, repository.resource.id); expect(report.state).toBe('completed');
  const work = f.service.policy.work.guard(f.service.policy.control.bindWork(report.authority!.id));
  const source = f.service.githubConnections!.sources()[0]!.source;
  expect(source).toMatchObject({ classification: 'private', resource: repository.resource, ownerReleasable: true });
  const disclosure = f.service.disclosure!, gate = disclosure.catalogs({ current: () => null, allows: () => true });
  const action = (recipient: string) => ({ recipients: [{ id: recipient, revision: 1, generation: 1 }], payload: { contract: 'fixture' }, classes: ['ordinary_edit'] }) as never;
  // Repository lineage reaching a recipient with no approval is held; the provider and GitHub are approved.
  expect(gate.allows(work, action('somewhere_else'))).toBe(false);
  const model = disclosure.model(() => 'inference_0');
  expect(model.allows(work, f.routes[0]!)).toBe(true);
  // Unselecting removes future approvals but never declassifies existing lineage.
  await selectRepos(f, []);
  expect(f.service.githubConnections!.source(source.ref)).toMatchObject({ classification: 'private', active: true });
  expect(model.allows({ ...work, request: { ...work.request } }, f.routes[0]!)).toBe(false);
});

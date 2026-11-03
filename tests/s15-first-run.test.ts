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
  expect(policy.rules.map(r => r.mode)).toEqual(['ordinary']);
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

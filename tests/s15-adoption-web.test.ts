import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../src/errors';
import { s15AdoptionPort } from '../src/s15/web';
import { adoptionFixture, prepare } from './fixtures/s15-adoption';
import { webFixture, origin } from './fixtures/s15-web';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

test('recovery reads real adoption status across restart without activity, control commands or private history', async () => {
  const f = await adoptionFixture(); cleanups.push(() => f.cleanup());
  let service = f.open();
  const web = webFixture(() => ({ adoption: s15AdoptionPort({ status: actor => service.status(actor) }, actor => {
    if (actor !== web.actor) throw new AppError('authentication_required', 401);
    return service.authenticate('owner_session');
  }) })); cleanups.push(() => web.cleanup());
  const html = async () => (await web.get('/recovery')).text();
  expect(web.ports.adoption!(web.actor)).toBeNull();
  expect(await html()).toContain('s15-adoption-t');
  expect(() => web.ports.adoption!({ ownerId: 'owner' })).toThrow('authentication_required');
  const staged = prepare(service, f.options).status;
  const before = readFileSync(join(f.options.directory, 'adoption.sqlite'));
  for (const restart of [false, true]) {
    if (restart) { f.close(); service = f.open(); }
    expect(web.ports.adoption!(web.actor)).toEqual(staged);
    const page = await html();
    expect(page).toContain(staged.report.targetBuild.commit);
    expect(page).not.toContain('Private S14 owner knowledge');
    expect(page).not.toContain(staged.rollbackHash);
    expect(service.status(service.authenticate('owner_session'))?.activityRecorded).toBe(false);
    expect(readFileSync(join(f.options.directory, 'adoption.sqlite'))).toEqual(before);
  }
  const anonymous = await web.handler(new Request(`${origin}/recovery`, { headers: { host: 'jit.test' } }));
  expect(anonymous.status).toBe(303);
});

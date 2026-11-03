import { expect, test } from 'bun:test';
import { liveRouteAvailability } from '../src/s15/model/availability';
import { runtimeDisclosure } from '../src/s15/disclosure/runtime';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import type { ApprovedModelRoute } from '../src/s15/model';

const approved = (): ApprovedModelRoute => ({ ...s15StageConfig('/protected/installation', 'http://127.0.0.1:3002').models[0]!, availability: 'available' });

test('an approved subscription route follows the identity sign-in state without any configuration edit', async () => {
  let status = 'needs-login';
  const live = liveRouteAvailability(async () => ({ status: status as never })), route = approved();
  // Before the first readiness read the route is never dispatchable.
  expect(live.apply(route).availability).toBe('unavailable');
  await live.refresh([route]); expect(live.apply(route).availability).toBe('unavailable');
  status = 'configured-unverified'; await live.refresh([route]);
  expect(live.apply(route)).toBe(route);
  status = 'quota-exceeded'; await live.refresh([route]); expect(live.apply(route).availability).toBe('quota');
  status = 'store-unavailable'; await live.refresh([route]); expect(live.apply(route).availability).toBe('unavailable');
  status = 'configured-unverified'; await live.refresh([route]); expect(live.apply(route).availability).toBe('available');
  // A failing or hanging store read is unavailable, never a stale success.
  const broken = liveRouteAvailability(async () => { throw new Error('locked'); }); await broken.refresh([route]);
  expect(broken.apply(route).availability).toBe('unavailable');
});

test('configured holds and metered routes are never widened by a signed-in identity', async () => {
  const live = liveRouteAvailability(async () => ({ status: 'configured-unverified' }));
  const held = { ...approved(), availability: 'unavailable' as const }, quota = { ...approved(), availability: 'quota' as const }, metered = { ...approved(), charge: 'metered' as const };
  await live.refresh([held, quota, metered]);
  expect(live.apply(held)).toBe(held); expect(live.apply(quota)).toBe(quota); expect(live.apply(metered)).toBe(metered);
});

test('disclosure resolves a model route whatever its live availability', () => {
  const route = approved(), disclosure = runtimeDisclosure({ sources: [], approvals: [], githubRecipient: null, googleRecipient: null, browser: [], acquisitions: [], registries: [] }, [route], { current: () => null, allows: () => true }, []);
  expect(disclosure.modelRoute({ ...route, availability: 'unavailable' })).toBe('inference_0');
  expect(() => disclosure.modelRoute({ ...route, modelId: 'other-model' })).toThrow('route_unknown');
});

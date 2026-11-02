import { PolicyError, type OwnerActor } from '../policy';
import type { ModelService } from './types';

/** Read-only opt-in JSON mount. The adapter authenticates the real Host/Origin/session boundary;
 * no model, account, pin or budget mutation is exposed. */
export function createModelProjectionHandler(service: ModelService, authenticate: (request: Request) => OwnerActor): (request: Request) => Response {
  return request => {
    try {
      const owner = authenticate(request);
      if (request.method !== 'GET') return Response.json({ code: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET' } });
      const url = new URL(request.url); if (url.pathname !== '/s15/models') return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json(service.project(owner, url.searchParams.get('workId') ?? undefined), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return Response.json({ code: error instanceof PolicyError ? error.code : 'authentication_required' }, { status: error instanceof PolicyError && error.code !== 'authentication_required' ? 409 : 401, headers: { 'Cache-Control': 'no-store' } }); }
  };
}

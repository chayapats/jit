import { PolicyError, type OwnerActor } from '../policy';
import type { ResponsibilityPort } from './types';

/** Read-only owner JSON mount; the host supplies its real authentication boundary. Queries never
 * start/retry a VM, native run, event, stop or external effect. */
export function createResponsibilityProjectionHandler(service: ResponsibilityPort, authenticate: (request: Request) => OwnerActor): (request: Request) => Response {
  return request => {
    try {
      const owner = authenticate(request);
      if (request.method !== 'GET') return Response.json({ code: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET' } });
      const match = /^\/s15\/responsibilities\/([A-Za-z0-9_-]{1,128})$/.exec(new URL(request.url).pathname);
      if (!match) return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json(service.project(owner, match[1]!), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return Response.json({ code: error instanceof PolicyError ? error.code : 'authentication_required' }, { status: error instanceof PolicyError && error.code !== 'authentication_required' ? 409 : 401, headers: { 'Cache-Control': 'no-store' } }); }
  };
}

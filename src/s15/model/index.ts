/** MODEL15 opt-in host API. Registry, owner pins and protected ports never enter model prompts. */
export { openModelService, routeControls } from './service';
export { closeCredentialLifecycle, CREDENTIAL_CLOSE_BOUND_MS, routeCredentialGuard } from './credentials';
export { summarizeReservations } from './usage';
export { createModelProjectionHandler } from './http';
export type * from './types';

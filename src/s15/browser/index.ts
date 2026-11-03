/** Protected S15 host-only browser composition; S14 remains the default. */
export type * from './types';
export type { BrowserClock } from './gateway';
export { registerProtectedBrowser } from './gateway';
export { BrowserError } from './validation';
export { protectedBrowserTools } from './tools';
export { ProtectedChromium, protectedChromiumBuilds, provisionedEngineFactory, type ProtectedChromiumBuild, type ProtectedChromiumCode, type ProtectedChromiumPorts, type ProtectedChromiumStatus, type ProtectedChromiumStep } from './chromium';
export { ApprovedWebsites, approvedWebsiteHistoryLimit, approvedWebsiteLimit, approvedWebsiteOrigin, approvedWebsitePolicy, withApprovedWebsites, type ApprovedWebsite } from './sites';
export { openProvisionedBrowser, provisionedBrowserResource, provisionedBrowserUpperBound, type ProvisionedBrowser } from './provisioned';

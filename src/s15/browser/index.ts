/** Protected S15 host-only browser composition; S14 remains the default. */
export type * from './types';
export type { BrowserClock } from './gateway';
export { registerProtectedBrowser } from './gateway';
export { BrowserError } from './validation';
export { protectedBrowserTools } from './tools';

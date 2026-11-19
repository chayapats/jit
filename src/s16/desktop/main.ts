import { desktopInstallation, selectDesktopService } from "./installation";
import { openDesktopConnection } from "./connection";
import { connectDesktopWindow, openDesktopSession } from "./launcher";
// Trusted native-host exports are used by the installed runtime and its conformance runner, never exposed to pages.
export { connectDesktopWindow, openDesktopSession, openDesktopConnection };

/**
 * Installed entry: choose only a service in a credential-free browser, destroy that browser, then open the separate
 * authenticated profile. No secret, callback, generic command or native bridge crosses between the two contexts.
 */
export async function runInstalledDesktop(root: string): Promise<void> {
  const installation = desktopInstallation(root); let service = installation.service;
  if (!service) {
    const connection = await openDesktopConnection({ browser: installation.browser, locale: installation.locale });
    try { service = await connection.choice; } finally { await connection.close(); }
    selectDesktopService(root, service);
  }
  const session = await openDesktopSession({ root, service, browser: installation.browser, locale: installation.locale });
  try { const connected = await connectDesktopWindow(session); await connected.ready; await session.closed; }
  finally { await session.close(); }
}

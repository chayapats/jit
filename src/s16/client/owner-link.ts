/** Optional native presentation capability. `opened` never means signed in, connected, executed or approved. */
export async function nativeOwnerLink(url: string): Promise<boolean | null> {
  const host = globalThis as unknown as { jitDesktopOwnerLink?: (url: string) => Promise<unknown> };
  if (typeof host.jitDesktopOwnerLink !== "function") return null;
  try { const value = await host.jitDesktopOwnerLink(url); return !!value && typeof value === "object" && Reflect.get(value, "opened") === true; }
  catch { return false; }
}

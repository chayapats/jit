import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { disableNotifications, enableNotifications, notificationLocale, notificationStatus, type JitClient, type NotificationEnvironment, type NotificationStatus } from "../client";

/** State and actions for a notification settings control. Copy and layout belong to the caller. */
export interface NotificationsControl {
  /** Null until the first read; `available` false means the service has no Web Push (`capabilities.notifications`). */
  status: NotificationStatus | null;
  busy: boolean;
  /** Call from the owner's tap: it may show the browser permission prompt. Requires a completed bootstrap (CSRF). */
  enable(): Promise<NotificationStatus>;
  disable(): Promise<NotificationStatus>;
  refresh(): Promise<NotificationStatus | null>;
}

/**
 * Minimal hook over the shared client's notification functions. It reads the device state once the capability is
 * available, keeps the worker's language in step with `locale`, and reports `jit-notice-open` messages (a notification
 * tapped while this page is already open at its path) through `onOpen`, so the page can re-fetch current state.
 */
export function useNotifications(client: JitClient, options: { available: boolean; locale: Locale; onOpen?: (path: string) => void; env?: NotificationEnvironment }): NotificationsControl {
  const [status, setStatus] = useState<NotificationStatus | null>(null), [busy, setBusy] = useState(false);
  const { available, locale, env } = options, onOpen = useRef(options.onOpen); onOpen.current = options.onOpen;
  const refresh = useCallback(async () => {
    if (!available) { setStatus(null); return null; }
    const next = await notificationStatus(client, env); setStatus(next); return next;
  }, [client, available, env]);
  const run = useCallback(async (action: () => Promise<NotificationStatus>) => {
    setBusy(true);
    try { const next = await action(); setStatus(next); return next; } finally { setBusy(false); }
  }, []);
  const enable = useCallback(() => run(() => enableNotifications(client, { locale, ...(env ? { env } : {}) })), [run, client, locale, env]);
  const disable = useCallback(() => run(() => disableNotifications(client, env ? { env } : {})), [run, client, env]);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  useEffect(() => { if (available && status?.enabled) void notificationLocale(locale, env).catch(() => {}); }, [available, status?.enabled, locale, env]);
  useEffect(() => {
    const container = (globalThis as { navigator?: { serviceWorker?: EventTarget } }).navigator?.serviceWorker;
    if (!container) return;
    const listener = (event: Event) => { const data = (event as MessageEvent).data as { type?: unknown; path?: unknown } | null; if (data?.type === "jit-notice-open" && typeof data.path === "string") onOpen.current?.(data.path); };
    container.addEventListener("message", listener);
    return () => container.removeEventListener("message", listener);
  }, []);
  return { status, busy, enable, disable, refresh };
}

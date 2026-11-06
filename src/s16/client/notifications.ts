import type { Locale } from "../../i18n";
import { JitClient, JitClientError } from "./client";

/** Browser capability for this device: no Web Push at all, or the current Notification permission. */
export type NotificationSupport = "unsupported" | "denied" | "default" | "granted";
/**
 * Honest device state for the settings control. `enabled` is true only when this browser holds a push subscription
 * under the installation's current key and the service has it for the signed-in owner. `code` explains a failure
 * (`notifications_unsupported`, `notification_permission_denied`, `notification_permission_dismissed`,
 * `notification_key_changed`, `notifications_unavailable`, a push/service error code) and is null otherwise.
 */
export interface NotificationStatus { support: NotificationSupport; enabled: boolean; code: string | null }

/** Fixed worker script and scope; the worker shows notices and opens their path, and caches nothing. */
export const notificationWorker = Object.freeze({ script: "/s16/sw.js", scope: "/s16/" });

interface WorkerLike { state: string; addEventListener(type: "statechange", listener: () => void): void; postMessage?(message: unknown): void }
interface SubscriptionLike { endpoint: string; options?: { applicationServerKey?: ArrayBuffer | null }; toJSON(): { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> }; unsubscribe(): Promise<boolean> }
interface RegistrationLike { active: WorkerLike | null; installing: WorkerLike | null; waiting: WorkerLike | null;
  pushManager: { getSubscription(): Promise<SubscriptionLike | null>; subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<SubscriptionLike> } }
/** The browser surfaces used here. Injectable so the logic is tested without a browser; defaults to `globalThis`. */
export interface NotificationEnvironment {
  isSecureContext: boolean;
  Notification?: { permission: string; requestPermission(): Promise<string> };
  PushManager?: unknown;
  serviceWorker?: { register(script: string, options: { scope: string; type?: "classic"; updateViaCache?: "none" }): Promise<RegistrationLike>; getRegistration(url: string): Promise<RegistrationLike | undefined> };
  digest?(bytes: Uint8Array): Promise<ArrayBuffer>;
}
const browser = (): NotificationEnvironment => {
  const scope = globalThis as unknown as { isSecureContext?: boolean; Notification?: NotificationEnvironment["Notification"]; PushManager?: unknown; navigator?: { serviceWorker?: NotificationEnvironment["serviceWorker"] } };
  return { isSecureContext: scope.isSecureContext === true, ...(scope.Notification ? { Notification: scope.Notification } : {}), ...(scope.PushManager ? { PushManager: scope.PushManager } : {}), ...(scope.navigator?.serviceWorker ? { serviceWorker: scope.navigator.serviceWorker } : {}) };
};
const codeOf = (error: unknown, fallback: string) => error instanceof JitClientError ? error.code : fallback;

/** Decodes the installation's base64url public key into the `applicationServerKey` bytes. */
export function applicationServerKey(publicKey: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new JitClientError("client_protocol_invalid", null, "response");
  const binary = atob(publicKey.replaceAll("-", "+").replaceAll("_", "/") + "=");
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new JitClientError("client_protocol_invalid", null, "response");
  return bytes;
}
/** True when a subscription was made with exactly this key; a missing key counts as different. */
export function sameApplicationServerKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current || current.byteLength !== key.length) return false;
  const bytes = new Uint8Array(current); return bytes.every((value, index) => value === key[index]);
}
/** SHA-256 hex of a push endpoint, the device name used in status reads. */
export async function endpointSha256(endpoint: string, env: NotificationEnvironment = browser()): Promise<string> {
  const digest = await (env.digest ?? (bytes => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))))(new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/** Whether this device can use Web Push, and the current permission. Never prompts. */
export function notificationSupport(env: NotificationEnvironment = browser()): NotificationSupport {
  if (!env.isSecureContext || !env.Notification || !env.PushManager || !env.serviceWorker) return "unsupported";
  const permission = env.Notification.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

async function activated(registration: RegistrationLike, timeoutMs = 30_000): Promise<RegistrationLike> {
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new JitClientError("service_worker_unavailable", null, "not_sent");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JitClientError("service_worker_unavailable", null, "not_sent")), timeoutMs);
    const check = () => { if (worker.state === "activated") { clearTimeout(timer); resolve(); } else if (worker.state === "redundant") { clearTimeout(timer); reject(new JitClientError("service_worker_unavailable", null, "not_sent")); } };
    worker.addEventListener("statechange", check); check();
  });
  return registration;
}

/**
 * Current state of this device. Reads only: it never prompts, subscribes or changes the service. A browser subscription
 * under an older installation key reports `notification_key_changed`, and enabling again replaces it.
 */
export async function notificationStatus(client: JitClient, env: NotificationEnvironment = browser()): Promise<NotificationStatus> {
  const support = notificationSupport(env);
  if (support === "unsupported") return { support, enabled: false, code: "notifications_unsupported" };
  try {
    const registration = await env.serviceWorker!.getRegistration(notificationWorker.scope);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return { support, enabled: false, code: null };
    const settings = await client.notificationSettings();
    if (!sameApplicationServerKey(subscription.options?.applicationServerKey, applicationServerKey(settings.publicKey))) return { support, enabled: false, code: "notification_key_changed" };
    const device = await client.notificationDevice(await endpointSha256(subscription.endpoint, env));
    return { support, enabled: device.subscribed && support === "granted", code: null };
  } catch (error) { return { support, enabled: false, code: codeOf(error, "notifications_unavailable") }; }
}

/**
 * Turn notifications on for this device. Call it from the owner's tap: it may show the browser permission prompt.
 * Registers the fixed worker, subscribes with the installation key (replacing a subscription under another key) and
 * stores the subscription for the signed-in owner. `locale` sets the language of notification text on this device.
 * Failures return a status with a code; nothing is retried automatically.
 */
export async function enableNotifications(client: JitClient, options: { locale?: Locale; env?: NotificationEnvironment } = {}): Promise<NotificationStatus> {
  const env = options.env ?? browser(), support = notificationSupport(env);
  if (support === "unsupported") return { support, enabled: false, code: "notifications_unsupported" };
  let permission: string = support;
  if (permission === "default") { try { permission = await env.Notification!.requestPermission(); } catch { permission = "default"; } }
  if (permission !== "granted") return { support: permission === "denied" ? "denied" : "default", enabled: false, code: permission === "denied" ? "notification_permission_denied" : "notification_permission_dismissed" };
  try {
    const settings = await client.notificationSettings(), key = applicationServerKey(settings.publicKey);
    const registration = await activated(await env.serviceWorker!.register(notificationWorker.script, { scope: notificationWorker.scope, type: "classic", updateViaCache: "none" }));
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameApplicationServerKey(subscription.options?.applicationServerKey, key)) { await subscription.unsubscribe(); subscription = null; }
    try { subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); }
    catch { return { support: "granted", enabled: false, code: "push_subscribe_failed" }; }
    const json = subscription.toJSON();
    if (typeof json.endpoint !== "string" || typeof json.keys?.p256dh !== "string" || typeof json.keys?.auth !== "string") return { support: "granted", enabled: false, code: "push_subscribe_failed" };
    await client.subscribeNotifications({ publicKey: settings.publicKey, subscription: { endpoint: json.endpoint, expirationTime: typeof json.expirationTime === "number" ? json.expirationTime : null, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } });
    if (options.locale) registration.active?.postMessage?.({ type: "jit-locale", locale: options.locale });
    return { support: "granted", enabled: true, code: null };
  } catch (error) { return { support: "granted", enabled: false, code: codeOf(error, "notifications_unavailable") }; }
}

/**
 * Turn notifications off for this device: the service forgets the subscription first, then the browser drops it.
 * If the service call fails the browser subscription is kept, so the owner can simply try again.
 */
export async function disableNotifications(client: JitClient, options: { env?: NotificationEnvironment } = {}): Promise<NotificationStatus> {
  const env = options.env ?? browser(), support = notificationSupport(env);
  if (support === "unsupported") return { support, enabled: false, code: "notifications_unsupported" };
  try {
    const registration = await env.serviceWorker!.getRegistration(notificationWorker.scope);
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) { await client.unsubscribeNotifications(subscription.endpoint); await subscription.unsubscribe(); }
    return { support, enabled: false, code: null };
  } catch (error) { return { support, enabled: true, code: codeOf(error, "notifications_unavailable") }; }
}

/** Tell this device's worker which language to use for notification text. */
export async function notificationLocale(locale: Locale, env: NotificationEnvironment = browser()): Promise<void> {
  if (notificationSupport(env) === "unsupported") return;
  const registration = await env.serviceWorker!.getRegistration(notificationWorker.scope).catch(() => undefined);
  registration?.active?.postMessage?.({ type: "jit-locale", locale });
}

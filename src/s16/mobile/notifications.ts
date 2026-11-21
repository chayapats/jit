import type { Locale } from "../../i18n";
import type { NativeProviderKind } from "../native-notifications/types";
import type { MobileSession } from "./session";
import { nativeToken } from "./notices";
import { mobileServiceId, type MobileSecureStore } from "./transport";

/** Native permission and OS token adapter. Only requestPermission can display an OS prompt. */
export interface MobileNotificationOs {
  readonly provider: NativeProviderKind;
  /** Read-only local configuration check; no permission request, token acquisition or provider registration. */
  configured?(): Promise<boolean>;
  permission(): Promise<"granted" | "denied" | "undetermined" | "provisional">;
  requestPermission(): Promise<"granted" | "denied" | "undetermined" | "provisional">;
  token(): Promise<string>;
  active(): Promise<void>;
}
/** Renderable facts contain no OS token or protected subscription record. */
export interface MobileNotificationView { readonly state: "off" | "enabled" | "denied" | "provisional" | "unavailable" | "uncertain" | "token_changed"; readonly busy: boolean; readonly canDisable: boolean }
interface Saved { v: 1; service: string; provider: NativeProviderKind; token: string; locale: Locale; intent: "subscribing" | "enabled" | "disabling" }
interface Binding { scope: string; selection: number }
const queues = new Map<string, Promise<unknown>>();
const failure = (code: string): never => { throw Object.assign(new Error(code), { code }); };
async function finite<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("mobile_notification_unavailable"), { code: "mobile_notification_unavailable" })), 30000); })]); }
  finally { clearTimeout(timer); }
}
/** Protected subscription custody and explicit mutations. Restore/refresh is read-only and never replays an intent. */
export class MobileNotifications {
  #view: MobileNotificationView = Object.freeze({ state: "off", busy: false, canDisable: false });
  readonly #listeners = new Set<() => void>();
  #working = false;
  constructor(readonly session: MobileSession, readonly store: MobileSecureStore, readonly os: MobileNotificationOs) {}
  get projection(): MobileNotificationView { return this.#view; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #publish(state: MobileNotificationView["state"], canDisable = false): void { this.#view = Object.freeze({ state, busy: this.#working, canDisable }); for (const listener of this.#listeners) listener(); }
  #binding(): Binding {
    const frame = this.session.projection;
    if (frame.phase !== "ready" || !frame.bootstrap?.sessionScope) return failure("mobile_not_ready");
    return { scope: frame.bootstrap.sessionScope, selection: this.session.selectionRevision };
  }
  #check(binding: Binding): void {
    const current = this.#binding();
    if (current.scope !== binding.scope || current.selection !== binding.selection) failure("mobile_response_stale");
  }
  async #key(): Promise<{ key: string; service: string }> { const service = await mobileServiceId(this.session.transport.origin); return { key: "jit.mobile.notifications.v1." + service, service }; }
  async #saved(binding: Binding): Promise<Saved | null> {
    const { key, service } = await this.#key(), raw = await this.store.get(key); this.#check(binding);
    if (raw === null) return null;
    try {
      if (raw.length > 8192) throw Error(); const value = JSON.parse(raw);
      if (!value || Object.keys(value).sort().join() !== "intent,locale,provider,service,token,v" || value.v !== 1 || value.service !== service || value.provider !== this.os.provider || !["en", "th"].includes(value.locale) || !["subscribing", "enabled", "disabling"].includes(value.intent) || nativeToken(value.provider, value.token) !== value.token) throw Error();
      return value as Saved;
    } catch { return failure("mobile_notification_storage_invalid"); }
  }
  async #save(binding: Binding, value: Saved | null): Promise<void> {
    const { key } = await this.#key(), previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      this.#check(binding); const original = await this.store.get(key); this.#check(binding);
      if (value) await this.store.set(key, JSON.stringify(value)); else await this.store.delete(key);
      try { this.#check(binding); } catch (error) { if (original === null) await this.store.delete(key); else await this.store.set(key, original); throw error; }
    });
    queues.set(key, operation);
    try { await operation; } finally { if (queues.get(key) === operation) queues.delete(key); }
  }
  async #revalidate(binding: Binding): Promise<void> { await finite(this.os.active()); await this.session.restore(); this.#check(binding); }
  async #available(binding: Binding): Promise<void> {
    if (!this.session.projection.bootstrap?.capabilities.nativeNotifications?.available) failure("mobile_notification_unavailable");
    if (this.os.configured && !await finite(this.os.configured())) failure("mobile_notification_unavailable"); this.#check(binding);
    const settings = await this.session.perform((client, signal) => client.nativeNotificationSettings(signal)); this.#check(binding);
    if (settings.service !== await mobileServiceId(this.session.transport.origin) || !settings.providers.some(provider => provider.provider === this.os.provider && provider.available)) failure("mobile_notification_unavailable");
    this.#check(binding);
  }
  async #lookup(binding: Binding, saved: Saved): Promise<boolean> {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(saved.token))), byte => byte.toString(16).padStart(2, "0")).join(""); this.#check(binding);
    const device = await this.session.perform((client, signal) => client.nativeNotificationDevice(hash, signal)); this.#check(binding); return device.subscribed;
  }
  async #run(operation: () => Promise<void>): Promise<void> {
    if (this.#working) return; this.#working = true; this.#publish(this.#view.state, this.#view.canDisable);
    try { await operation(); }
    catch (error) { this.#publish(error && typeof error === "object" && "code" in error && error.code === "mobile_notification_unavailable" ? "unavailable" : "uncertain", this.#view.canDisable); throw error; }
    finally { this.#working = false; this.#publish(this.#view.state, this.#view.canDisable); }
  }
  /** Read-only recovery of the original protected token; permission restoration never registers or sends work. */
  async refresh(): Promise<void> { return this.#run(async () => {
    const binding = this.#binding(), saved = await this.#saved(binding);
    if (!this.session.projection.bootstrap?.capabilities.nativeNotifications?.available || this.os.configured && !await finite(this.os.configured())) { this.#check(binding); this.#publish("unavailable", !!saved); return; } this.#check(binding);
    if (!saved) { this.#publish("off"); return; }
    const subscribed = await this.#lookup(binding, saved), permission = await finite(this.os.permission()); this.#check(binding);
    if (!subscribed) { this.#publish("off", false); return; }
    if (permission !== "granted") { this.#publish(permission === "provisional" ? "provisional" : "denied", true); return; }
    const token = nativeToken(this.os.provider, await finite(this.os.token())); this.#check(binding);
    this.#publish(token !== saved.token ? "token_changed" : saved.intent === "disabling" ? "uncertain" : "enabled", true);
  }); }
  /** One explicit opt-in. Persist-before-POST and duplicate-gesture exclusion survive an unknown response. */
  async enable(locale: Locale): Promise<void> { return this.#run(async () => {
    if (locale !== "en" && locale !== "th") failure("mobile_notification_invalid");
    const binding = this.#binding(); await this.#available(binding); const previous = await this.#saved(binding);
    const permission = await finite(this.os.requestPermission()); await this.#revalidate(binding);
    if (permission !== "granted") { this.#publish(permission === "provisional" ? "provisional" : "denied", !!previous); return; }
    await this.#available(binding);
    const token = nativeToken(this.os.provider, await finite(this.os.token())); this.#check(binding);
    if (previous && previous.token !== token && await this.#lookup(binding, previous)) { this.#publish("token_changed", true); return; }
    const saved: Saved = { v: 1, service: (await this.#key()).service, provider: this.os.provider, token, locale, intent: "subscribing" };
    await this.#save(binding, saved); this.#publish("uncertain", true);
    const result = await this.session.perform((client, signal) => client.nativeNotificationSubscription("subscribe", { provider: saved.provider, token, locale }, signal)); this.#check(binding);
    if (!result.subscribed) failure("mobile_notification_invalid");
    await this.#save(binding, { ...saved, intent: "enabled" }); this.#publish("enabled", true);
  }); }
  /** Explicit idempotent removal of the original token works without asking for permission or acquiring a new token. */
  async disable(): Promise<void> { return this.#run(async () => {
    const binding = this.#binding(), saved = await this.#saved(binding); if (!saved) { this.#publish("off"); return; }
    await this.#save(binding, { ...saved, intent: "disabling" }); this.#publish("uncertain", true);
    const result = await this.session.perform((client, signal) => client.nativeNotificationSubscription("unsubscribe", { provider: saved.provider, token: saved.token }, signal)); this.#check(binding);
    if (result.subscribed) failure("mobile_notification_invalid");
    await this.#save(binding, null); this.#publish("off");
  }); }
}

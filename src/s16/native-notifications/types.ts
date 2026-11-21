import type { Locale } from "../../i18n";
import type { NativeNotice } from "../mobile/notices";
import type { NoticeProducer, NotificationOwner } from "../notifications/types";

/** Direct platform providers only; no Expo relay or token-controlled endpoint. */
export type NativeProviderKind = "apns" | "fcm";
/** Safe capability state; installation accounts, paths, topic, signing key and device token are omitted. */
export interface NativeProviderStatus { provider: NativeProviderKind; available: boolean; code: "native_push_credentials_unavailable" | null }
/** Provider HTTP acceptance is distinct from delivery to a physical device. */
export interface NativePushResult { state: "accepted" | "gone" | "retry" | "failed"; code: string | null; retryAfterMs?: number }
/**
 * Protected provider dispatch. `guard` rechecks current owner/device immediately before every external dispatch,
 * including after an OAuth await; a notice can never grant work or decision authority.
 */
export interface NativePushProvider {
  readonly kind: NativeProviderKind;
  status(): NativeProviderStatus;
  send(input: { token: string; locale: Locale; payload: Readonly<NativeNotice>; ttlSeconds: number; now: number; signal: AbortSignal; guard(): void }): Promise<NativePushResult>;
  /** Release provider connections and cached authorization owned by this service instance. */
  close?(): void | Promise<void>;
}
/** Operator-selected protected signing files only. No private key, provider token or arbitrary endpoint in config. */
export interface NativeProvidersConfig {
  apns?: { keyPath: string; keyId: string; teamId: string; topic: string; environment: "sandbox" | "production" };
  fcm?: { credentialsPath: string; projectId: string };
}
/** Versioned current-owner native subscription settings, with no token or credential. */
export interface NativeNotificationSettings { contract: "s16-native-notifications/v1"; providers: NativeProviderStatus[]; devices: number; limit: 20; service: string }
/** Whether this token hash belongs to the current authenticated owner generation. */
export interface NativeNotificationDevice { contract: "s16-native-notification-device/v1"; subscribed: boolean }
/** Native journal timings are finite and can only be narrowed by deterministic fixtures. */
export interface NativeNotificationLimits { ttlSeconds: number; attempts: number; backoffMs: number; backoffMaxMs: number; timeoutMs: number; batch: number; retentionMs: number }
/** Additive protected composition; absence creates no native routes, journal or provider activity. */
export interface NativeNotificationOptions<Actor> {
  path: string; installationId: string; create: boolean; origin: string;
  providers: readonly NativePushProvider[];
  principal(actor: Actor): NotificationOwner;
  ownerCurrent(owner: NotificationOwner): boolean;
  producers?: readonly NoticeProducer[];
  now?: () => number;
  limits?: Partial<NativeNotificationLimits>;
}

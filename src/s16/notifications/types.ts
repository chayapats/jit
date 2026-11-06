/** Owner identity a subscription or notice belongs to. A changed generation (password reset/owner change) makes it inert. */
export interface NotificationOwner { ownerId: string; generation: number }

/** Generic notice kinds. The service worker turns each into a localized title/body; nothing private travels. */
export type NoticeKind = "needs_you" | "result" | "routine";

/**
 * Encrypted Web Push payload (`s16-notification-payload/v1`, `v: 1`). Only an opaque notice ID (the notification tag),
 * the kind and a same-origin in-app path. Never conversation text, names, recipients, amounts or file names.
 */
export interface NotificationPayload { v: 1; id: string; kind: NoticeKind; path: string }

/** One producer-derived notice. `source` is the stable identity of the event it came from; the same source never yields two notices. */
export interface NoticeInput { source: string; owner: NotificationOwner; kind: NoticeKind; path: string }

/**
 * A notice source with its own durable cursor (opaque to the service). `collect` receives the stored cursor, or
 * `null` the first time, and returns the next cursor plus derived notices. The cursor and the notices commit in one
 * notification-journal transaction, so a restart re-reads at most an uncommitted batch, whose notices dedupe by source.
 */
export interface NoticeProducer { name: string; collect(cursor: number | null): { cursor: number; notices: NoticeInput[] } }

/** Fixed `s16-notifications/v1` bounds. Tests may narrow timings; the defaults are the product values. */
export interface NotificationLimits {
  /** Subscribed devices per owner. */
  devices: number;
  /** Longest accepted push endpoint URL, in bytes. */
  endpointBytes: number;
  /** Push service `TTL`, and how long an undelivered notice stays worth sending. */
  ttlSeconds: number;
  /** Attempts per delivery before it fails with `push_retry_exhausted`. */
  attempts: number;
  /** First retry delay; doubled per attempt up to `backoffMaxMs`. */
  backoffMs: number; backoffMaxMs: number;
  /** One push request's time limit. */
  timeoutMs: number;
  /** Deliveries sent per pass. */
  batch: number;
  /** Notices and delivery rows are kept this long, which also bounds source deduplication. */
  retentionMs: number;
  /** Plaintext is padded to this size so every payload has the same length on the wire. */
  padTo: number;
}

/** Owner projection of the installation's Web Push setup (`s16-notifications/v1`). The public key is not a secret. */
export interface NotificationSettings { contract: "s16-notifications/v1"; publicKey: string; devices: number; limit: number }
/** Whether one device (named by the SHA-256 of its push endpoint) is subscribed for the current owner. */
export interface NotificationDevice { contract: "s16-notification-device/v1"; subscribed: boolean }

/** Browser `PushSubscription.toJSON()` shape accepted by subscribe. */
export interface NotificationSubscriptionInput { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } }
/** Subscribe command: the key the browser subscribed with must still be the installation key. */
export interface NotificationSubscribeCommand { publicKey: string; subscription: NotificationSubscriptionInput }
export interface NotificationUnsubscribeCommand { endpoint: string }

/** Delivery state per notice and subscription. `gone` means the subscription no longer exists. */
export type DeliveryState = "pending" | "sending" | "sent" | "failed" | "gone";

export interface NotificationServiceOptions<Actor> {
  /** Protected journal path (`notifications.sqlite`). */
  path: string; installationId: string; create: boolean;
  /** Protected VAPID private key file (32 raw bytes, 0600), created on first use. */
  keyPath: string;
  /** Installation origin; derives the VAPID contact and nothing else. */
  origin: string;
  now?: () => number;
  /** Push transport; tests inject a fake push service. */
  fetch?: (request: Request) => Promise<Response>;
  /** Verifies an authenticated owner actor and returns its identity. */
  principal(actor: Actor): NotificationOwner;
  /** True while that owner identity is still current; otherwise its subscriptions are removed before any push. */
  ownerCurrent(owner: NotificationOwner): boolean;
  producers?: readonly NoticeProducer[];
  limits?: Partial<NotificationLimits>;
}

# S16 notifications v1

NOTIFY16-01 [#441](https://github.com/chayapats/jit/issues/441) delivers `s16-notifications/v1`: Web Push notices for the opt-in S15 + S16 client stack. Decision record: [ADR 0085](../adr/0085-remove-telegram-web-push-notifications.md); approval stays in the conversation per [ADR 0084](../adr/0084-s16-grok-style-default-autonomy.md). Requirements: S16-D10, S16-F18/AC18, S16-AC09; FR-04, FR-09, FR-11, FR-15, FR-28, FR-30; NFR-05, NFR-06, NFR-07, NFR-09. Exported TSDoc in `src/s16/notifications/` and `src/s16/client/notifications.ts` is the actual API.

A notice is a pointer, not content and not authority. It carries a generic kind and an opaque in-app path; opening it lands on the authenticated conversation, which re-fetches current state. A notification never approves, decides, starts or stops anything.

## Selection and storage

Notifications exist only when the composition receives `notifications: {}` (`notifications: true` in `s15-runtime/v1`). Omission keeps the installation unchanged: no store, key, routes or capability. Enabling it on an existing installation adds `notifications.sqlite` through the composition manifest's additive-store rule. S14/legacy runtimes have no push transport and keep their in-app attention.

- `notifications-vapid.key`: the installation's VAPID P-256 private scalar (32 raw bytes), created on first use with `O_EXCL|O_NOFOLLOW`, mode `0600`, and read back with an `fstat` check (regular file, single link, no group/other bits). It is never written to configuration, logs, exports, prompts or the journal. No owner configuration is needed.
- `notifications.sqlite`: a protected `DurableJournal` (application ID `0x4e543136`, exclusive process lease, FULL synchronous transactions). Tables: `subscriptions_v1`, `notices_v1`, `deliveries_v1`, `cursors_v1`.

## Owner API

Under the protected S16 client (`/api/s16/client/`): owner session, exact Host, no cross-site Fetch Metadata; POST also needs the exact Origin and current CSRF, rechecked after the body is read. Responses are `private, no-store`. No query parameters.

| Method / path | Result |
| --- | --- |
| GET `/notifications` | `{ contract: "s16-notifications/v1", publicKey, devices, limit }`. `publicKey` is the base64url uncompressed P-256 application server key. The first read creates the key. |
| GET `/notifications/devices/<sha256(endpoint)>` | `{ contract: "s16-notification-device/v1", subscribed }` for this owner under the current key. The device names itself by the hash, so its endpoint never appears in a URL. |
| POST `/notifications/subscribe` | Body `{ publicKey, subscription: { endpoint, expirationTime, keys: { p256dh, auth } } }` (the browser's `PushSubscription.toJSON()`). Same endpoint updates in place (one row per device). Returns `subscribed: true`. |
| POST `/notifications/unsubscribe` | Body `{ endpoint }`. Idempotent. Returns `subscribed: false`. |

Validation: exact keys only; `publicKey` must equal the current installation key (`notification_key_changed`, 409); `endpoint` is a canonical `https` URL on the default port with a DNS host, at most 2048 bytes, with no credentials or fragment, and no literal IP or local name (`localhost`, `.local`, `.internal`, `.home`, `.lan`, `.intranet`, `.corp`) (`push_endpoint_invalid`); `p256dh` must be an uncompressed point on P-256 and `auth` exactly 16 bytes (`push_subscription_invalid`); a past `expirationTime` refuses. At most 20 devices per owner (`notification_device_limit`, 409). Subscriptions from an earlier owner generation are deleted at the next owner contact; subscriptions made with an earlier key are ignored (never counted, fanned out to or pushed) and deleted when a new device subscribes.

The capability projection adds `notifications: { available: true, contract: "s16-notifications/v1", transport: "web_push", serviceWorker: "/s16/sw.js", scope: "/s16/" }` or `{ available: false, code: "notifications_unavailable" }`. Clients without the field keep working.

## Notices

A notice has a stable ID `nt_` + the first 32 hex digits of `sha256("s16.notice.v1\n" + source)`. `source` is unique in the journal for the retention window (7 days), so one source event never yields two notices, across retry and restart. At creation, a notice fans out to one `pending` delivery per subscription of its owner; a device added later does not receive older notices.

Producers run behind durable cursors that commit with the notices they produce. The first run places each cursor at the current end, so enabling notifications never replays history.

| Producer | Source identity | Kind |
| --- | --- | --- |
| CHAT `events` journal, kind `needs_me`, while the request still shows that Needs-you item | `needs_you:<hold_<request>_<revision> or action_<id>_<revision>>` | `needs_you` |
| CHAT `events` journal, kind `result`, for a completed request whose result is currently publishable, without an open Needs-you item, received at least `resultAfterMs` (default 30 s) earlier | `result:<request>` | `result` |
| Routine occurrences that raised attention (`notified`, which excludes quiet runs), settled within the last 24 h | `routine:<occurrence>` | `needs_you` for `needs_you`/`waiting_review`/`unknown`, else `routine` |

Routine-pinned CHAT requests are left to the routine producer, so a quiet run never notifies and a visible run notifies once. Owner rows are read through the guarded owner projection as the request's recorded owner; a changed owner generation reads nothing. Stops and progress never notify. The result threshold keeps a quick reply that the owner is watching from buzzing the device; the trade-off is that a fast reply after the owner left the app is not announced.

## Payload and delivery

The encrypted payload is exactly `{ "v": 1, "id": "<notice id>", "kind": "needs_you" | "result" | "routine", "path": "<path>" }`, where `path` matches `^/s16(/(chat|routines)/[A-Za-z0-9_-]{1,128})?$`. No message text, names, recipients, amounts, file names or action content. The plaintext is padded to 256 bytes so every notice has the same size on the wire.

Each push is one RFC 8030 POST to the subscription endpoint:

- RFC 8291 `aes128gcm`: fresh ephemeral P-256 key and 16-byte salt per message, HKDF-SHA256 with the subscription auth secret, AES-128-GCM, record size 4096, one record. Verified against the RFC 8291 Appendix A vector.
- RFC 8292 VAPID: `Authorization: vapid t=<ES256 JWT>, k=<public key>`, JWT claims only `aud` (the endpoint origin), `exp` (now + 12 h) and `sub` (the installation origin when https, otherwise `mailto:jit@<host>`; never the owner's address).
- `TTL` = 24 h minus the notice's age; `Urgency: high` for `needs_you`, `normal` otherwise; `Topic` = the notice ID hex, so the push service replaces a pending copy of the same notice. Redirects are refused; each request has a 15 s limit.

Delivery state per notice and subscription: `pending` → `sending` → `sent` | `failed` | `gone`.

- 2xx: `sent`.
- 404/410: the subscription is deleted; its undelivered rows become `gone` and later notices skip it.
- 429, 5xx or no answer: back to `pending` after `30 s × 2^(attempt−1)`, at most 1 h (or a longer `Retry-After`, at most 6 h); after 8 attempts `failed` with `push_retry_exhausted`.
- Any other status: `failed` (`push_413` is reported as `push_payload_too_large`).
- A notice older than its TTL is `failed` with `notice_expired` instead of arriving late.
- Before each push the subscription's owner generation must still be current; otherwise the subscription is deleted (`owner_changed`) and nothing is sent.

The `sending` state commits before the network call. After a crash it reopens as `pending` and the same notice is sent again under the same ID, `Topic` and notification tag. A duplicate push is therefore possible only when the outcome of a send was unknown; it never creates a second notice, and the push service and the worker collapse it into the one notification already shown. Delivery runs beside the composition drain (a single-flight pass started on every wake) and never delays CHAT work.

Disclosure: browser push services (Google FCM, Mozilla autopush, Apple, Microsoft WNS — whichever the owner's browser uses) are recipients of the encrypted payload, its fixed size, the endpoint they issued and the timing of each notice. They never receive plaintext content.

## Service worker

`GET /s16/sw.js` serves a hand-written classic worker without a session (it holds no installation or owner data), `no-store`, `nosniff`, CSP `default-src 'none'; img-src 'self'`. Its default scope is `/s16/`. It has no fetch handler and caches no response.

- `push`: validates the payload shape and shows a localized generic title/body (`s16.notify.<kind>.title|body` from both dictionaries), `tag` = notice ID, `data.path`. An unreadable payload shows the generic `s16.notify.generic.*` notice pointing at `/s16`.
- Language: the page posts `{ type: "jit-locale", locale }`; the worker keeps it in a small Cache Storage entry. Otherwise `navigator.language` starting with `en` selects English, else Thai.
- `notificationclick`: re-validates the path (anything else opens `/s16`), focuses a same-origin window already at that path and posts `{ type: "jit-notice-open", path }` to it, or opens the path in a new window.

## Shared client

`src/s16/client` exports, browser/native-safe:

```ts
type NotificationSupport = "unsupported" | "denied" | "default" | "granted";
interface NotificationStatus { support: NotificationSupport; enabled: boolean; code: string | null }
notificationSupport(env?): NotificationSupport;                       // never prompts
notificationStatus(client, env?): Promise<NotificationStatus>;      // read only
enableNotifications(client, { locale?, env? }): Promise<NotificationStatus>;  // call from a tap; may prompt
disableNotifications(client, { env? }): Promise<NotificationStatus>; // service first, then the browser
notificationLocale(locale, env?): Promise<void>;
JitClient#notificationSettings / notificationDevice / subscribeNotifications / unsubscribeNotifications
```

`enableNotifications` registers `/s16/sw.js` with scope `/s16/` (`updateViaCache: "none"`), waits for activation, replaces a browser subscription made with another key, subscribes with `userVisibleOnly: true`, and posts it. Failures return a status with a code (`notifications_unsupported`, `notification_permission_denied`, `notification_permission_dismissed`, `push_subscribe_failed`, `notification_key_changed`, or the service/transport code); nothing retries automatically. `src/s16/web/useNotifications.ts` is a minimal React hook over these for the settings control.

## Evidence

Deterministic, with a fake push service, fake browser surfaces and a fake clock; no live push service:

- `tests/s16-notifications-crypto.test.ts`: RFC 8291 Appendix A vector; padded sizes; strict base64url/point checks; VAPID header, claims, 12 h expiry and ES256 signature.
- `tests/s16-notifications.test.ts`: private key file; subscribe validation, idempotence and the device bound; one source → one notice → one push per device with the exact payload and headers; backoff with `Retry-After`; 410 removal; final refusals; TTL expiry; restart with pending and interrupted deliveries; owner generation change; retention.
- `tests/s16-notifications-composed.test.ts`: composed S15 + S16 client — a held email action produces exactly one `needs_you` push with no message, subject or recipient text; approval only through the conversation decision; no duplicates across wakes and restart; result threshold; disable; route auth/Origin/CSRF/Fetch Metadata checks; worker served publicly; opt-out composition unchanged; quiet routine silent, needs-you and visible routine outcomes notify once; honest client states and key replacement.
- `tests/s16-notifications-worker.test.ts`: the served worker in a fake worker scope — localized Thai/English text, tag, stored language, generic fallback for malformed payloads, click focus/open and path re-validation.

## Limits and pending

- A real browser run (Chromium/Firefox/Safari bundle at mobile width) and a live push service round trip are pending; iOS/iPadOS deliver Web Push only to a Home Screen web app, which needs the S16 app's manifest/install flow.
- Native mobile notifications remain MOBILE16-01 [#426](https://github.com/chayapats/jit/issues/426).
- The owner-facing settings control and its copy are part of the S16 web app, not this contract.

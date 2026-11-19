# S16 packaged mobile client v1

MOBILE16-01 (#426), S16-AC17; FR-10/11/18/24/25/28/35/37/38; NFR-05/07/09/11/13. Engineering selection: [ADR 0100](../adr/0100-s16-packaged-native-mobile-client.md). Existing [shared client](s16-client-v1.md), [files](s16-files-v1.md), [binary files](s16-binary-files-v1.md), [voice](s16-voice-v1.md), [exact conversation decisions](s15-conversation-v1.md) and [Web Push](s16-notifications-v1.md) retain authority. This contract alone claims no completed native delivery.

## Exact service and native session

`s16-mobile-session/v1` is a native credential record, not a service auth mechanism. Canonical input is an absolute HTTPS origin, or literal-loopback HTTP for development, with no credentials/query/fragment/path beyond `/`. Its full origin, including port, determines a SHA-256 storage key. Reject opaque schemes, remote HTTP, lookalike/subdomain/cross-port substitutions and arbitrary native arguments.

The native transport's only authenticated destination is that origin's existing `/api/s16/client` tree. Login is a separate exact POST to `/s14/login`, JSON `{ password }`, exact Origin, omitted native cookie jar and manual redirects. Accept only the actual 303 to the same service root, with exactly one expected session cookie (`__Host-jit_s14` for HTTPS, `jit_s14` for development), HttpOnly, Path=/, SameSite=Strict, Secure on HTTPS, no Domain, a bounded token and at most one day Max-Age. A malformed response cannot replace a valid stored credential. The password is not stored, logged or exported.

Store the cookie and its locally bounded expiry in platform SecureStore under the origin hash. Use device-only/unlocked keychain access and the platform's protected keystore; exclude credentials from Android backups. Handle native storage errors explicitly and refuse plaintext fallback. Restored credentials still need service authentication. Missing/expired/401/403 credentials cannot render a private snapshot. Local sign-out deletes the record, cancels current requests and clears RAM; no server credential/account change is implied.

Authenticated requests add only this exact cookie and the configured Origin, omit all system cookies, refuse redirects/retries and apply `no-store`. No remote TLS bypass. Bound the whole response to fifteen minutes and 128 MiB, with shorter login bounds. Abort and generation checks cover the entire body. A wrong final URL, cross-port/foreign target, oversized/truncated response or native error cannot be a successful command. Unknown POST outcomes retain their original request identity. Cookie/CSRF never enter renderer state, URL/deep links, artifact WebViews, public receipts or push payloads.

## Projection and mutation lifecycle

`s16-mobile/v1` retains only ephemeral views over `JitClient`. Every background/inactive, service switch, conversation/inspector target switch, explicit reconnect and authentication failure advances a local generation before awaiting I/O. Abort current reads, microphone and playback; remove private views, file bytes/previews and old callback handles. Native OS app-switcher protection additionally covers inactive snapshots.

Foreground/resume performs bootstrap and current target reads, then publishes only if service/session/target/generation still match. Do not fall back to stored private content. Current `sessionScope`/`authenticationRevision` can preserve a same-session RAM draft after revalidation; a changed binding discards it. No private message/result/file/approval projection is persisted as an offline cache.

Prepare a send once, with one immutable request ID, exact text/files and conversation. Concurrent tap/duplicate handler cannot prepare a second command while it is pending. Lost replies use read-only original-receipt recovery. An explicit retry reuses the same command only while its exact bytes remain in the same validated session; after process loss retain at most bounded identity metadata for receipt lookup, not reconstructed text or effects. A not-found receipt is not permission to synthesize a new original command. Picker cancellation retains the existing draft and any pending identity unchanged.

File and artifact operations use existing type/hash/size/current-publication checks. Native HTML preview is isolated, session-free, script/bridge/network/file-access free and nonpersistent. External links or file content cannot call a native method or navigate the authenticated client. Export requires an explicit owner-selected native destination. Microphone gesture/permission, finite quota/clip duration and canonical PCM conversion use existing VOICE16 authority; background/cancel stops capture without sending text or deciding an action.

## Native notice and link input

`s16-native-notice/v1` carries exactly `{ v: 1, id, kind, service, path }`: a stable opaque notice ID, existing `needs_you | result | routine` kind, lowercase SHA-256 of the canonical configured service origin, and the existing validated opaque S16 conversation/request path. No private title/body, content, names, credentials, action/hash, arbitrary URL or command. Native platform title/body is generic localized dictionary copy. A provider token is protected subscription data, not a public device label.

An app notification tap or `jit://open/<service-sha256>/<conversation-id>[/<request-id>]` can select only an already configured service and bounded valid IDs. Reject unknown/extra query parameters, userinfo, fragments, encoded path tricks and alternate schemes/hosts. It never installs a new endpoint/session or submits a command. Always reauthenticate/bootstrap and read the current conversation/action. A changed/expired/withdrawn approval is unavailable; only an explicit owner press on the fresh in-app action uses the existing exact revision/hash decision route. No push/action-button approval, auto-send or work start.

## Protected native notifications

Native notifications are opt-in, additive to Web Push. They require an explicit configured APNs or FCM provider with protected credentials and a separate `native-notifications.sqlite` journal in the composition inventory. No selection means no native store/routes/capability. S14, S15 runtime selection, installed policy and historical private scope are unchanged.

Authenticated routes under `/api/s16/client/native-notifications` retain current Host/session checks, exact Origin and CSRF for POST, fresh checks after body streaming, exact keys and private/no-store responses:

| Method/path | Contract |
| --- | --- |
| GET `/` | `s16-native-notifications/v1`: available configured providers, bounded current-owner device count/limit and canonical service hash. No credential/token. |
| GET `/devices/:tokenSha256` | `s16-native-notification-device/v1`: current-owner subscribed state only. |
| POST `/subscribe` | Exact `{ provider: "apns" | "fcm", token, locale: "en" | "th" }`; validated provider token, configured provider and device bound; one current-owner row per token hash. Returns subscribed state. |
| POST `/unsubscribe` | Exact `{ provider, token }`; idempotent current-owner removal. Returns unsubscribed state. |

Add an optional bootstrap capability with version/provider availability; older clients ignore it. Native settings first inspect capability and OS support, then request permission only from an explicit enable gesture. Obtain a native device token, not an Expo token. Missing signing/provider configuration, denial/dismissal, registration uncertainty, revoked device and settings restoration remain distinct visible states. Never report enabled until current OS permission and the owning subscription agree.

Reuse existing `NoticeProducer` projections and stable notice source identities, including current publication/lineage and quiet-routine rules. Cursor and notice/delivery admission commit atomically in the native journal. Initial producer cursors start at the current end; enabling never replays old history. Device/notice ownership is bound to the current owner generation; recheck immediately before network dispatch. A reset or removal makes pending deliveries inert. Limits: twenty devices per owner, seven-day notice/dedup retention, finite TTL, at most eight attempts and bounded exponential backoff; every provider request has a finite timeout.

Delivery state is `pending -> sending -> sent | failed | gone`; commit `sending` before external I/O. Provider acceptance alone permits `sent`, never a device-delivery claim. Crash/unknown outcomes retry only the same generic notice under the same collapse/tag identity; duplicates can collapse, but cannot approve or start work. Invalid/expired tokens are removed; throttling/transient errors respect bounded Retry-After/backoff. Terminal/expired failures remain truthful. No synchronous push wait delays Bot work.

APNs uses fixed Apple production/sandbox endpoints, HTTP/2 and protected ES256 credentials/topic. FCM uses fixed Google OAuth and v1 messaging endpoints with protected service-account signing. No arbitrary token-controlled endpoint, user-supplied audience or forwarded Jit credential. The providers see generic opaque notice metadata/timing, never private result/credential content. Public evidence omits tokens, keys, account addresses and installation-specific hosts. Real account/signing setup is opt-in #431 acceptance; deterministic providers remain clearly labelled fixtures.

## Package, compatibility and proof

Use the exact SDK/dependency pins and OS targets from ADR 0100, a frozen client lock and inventoried native dependencies/notices. Build local release artifacts with no development server, remote JS update feed or telemetry. Verify packaged source/lock/OS/architecture hashes; keep a compatible preceding app artifact for rollback. Native code rollback never rolls back the service's durable work, owner generation, revocations or exact decisions. Additive native stores require explicit composition selection, inventory and recovery compatibility checks.

Required proof includes:

1. Actual packaged simulator/emulator native UI against the protected owning service: file upload -> guarded work -> committed artifact -> current preview/export; zero install-induced host enrollment.
2. Background/foreground, service/session/conversation switches and late read barriers never expose stale private snapshots. Actual native inactive protection is separately checked.
3. Picker cancel, repeated send gestures, lost response and restart recover only the original admission; no duplicate effect or automatic resend.
4. Generic native payload and token registration/delivery recovery; tap reads current state. Change an approval before tap and verify the old action cannot execute; one fresh exact press executes once.
5. English/Thai, safe areas, keyboard, accessible labels/loading/error/empty/reconnect and denied/restored permissions through the native app. Existing browser/shared-client regressions remain green.
6. Separate #431 exact-device checklist: keystore/backup/reinstall behavior, real audio capture/Thai accuracy, signed APNs/FCM token and physical delivery/tap, OS background restrictions and real account/2FA. #432 owns owner-host cutover. Never promote a simulator, protocol fixture or provider HTTP acceptance into device evidence.

Freeze exported TSDoc/interfaces and retain exact build commands/results in the eventual immutable proof. No completion is inferred from this contract or an unexecuted checklist.

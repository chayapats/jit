# REL08 read-only schedule feed contract, v1

Owner: Jit #120 (S10 REL08). Status: implemented on the issue branch. Spec: [S10](../specs/S10-reliability-and-owner-integrations.md) (S10-D01, S10-AC09). Decision: [ADR 0035](../adr/0035-owner-integration-surfaces.md) "Read-only .ics feed". Requirements: FR-34, FR-12, NFR-07, NFR-09, NFR-10.

Uses `jobs.configured_schedules/v1` (`nextScheduledInstant`, `listSchedules`) and `web.settings_ia/v1` (a new Settings section). Neither contract changes.

## `app.schedule_feed/v1`

`src/schedule-feed.ts`, schema 30 `schedule_feed` (one installation-wide singleton row).

```ts
interface ScheduleFeed { enabled: boolean; includePurpose: boolean; revision: number; tokenCreatedAt: number | null; updatedAt: number | null }
type FeedCommand =
  | { kind: "feed.create" | "feed.rotate" | "feed.disable"; requestId; projectId: null; expectedRevision; payload: {} }
  | { kind: "feed.set_include_purpose"; requestId; projectId: null; expectedRevision; payload: { includePurpose: boolean } };
interface FeedReceipt { feed: ScheduleFeed; url: string | null }
Application.scheduleFeedSettings(actor): ScheduleFeed;
Application.execute(actor, command: FeedCommand): FeedReceipt;
Application.scheduleFeed(token): { events; includePurpose; language } | null;   // no actor: the token is the credential
```

- With no row the feed is off: revision 0, `includePurpose: false`.
- Every command is an owner command: Web session, `Origin`, CSRF, `expectedRevision` against the feed row (`stale_revision`), idempotent by request id (`request_id_conflict`), audited. A wrong shape is `invalid_feed_command`.
  - `feed.create` works only while the feed is off (`feed_already_enabled`) and mints a token.
  - `feed.rotate` ("New URL" while on) mints a new token and replaces the old one in the same transaction (`feed_not_enabled` while off).
  - `feed.disable` ("Turn off") deletes the token hash (`feed_not_enabled` while off).
  - `feed.set_include_purpose` changes only the title option; it works whether the feed is on or off.
- Nothing else writes the row. Model output, retrieved content and schedule payloads cannot create, rotate or widen the feed.

## Token storage (the decision this ticket had to make)

ADR 0035 asks for the token to be "encrypted at rest using the existing secret handling", but `main` has no at-rest encryption helper; `src/security/credentials.ts` only redacts. The two options the ticket offered were a `0600` secret file outside backups (like the Telegram bot token) or a stored SHA-256 with the URL shown once. **This contract takes the stored hash**:

- The token is 32 bytes from the platform CSPRNG in base64url (43 characters). The row stores only `sha256(token)` as 64 hex characters (`CHECK`ed by the schema). With 256 bits of entropy, the hash cannot be turned back into a working URL, so a database copy alone never exposes the feed.
- The plaintext token leaves the service exactly once: inside the response to the `feed.create` or `feed.rotate` command that minted it, as the absolute `url` (`<JIT_ORIGIN>/feeds/schedules/<token>.ics`). The stored command receipt is written with `url: null`, so a replayed request id answers the same state with `url: null`. The settings page never shows a URL again; if the owner loses it, **New URL** makes another and the old one stops.
- `schedule_feed` is in `installationScopedTables` and classified `exclude` in `backupImageTables`. A backup image never carries the row, and restore or upgrade activation keeps the live row. A restore therefore can never revive a rotated or turned-off URL.
- Compared with a secret file, this needs no file lifecycle (atomic replace, permissions, restore consistency between the file and the database) and keeps every write inside the same SQLite transaction as its receipt and audit row.

## Feed route

`GET /feeds/schedules/<token>.ics` is answered before any session, cookie, sign-in redirect or restore redirect:

- The path must be exactly `/feeds/schedules/` + 43 base64url characters + `.ics`. Anything else under `/feeds/` (another shape, another method) is `404`.
- The check hashes the presented token and compares the two 32-byte digests with `timingSafeEqual`. A malformed token is compared against an all-zero digest, so a malformed, wrong, rotated or turned-off token all take the same path and answer the same bodiless `404`.
- `200` has `Content-Type: text/calendar; charset=utf-8` and keeps the shared headers: the ADR 0028 CSP, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Referrer-Policy`. No response sets a cookie; a cookie on the request is ignored.
- While a restore is incomplete, or if storage fails, the answer is a bodiless `503` with `Retry-After: 60`. It reveals nothing about the token.
- Reading the feed writes nothing: no audit row, receipt, session or job. Nothing in the service logs the request path; the handler has no request logging, and the feed branch never reaches the HTML error page.
- The calendar's language follows the owner's saved language, then `Accept-Language`, with Thai as the fallback (`Content-Language` says which).

## Feed contents

- Occurrences of every `active` schedule with remaining budget, in every project, in `(now, now + 30 days]`. They are computed only by `nextScheduledInstant`, applied repeatedly from `now`, so DST gaps (shifted forward) and overlaps (first instant) are exactly the engine's. A schedule contributes at most its `occurrencesRemaining`. `paused` and `revoked` schedules contribute nothing.
- Events are ordered by instant, then schedule id, and capped at `feedLimits.events` (5000) per response.
- Each `VEVENT` has exactly `UID`, `DTSTAMP`, `DTSTART`, `SUMMARY` and `TRANSP:TRANSPARENT`:
  - `UID` is `<scheduleId>-<revision>-<instant>@jit` (instant in epoch milliseconds), stable across refreshes until the schedule's revision changes.
  - `DTSTART` is UTC (`YYYYMMDDTHHMMSSZ`). `DTSTAMP` is the schedule's `updatedAt` in UTC.
  - `SUMMARY` is the kind label (`common.reminder` / `common.summary`) and the project name, joined by ` · `. The purpose is appended only while `includePurpose` is on.
- No other field enters the feed: no reminder text, messages, topics, sources, memory, routes or project ids.
- The calendar has `VERSION:2.0`, `PRODID:-//Jit//app.schedule_feed/v1//EN`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME` (`settings.feed_calendar_name`) and a one-hour refresh hint (`REFRESH-INTERVAL`, `X-PUBLISHED-TTL`).
- RFC 5545 text: `\`, `;`, `,` and line breaks are escaped; other control characters become spaces. Lines end with CRLF and fold at 75 octets without splitting a UTF-8 character.

## Settings

`GET /settings/feed` is the **Calendar feed** section (`settings.feed`), after Telegram. It shows whether the feed is on and since when, the revision, **New URL** (`POST /settings/feed/create` while off, `/settings/feed/rotate` while on), **Turn off** (`POST /settings/feed/disable`, only while on) and the include-purpose checkbox (`POST /settings/feed/purpose`; an unchecked box means off). All are plain forms, so they work without `app.js`.

- New URL answers `200` with the same page, showing the minted URL once in a read-only field. Turn off and the purpose form answer `303` to `/settings/feed`.
- JSON: `GET /api/settings/feed` returns `ScheduleFeed`. `POST /api/settings/feed/(create|rotate|disable|purpose)` takes `{ requestId, expectedRevision[, includePurpose] }` with the CSRF header and returns `FeedReceipt`.
- `POST /settings/feed` (the page path) is `404`, as for every settings page.
- Owner-visible strings are `settings.feed*` and `error.feed_already_enabled`, `error.feed_not_enabled` and `error.invalid_feed_command` in both `th` and `en`.

## Evidence

`tests/schedule-feed.test.ts` covers the following:

- With a fake clock, an hourly, a daily `Asia/Bangkok` and a daily `America/New_York` schedule across the 2026-11-01 overlap and the 2027-03-14 gap, the parsed `DTSTART` lists equal the engine's `nextScheduledInstant` sequence for 30 days. A budgeted schedule ticked at each feed instant materializes exactly those instants.
- Paused, revoked and out-of-horizon schedules produce no `VEVENT`.
- A wrong, flipped, malformed, rotated or turned-off token and a non-`GET` method are a bodiless `404`; no response sets a cookie; reading writes no audit row; console output during the requests holds no feed path or token.
- Only the hash is stored: no table holds the token, the receipt replay has `url: null`, and the row is installation-scoped and excluded from backup images. An incomplete restore answers `503`.
- Default titles have only the kind and the project name. With include-purpose on, the purpose appears, escaped. Reminder text, topic titles, ids and routes never appear.
- A strict ICS reader checks CRLF, lines of at most 75 octets, unfolding, balanced components, exactly the five event properties and strict TEXT escaping, and reads every event back.
- The settings forms work without `app.js` in Thai and English: New URL shows the URL once, rotate stops the old URL, purpose and Turn off answer `303`, and CSRF, `Origin`, sign-in and the page-path `POST` are refused.

`tests/web-ui.test.ts` renders `/settings/feed` in both languages and both themes, and `tests/web-ux02.test.ts` walks it through the route inventory.

## Remaining risks

- A feed URL is a bearer credential in the calendar app and on every device the calendar syncs to. Anyone who copies it can read the titles until the owner presses New URL or Turn off.
- Schema 30 follows REL06's schema 29 (`local_api_settings`); any later ticket that also takes 30 must renumber its migration.
- Real calendar apps over the VPN are opt-in owner evidence (S10 test plan), not covered by deterministic tests.

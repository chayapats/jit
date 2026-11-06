---
status: accepted owner decision 2026-11-06; implementation tracked by NOTIFY16-01 (#441)
date: 2026-11-06
scope: S16-D10; S16-F18/AC18 (rewritten); FR-04/09/11/15/28/30; NFR-05/06/07/09
supersedes: ADR 0072 (S15 Telegram owner channel), the Telegram transport of the legacy/S14 delivery outbox, CHANNEL16-01 (#424)
---

# Remove Telegram; notify through Web Push

## Context

Jit grew a Telegram channel in the legacy runtime and again in S15 (CHAN15-01, ADR 0072). S16 planned to extend it with attachments and results (#424). On 2026-11-06 the owner decided Jit should follow the Rakazo/Grok app experience instead: people use the Jit app (Web/PWA now, desktop and mobile later), not a messaging bot.

## Decision

- Remove every Telegram transport, binding, setup step, settings page, i18n key, test and current document. Historical ADRs keep their text with this supersession noted.
- Installed stores keep their Telegram tables and rows inert: nothing reads, migrates or drops them, and backup/restore continue to succeed. The owner revokes old bot tokens at BotFather.
- Notifications move to Web Push from the installed PWA on the S15/S16 stack: a per-installation VAPID key generated on first use, authenticated per-device subscriptions, RFC 8291/8292 delivery, durable notice identities for retry, removal of expired subscriptions. Payloads carry a generic localized title and an opaque path only; opening one lands on the authenticated conversation, which re-fetches current state.
- A notification never approves or starts anything. Approval happens in the conversation (ADR 0084).
- The legacy and S14 runtimes keep their durable in-app attention without a push transport.
- S16-F18/AC18 changes from "messaging surfaces" to "notifications"; FR identifiers are unchanged.

## Consequences

- Browser push services (Apple, Google, Mozilla) receive encrypted payloads and timing metadata; they never receive private content.
- Native mobile notifications remain MOBILE16-01 (#426).
- One less transport to secure, test and operate; no bot token in protected state.

## Alternatives considered

- *Keep Telegram as an optional extra*: keeps a second owner-identity surface and its tests alive for a feature the owner no longer wants.
- *In-app only, push later*: simpler, but needs-you would go unseen until the owner opens the app.

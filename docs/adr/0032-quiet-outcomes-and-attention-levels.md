---
status: accepted
scope: S10 delivery and scheduled-run engineering choices; extends ADRs 0014 and 0017
---

# Typed quiet/failed outcomes, attention levels and notifying once

FR-26 and FR-28 cut notification noise without hiding anything. ADR 0014 still holds: there is one logical intent per report, remote outcomes stay separate, and `unknown` is never retried blindly. The concepts come from openbot's quiet routine runs and notify-once channel attention ([nightly-labs/openbot](https://github.com/nightly-labs/openbot)). No code was reused.

## Selected implementation

- **Typed outcome.** The structured output of a `schedule.summary` run gains a closed `outcome` field: `report`, `no_update` or `failed` with a bounded `reason`. Quietness is never decided from free text. A run that says "nothing new" in prose is still a `report`. An unknown value counts as `report`. A malformed outcome counts as `failed` with reason `invalid_outcome`.
- **No intent for `no_update`.** A `no_update` run commits its occurrence record and run evidence in the same fenced transaction, but does not call `commitDeliveryIntent`. It does not count as unread and does not change topic previews. Occurrence history shows it with its own label.
- **Never quiet.** The following are never quiet and are always delivered:
  - `failed` outcomes
  - provider errors
  - stopped runs
  - `not_admitted` runs
  - owner-run and test summaries
  - reminders, because a reminder is the owner's own text
- **Attention levels.** The owner sets a revisioned level per channel binding (Telegram, and Web/PWA) through an owner command. There are two levels:
  - `all` delivers everything.
  - `needs-me` delivers only owner-waiting items: a pending question, a proposal card, a decision awaiting acceptance, a failure, or a blocked result.

  The level filters only which intents are *created*. It never touches reports, decisions or history. Intents that already exist are not retroactively cancelled.

  **Revised 2026-10-29 (#180, confirmed S12-D06).** Without a saved level a channel is `needs-me`, so quiet team work notifies only what waits on the owner. A saved level is kept and never migrated. Owner clarification on the same date: owner-configured schedule reports and PR finding alerts are `needs_owner` (explicitly requested), so both saved and unset `needs-me` still notify them. Existing dedupe remains unchanged.
- **Notify once.** A Jit reply and the discussion it admitted form one *work group*.
  - Intermediate events, such as a specialist finishing or a partial synthesis, create no intent.
  - One intent is created when the group has no open work (queued, running and waiting participations are all zero) and its final reply is committed.
  - If the group stalls on the owner, its owner-waiting intent is created immediately.
  - When the owner answers from another channel, that intent is resolved: unsent intents are cancelled, and sent ones are marked resolved.

## Alternatives and consequences

- Detecting text markers such as `[[no-update]]` is fragile across languages, so the typed field is the only path.
- Notifying on every specialist event was rejected, because that is the noise S10 removes.
- A group needs a stable group id carried from the reply to the discussion. The schema adds an attention-level table and a `work_group_id` column on reply and discussion records, behind the snapshot-before-DDL migration.

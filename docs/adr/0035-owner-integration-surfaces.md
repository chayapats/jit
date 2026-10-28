---
status: accepted
scope: S10 owner-side integration engineering choices; extends ADR 0010, ADR 0028 and the PR monitor
---

# Owner-side integration surfaces: loopback API and CLI, signed webhooks, and a read-only schedule feed

FR-32 to FR-34 add three ways for data to move into or out of Jit. None of them adds authority: each one maps onto an existing owner command or query. The ideas come from openbot's local scripts API, webhook routines and routine calendar feed ([nightly-labs/openbot](https://github.com/nightly-labs/openbot)). No code is reused.

## Loopback API and `jit` CLI

- **Setup.** The API is off by default. The owner enables it with a revisioned owner command.
- **Binding and credentials.** While enabled, it binds `127.0.0.1` on a free port. It writes `url`, `token` and `headers` to `<data>/local-api/` (folder `0700`, files `0600`). Every start rotates the token. Disabling the API or stopping the service removes the files.
- **Request checks.** Before reading the token, the service refuses any request that has an `Origin` header or a non-loopback `Host`. Body size and request rate are capped.
- **Routes.** Each route reuses an existing owner command and its receipt:
  - Send a message to a topic. This calls `message.send`, with a client retry key that is valid for 24 h.
  - Read the state of a reply or a delivery.
  - Read pending owner actions.
  - Accept or dismiss a proposal by its exact id and revision.

  Write routes answer `202` with the receipt id.
- **CLI.** The `jit` subcommand of `src/main.ts` has three commands:
  - `ask <topic|general> [--wait] [--timeout] [--id key] [--json]`
  - `status <id>`
  - `pending`

  Exit codes:

  | Code | Meaning |
  | --- | --- |
  | 0 | Done |
  | 1 | Failed or refused |
  | 2 | Usage error |
  | 3 | Waiting on the owner |
  | 4 | The wait timed out; the work continues |
  | 5 | Jit is not running, or the API is disabled |
- **Scope.** This is an entry point for scripts the owner runs. It is not an agent tool, and it does not grant shell access.

## Signed webhooks

- **Setup.** The owner creates a webhook trigger per PR monitor. Each trigger has an opaque route id and an HMAC-SHA256 secret. The secret is shown once and stored redacted.
- **Validation.** A request must pass all of these checks, or it is rejected with no state change:
  - a valid signature
  - a body of at most 32 KiB
  - a delivery id not already received in the last 7 days
  - the rate limit
- **What a valid request does.** It only schedules an early `pollMonitorCatchUp`. The payload is never used as review input and never reaches a model. The poll result stays the source of truth.
- **Who can send.** Jit sits behind the VPN, so senders must be able to reach it there, for example a self-hosted runner or a local script. A public relay is out of scope.

## Read-only `.ics` feed

- **Setup and access.** The owner creates the feed. Its token is encrypted at rest using the existing secret handling. The URL is `/feeds/schedules/<token>.ics`.
- **Contents.** The feed lists the next 30 days of occurrences for active schedules as UTC events. Occurrences are computed by `jobs.configured_schedules/v1` (`nextScheduledInstant`). By default an event title is the schedule kind plus the project name; including the purpose text is an owner option.
- **Token handling.**
  - A wrong token returns 404.
  - The URL never appears in logs.
  - **New URL** rotates the token, and **Turn off** deletes it.
- **Authentication.** The feed needs no session, because calendar apps cannot send cookies. The path token is the only credential, and the feed is read-only.

## Alternatives and consequences

- A public webhook endpoint or relay would expose the Pi, so it is deferred.
- A CLI that edits SQLite directly would bypass receipts, so it is rejected.
- Each surface adds finite operator limits: request rate, body size, the dedupe window and the feed horizon.
- Each surface also needs tests showing that it can do nothing the owner's Web session cannot.

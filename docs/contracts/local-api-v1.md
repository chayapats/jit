# REL06 loopback API and `jit` CLI contract, v1

Owner: Jit #118 (S10 REL06). Status: implemented on the issue branch. Spec: [S10](../specs/S10-reliability-and-owner-integrations.md) (S10-AC07). Decision: [ADR 0035](../adr/0035-owner-integration-surfaces.md), with the Web session, Origin and CSRF rules of [ADR 0007](../adr/0007-first-web-slice.md) and [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md). Requirements: FR-32, FR-15, FR-17, NFR-07, NFR-09, NFR-10.

Uses `app.conversation/v1` (`message.send`), `app.jit_reply/v1` (reply read model), `app.command_receipts/v1` and the dispatch proposal commands of `app.dispatch_allowance/v1` without changing them.

## `app.local_api/v1`

| Part | Entry and behavior |
| --- | --- |
| Setting | `src/local-api/settings.ts`, schema 29 `local_api_settings` (one row). `Application.localApi(actor)` returns `{ enabled, revision, updatedAt }`; with no row the API is off at revision 0. `Application.execute(actor, { kind: "local_api.set", requestId, projectId: null, expectedRevision, payload: { enabled } })` returns `{ localApi }`. It is revisioned (`stale_revision`), idempotent by request id (`request_id_conflict`), validated (`invalid_local_api`), audited and refused during upgrade or restore fences. HTTP: `/settings#local-api` (section of the general settings page), `POST /settings/local-api` (form; an unchecked box means off; 303 back), `GET`/`POST /api/settings/local-api` (JSON, CSRF header). Same session, `Origin` and CSRF checks as every owner form. The API itself cannot change this setting. |
| Listener | `src/local-api/server.ts` `LocalApiListener`, started by `serveCommand` (`src/ops/serve.ts`). It follows the setting every 500 ms. While on, it binds `127.0.0.1` on a free port (never another address) and writes `url`, `token` and `headers` to `<data>/local-api/`, where `<data>` is the folder of the installation database. The folder is `0700` and must be a real folder (not a symlink); each file is written `0600` to a temporary name and renamed. A new token (32 random bytes, base64url) is made on every start, on every change of the setting revision and on every owner credential generation change. Turning the API off or stopping the service stops the listener and removes the files. A stale set from a crash is removed at the next start. Cleanup touches only a real folder: if `<data>/local-api` is a symlink, nothing is removed through it, and turning the API on fails with `local_api_directory_invalid` instead of writing the token through it. The token never appears in logs, output, the database or images. |
| Actor | `Application.issueLocalApiActor()` gives the listener a Web-channel owner actor bound to the setting revision and the owner generation. Every operation rechecks both, so turning the API off or resetting the owner revokes it at the next request, before the listener stops. It reaches only what a Web session reaches, and only through the routes below. |

### Request pipeline

Each request passes these checks in this order. A failing check stops the request before the next one runs.

1. **Browser check.** Any `Origin` header, any `Sec-Fetch-Site` header, or a `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` → `403 origin_rejected`. The token is never read (DNS rebinding and browser pages cannot reach the API).
2. **Body cap.** A declared or actual body over 16 KiB → `413 request_too_large`.
3. **Rate cap.** At most 30 requests per 60 s fixed window, counted after checks 1–2 → `429 rate_limited` with `Retry-After`.
4. **Token.** `Authorization: Bearer <token>` compared in constant time (`tokenCheck.verify`, sha256 digests and `timingSafeEqual`) → `401 authentication_required`.
5. **Route.** Unknown path → `404 not_found`; known path, wrong method → `405 method_not_allowed`.

Steps 1–4 use the shared inbound guard `src/security/inbound.ts` (`browserRequest`, `readCappedBody`, `FixedWindowRate`, `constantTimeEqual`), which `app.webhook_triggers/v1` also uses. Limits are `localApiLimits` (`bodyBytes` 16384, `requests` 30, `windowMs` 60000, `waitMs` 25000, `retryKeyMs` 24 h). Errors answer `{ error: <code> }` with the `AppError` status; internal errors answer `500 request_failed` and disclose nothing.

### Routes (`localApiRoutes`)

| Route | Maps onto | Behavior |
| --- | --- | --- |
| `POST /v1/topics/:topic/messages` | `message.send` | Body `{ text, clientRequestId? }`, nothing else. `:topic` is a topic id or `general` (the General space topic; `setup_incomplete` before setup). The project comes from the topic, and the expected revision from its current state. The request id is `lapi_` + the first 48 hex characters of sha256(`jit.local_api.v1:` + `clientRequestId`), or random without a key. A key that already committed returns the same receipt with `replayed: true` for 24 h after its commit, even after a restart; the same key with another topic or text is `request_id_conflict`; after 24 h it is `retry_key_expired` and never sends a second message. Answers `202 { receiptId, replayed, projectId, topicId, messageId }`. |
| `GET /v1/replies/:receipt[?wait=s]` | `Application.messageReceipt` + `Application.replies` | Jit's reply to the message the receipt committed. `wait` (0–25 s) holds the request while the reply is `thinking`. Answers `{ receiptId, projectId, topicId, messageId, outcome, answer, pending, reply }`: `outcome` is `running` (thinking), `done` (answered, nothing waits), `waiting_on_owner` (blocked, or answered with a dispatch, role or promotion proposal still `proposed`), or `failed` (stopped, failed or not admitted). `answer` is the committed reply text. `pending` lists `{ kind, id, revision }`. |
| `GET /v1/pending` | `Application.pendingActions` | Dispatch proposals still `proposed` (id, project, topic, revision, reason, roles) and jobs `waiting` on the owner, newest first, at most 50 of each, with `more` flags. Identities and reason codes only. |
| `POST /v1/proposals/:proposal/accept` | `dispatch.proposal.accept` | Body `{ revision, roleIds?, clientRequestId? }`. `revision` must be the exact proposal revision (`stale_revision`). Without `roleIds` all proposed roles are accepted. Starts the read-only specialist analysis the owner chose, exactly as the card's form. `202 { receiptId, proposal: { id, state, revision } }`. |
| `POST /v1/proposals/:proposal/dismiss` | `dispatch.proposal.dismiss` | Body `{ revision, clientRequestId? }`. `202` as above. |

Only dispatch proposals are reachable. Role proposals create roles and promotion proposals create projects, so they stay in the Web. No route changes roles, routes, access, persona, settings or configuration, and nothing runs a command on the host. The route table test enumerates this list.

## `jit` CLI

`src/local-api/cli.ts`, dispatched by `src/main.ts`:

- `ask TOPIC|general [text…] [--wait] [--timeout 30m] [--id KEY] [--json]`. Text comes from the arguments, or from standard input when none is given. `--timeout` (`ms`, `s`, `m`, `h`; at most 24 h; default 30 m) requires `--wait`. Without `--id` a random key is used for the request's own retries.
- `status RECEIPT [--json]`. `status` without a receipt, or with `--service-config` first, stays the operator status command.
- `pending [--json]`.

The installation is the one `JIT_DATABASE` names, or `--service-config <path>`. The CLI reads `url` and `headers` on every call and never opens SQLite. It sends the token only to an `http://127.0.0.1:<port>` URL and never prints it. A `401` makes it read the files again once, which covers a token rotated by a restart. `ask --wait` long-polls `GET /v1/replies/:receipt?wait=…`; when the listener is gone mid-wait it reads the files again every second until the deadline, so a service restart does not end the wait. A `429` waits for `Retry-After` and retries: under `--wait` until the deadline, otherwise for up to one rate window (65 s); a send retried this way keeps its retry key, so it stays one message.

| Exit | Meaning |
| --- | --- |
| 0 | Done: the answer was printed; `ask` without `--wait` printed the receipt id; `status` of a reply that is still thinking; `pending` read. |
| 1 | Failed or refused: an API error code, or the reply was stopped, failed or not admitted. |
| 2 | Usage error: unknown flag, bad topic, receipt, key or duration, `--timeout` without `--wait`, or no text. |
| 3 | Waiting on the owner: a pending proposal or a blocked reply. The answer, if any, is printed and the pending items are named. |
| 4 | The wait timed out; the work continues (`jit status RECEIPT` later). |
| 5 | Jit is not running, or the API is off (files missing, connection refused, or the token rejected twice). |

Human messages use the `local_api.cli_*` dictionary keys in Thai, or English when `LC_ALL`, `LC_MESSAGES` or `LANG` starts with `en`. `--json` prints one JSON object with an `outcome` field (`pending --json` adds `outcome: "done"` to the pending list) (`accepted`, `done`, `running`, `waiting_on_owner`, `failed`, `refused`, `timed_out`, `unavailable`).

## Schema

Schema 29 adds `local_api_settings (id = 1, revision > 0, enabled 0|1, updated_at)`, classified `include` for backups. Existing installations get it through the owner-authorized staged upgrade (`ops.schema_migrations/v1`) and keep the API off.

## Evidence

`tests/local-api.test.ts`, with a real loopback listener, a temp data folder, a scripted host and a fake clock:

- the owner command (replay, stale revision, validation, audit); files with modes 0700/0600 while on, gone after off and after stop; token rotation on every start; immediate revocation when turned off;
- `Origin: http://evil` with a valid token → 403 and `tokenCheck.verify` never runs (spy); `Sec-Fetch-Site` and `Host: example.com` → 403; a rebinding `Host` in-process → 403 before the token; oversize body → 413; the 31st request in a window → 429, and the next window admits again;
- the same retry key twice, again after a store/application/listener restart → the same receipt and one owner message; a different text → `request_id_conflict`; after 24 h → `retry_key_expired`;
- the route table maps onto existing commands and reads; role, route, shell, tool, access and settings paths → 404; extra body fields → `invalid_body`;
- replies, pending items, dismiss and accept at the exact revision, stale and closed proposals;
- the Web settings form with Origin and CSRF;
- a symlinked `local-api` folder: no cleanup or token write goes through it;
- the CLI in-process with a fake clock: a 429 waits `Retry-After` and succeeds, and a retried send stays one message;
- the CLI in a subprocess: `ask --wait` → 0 with the answer; JSON and `status`; `--id` replay; a pending dispatch proposal → 3; `--timeout 1s` → 4; a restart in the middle of `--wait` → 0; bad flags → 2; unknown receipt → 1; API off → 5. The token never appears in CLI output.

Run `bun test` and `bun run typecheck`.

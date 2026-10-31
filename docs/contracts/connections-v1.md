# EXE08 owner-managed connections, v1

Owner: Jit #129 (S11 EXE08). Status: implemented on the issue branch. Decision: [ADR 0037](../adr/0037-access-levels-approvals-and-connections.md) § Connections. Spec: [S11](../specs/S11-execution-access-and-tools.md) (S11-D03, D06, D08, S11-AC06, S11-AC09). Requirements: FR-38, NFR-07, NFR-08, NFR-09, NFR-14.

Uses `app.access_level/v1` (channel attribution), `ops.execution_config/v1` (`execution.secretsDirectory`) and `ops.backup_manifest/v1`. The Web settings page is EXE11; using a connection for an effect is EXE07; MCP sidecar spawn is EXE12.

## `app.connections/v1`

`src/exec/connections.ts`; schema 34 `connections(id, kind, label, project_scope_json, revision, secret_state, created_at, rotated_at, removed_at)` and append-only `connection_audit(sequence, connection_id, action, purpose, channel, created_at)`.

- **Kinds.** `github_token`, `deploy_secret`, `mcp_env`, `web_search_key` (schema 42).
- **Values are never in SQLite.** Each lives in `<execution.secretsDirectory>/<connectionId>`. `ConnectionVault` keeps the directory 0700 and owned by the service uid, writes each value atomically (`O_CREAT|O_EXCL|O_NOFOLLOW` staging file with mode 0600, fsync, rename — a symlink at the path is replaced, never followed) and reads one only after `lstat` and `fstat` agree on a regular, service-owned file of mode 0600 or narrower, opened with `O_NOFOLLOW`. A symlink, another owner or a wider mode is `connection_vault_unsafe` (503). The vault refuses a directory inside or containing the state, backup, ledger or execution directories — comparing both lexical and real locations — and any vault path reached through a symlinked component, so a symlinked parent cannot alias values into a box, backup or export (ADR 0025).
- **No read-back.** `Application.connections(actor)` and every receipt carry metadata only (`secret: "empty" | "set"`). The receipt identity of `set_secret`/`rotate` omits the value, so no digest of a value is stored either.

## Commands

All are `{ kind, requestId, projectId: null, expectedRevision, payload }` through `Application.execute`, with an owner receipt and one `audit` row; a replayed request id returns the first receipt. **Every command, and the list, is Web only**: the Telegram channel and the local API (`local-api`) get `connection_requires_web` (403), and nothing reaches the vault.

| Command | `expectedRevision` | Rules |
| --- | --- | --- |
| `connection.create { kind, label, projectScope }` | 0 | `label` 1–80 characters without control characters or anything credential-like; `projectScope` is null (every project) or 1–32 existing project ids (`project_not_found`). |
| `connection.set_secret { connectionId, secret }` | connection revision | Needs an empty connection (`connection_secret_exists`). The value is trimmed and must be 8–8192 bytes without NUL (`invalid_connection_secret`). |
| `connection.rotate { connectionId, secret }` | connection revision | Needs a stored value (`connection_secret_missing`); sets `rotatedAt`. |
| `connection.remove { connectionId }` | connection revision | Deletes the file, sets `removedAt`; later commands are `connection_removed`. A file that cannot be deleted (anything but already missing) aborts the command, which then records nothing. |
| `connection.test { connectionId }` | connection revision | Metadata-only file verdict in the receipt: `present`, `missing` or `unsafe`. No network call. |

`stale_revision` (409) when the revision moved; `connection_not_found` (404); `connection_vault_not_configured` (503) without `JIT_EXECUTION_SECRETS_DIR`.

HTTP (JSON; same session, Origin and CSRF rules as the other owner APIs): `GET /api/connections`, `POST /api/connections` `{ requestId, kind, label, projectScope }`, `POST /api/connections/:id/{secret|rotate}` `{ requestId, expectedRevision, secret }`, `POST /api/connections/:id/{remove|test}` `{ requestId, expectedRevision }`.

## `releaseConnection`

```ts
releaseConnection(tx, connectionId, purpose, vault, { projectId?, now? }): { connectionId, kind, secret }
```

The only reader of a value. It has no route, command or read model. `purpose` must be `effect:<cardId>` (the effect executor, EXE07) or `mcp:<serverId>` (MCP sidecar spawn, EXE12), or `web:<providerId>` (WEB01 search); anything else is `connection_purpose_invalid` and nothing is read or recorded. A removed or empty connection is `connection_unavailable`; with `projectId`, a connection scoped to other projects is `connection_out_of_scope`. Every release appends a `released` audit row with the purpose in `tx`, so a rolled-back use leaves no row.

## Redaction guard

`src/security/secret-fingerprints.ts`. Each value is fingerprinted when it is set or rotated and, at application start, for every stored value: the registry keeps only its length, a rolling hash and an HMAC under a random per-process key (plus the same for each line of 16+ characters of a multi-line value). `containsCredential`/`findCredential` (`connection_secret`) and `redactCredentials` consult it, so every existing user of the shared detector — exports, PR evidence, alerts — sees stored values. In addition:

- **Delivery:** `commitDeliveryIntent` redacts stored values before it commits or sends anything.
- **Prompts:** `describeEffectiveRun` (the Schway bridge) redacts sections, sources and the input.
- **Tool results:** the service box backend redacts command output and search lines (`exec.box_backend/v1` `redact`).
- **Logs:** service log lines go through `logLine` (`src/security/log.ts`), which applies `redactCredentials`.

## Tests

`tests/connections.test.ts`: lifecycle and file modes, symlink and mode refusal, colliding vault locations, Web-only checks for Telegram and the local API plus the JSON API, release purposes and audit, backup image and export inspection, log/delivery/prompt/box-output redaction fixtures that echo a value, boot fingerprinting, migration 32 → 34 and dictionaries.

## Not in v1

- Redaction matches a value as stored (or one line of it); an encoded or split echo (base64, a value cut across two messages) is not recognised.
- A crash between writing a value file and committing its revision leaves the file ahead of the row; the next `set_secret` or `rotate` overwrites it.

[Web search settings](web-search-settings-v1.md) reuse these one-way vault commands and metadata.

S14 CODE14-02 adaptation (schema 14): app.git-effects/v2 reuses ConnectionVault, normalizeSecret and the same fingerprint/write-only/no-read-back model with typed repository resource scope, not a legacy Project. New S14 git.connection.* commands and tables are separate from the legacy commands above. Revision-specific opaque vault files and an independent connection-revision ledger prevent old approvals using a substituted/restored token. See app.git-effects-v2.md for exact commands, secret-free retry identity, release audit and rollback limitations; no legacy API/schema meaning changes.

# EXE03 box runner, v1

Owner: Jit #127 (S11 EXE03). Status: implemented on the issue branch. Decision: [ADR 0036](../adr/0036-execution-box-and-runner.md) § Runner protocol. Spec: [S11](../specs/S11-execution-access-and-tools.md) (S11-D01, D04, D05, S11-AC01, S11-AC02). Requirements: FR-36, NFR-14, NFR-07.

## `jit.box.runner/v1`

`ops/box/runner` is a POSIX `sh` script installed in the `base` image target at `/opt/jit/runner` with mode 0555. It uses only tools of the image: `jq` for JSON, coreutils, `find`, `grep`, `ripgrep` for `search`, `perl` (perl-base) for process groups, and `bash` for `spawn`. It has no model, opens no socket, makes no network call and keeps no state between calls except the process-group file of a running `spawn`.

Jit runs it once per request with `podman exec -i jit-box-<projectId> /opt/jit/runner`. The runner reads **one JSON request** on stdin and writes **one JSON response** on stdout (a single line), then exits 0. A non-zero exit or an unparsable response is a transport failure (`EIO` on the host).

```text
request  = { "v": 1, "op": <op>, ...fields }
response = { "v": 1, "ok": true, "result": <value> } | { "v": 1, "ok": false, "error": { "code": <code> } }
```

The options `--root`, `--tmp`, `--state` and `--op-seconds` (defaults `/workspace`, `/tmp`, `/run/jit-runner`, 60) exist only so tests can run the script on the host against stand-in directories. Jit never passes them, and no `JIT_*` variable reaches the box. Scratch files live in the state directory (`/run`, a 128 MiB tmpfs) and are removed when the response is written.

## Confinement

- Every path is absolute and canonical (no `//`, `.` or `..` segment, no trailing `/`); anything else is `EACCES`. Strings other than file `data` and the `command` may not contain a newline or NUL (`EPROTO`).
- A path must lie under the workspace root, and its `realpath` (for operations that follow it) or the `realpath` of its deepest existing ancestor (for `observe` and `write`) must lie under the real workspace root. A symlink that leaves the workspace is `EACCES` for `stat`, `read`, `observe` with content, `list`, `glob`, `search`, `spawn` and writes through a parent. `realpath` alone reports the resolved path, so Schway refuses the escape with its own `Path is outside the workspace` message.
- A `write` replaces the path's own entry with `rename(2)` (`mv -T`; `mv -h` on BSD hosts in tests): a final symlink is replaced, never followed.
- The one exception is a Schway spill file `schway-bash-<uuid>.log` directly in the temporary directory: `realpath`, `stat`, `read` and `writePrivate` accept exactly that name there. `writePrivate` accepts nothing else.

## Operations

| `op` | Fields | Result |
| --- | --- | --- |
| `realpath` | `path` | `{ path }` |
| `stat` | `path` | `{ type: "file" \| "directory" \| "other" }` (follows symlinks) |
| `read` | `path`, `offset`, `length` (1..1 MiB) | `{ data: base64, eof }` |
| `observe` | `path`, `content` | `null` when no entry exists, else `{ targetExists, token, data? }` (`data` only with `content` and a regular target) |
| `write` | `path`, `data` (base64), `createParents`, `observed?` | `{}`. `observed` absent: no check; `null`: the path must still be absent; a token: the path must still match it, else `ECHANGED`. The new file keeps the old file's mode (or `0666 & ~umask`). |
| `writePrivate` | `path` (spill name only), `data` | `{}` (mode 0600) |
| `list` | `path` | `{ entries: [{ name, type: "file" \| "directory" \| "symlink" \| "other" }], truncated }` (own type, symlinks not followed) |
| `glob` | `cwd`, `dot`, `match?` | `{ files: [relative path], truncated }`: regular files under `cwd`, symlinks not followed; with `dot: false` hidden entries are pruned. `match` is an extended regular expression over absolute paths (`grep -E`), applied before the file cap; the host translates the pattern into it as a superset and still matches the pattern exactly. |
| `search` | `pattern`, `path`, `cwd`, `limit`, `glob?`, `ignoreCase?` | `{ matches: [{ path, line, text }], truncated, failure? }` from `rg --json --no-config` run in `cwd`; `ENOENT` when `rg` is missing; `failure` is ripgrep's stderr when it exits 2. |
| `spawn` | `id` (uuid), `command`, `cwd`, `env?`, `timeoutMs?` | `{ stdout, stderr (base64), exitCode (null after a signal), timedOut, stdoutBytes, stderrBytes }` |
| `kill` | `id` | `{ killed }`: TERM, then KILL 200 ms later, to the process group of that `spawn` |

`spawn` runs `bash -c <command>` with stdin from `/dev/null`, in `cwd`, in a new process group. With `env` the environment is exactly those variables (names `[A-Za-z_][A-Za-z0-9_]*`, values shell-quoted by `jq @sh`; anything else is `EINVAL`); without it, the box's own fixed environment. On timeout the group gets TERM and, 200 ms later, KILL, and the result is `timedOut: true` with `exitCode: null`. Its stdout and stderr are pipes read by the supervisor, which keeps the first 8 MiB of each. 200 ms after the command exits, whatever is left of its group is killed so inherited pipes close. Cancellation from the host is a second runner call, `kill` with the same `id`, which reaches the processes inside the box rather than only the `podman exec` client.

## Fixed limits

| Limit | Value |
| --- | --- |
| Request size | 24 MiB (`E2BIG`) |
| `observe` content and `write` data | 16 MiB (`EFBIG`) |
| `read` chunk | 1 MiB |
| `list` entries / `glob` files / `search` matches | 10,000 / 50,000 / 10,000 (`truncated`) |
| `spawn` stdout and stderr | 8 MiB each kept while the command runs (the rest is counted, not stored); `stdoutBytes`/`stderrBytes` report the full size |
| `search` diagnostics | 64 KiB |
| `glob` and `search` wall time | 60 s (`timeout`): `glob` fails `ETIMEDOUT`; `search` returns its partial matches with `truncated: true` and a `failure` reason |
| `spawn` time | `timeoutMs`, default 30 min, at most 60 min |

Entry names that contain a newline are omitted from `list` and `glob`.

## Error codes

`ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES` (outside the workspace or unreadable), `ECHANGED`, `EINVAL`, `EFBIG`, `E2BIG`, `ETIMEDOUT`, `EPROTO` (malformed request or unknown op) and `EIO`. The host backend maps unknown codes to `EIO`.

## Tests

`tests/box-runner-protocol.test.ts` runs the script on the host against a temporary stand-in: malformed and oversized requests, traversal and non-canonical paths, symlink escapes for every operation, atomic writes with modes and observations, limits, environment exactness, process-group kill and the spill exception. `tests/box-backend.test.ts` runs the SCH01 core-tool golden through `createBoxBackend` over this runner.

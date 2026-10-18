# FEAS01 host evidence contract, v1

Owner: Jit #5. `jit.host.evidence/v1` is implemented on this issue branch, based on APP01 merge `25c5778fb68c0c99827bf7753c0a3c267931ce43`. Downstream eligibility requires this reviewed artifact in the integration base. It makes no Pi, subscription, service boot or target dependency compatibility claim.

Run from the installation root:

```sh
bun run host:evidence inventory --config .local/host-evidence-config.json
bun run host:evidence export --id <evidence-uuid>
```

The local config has exactly these fields (optional `deadlineMs` defaults to 2000):

```json
{
  "installationLabel": "development-host",
  "context": "interactive",
  "testedPath": "",
  "workingDirectory": ".",
  "stateDirectory": ".local/state",
  "deadlineMs": 2000,
  "routes": []
}
```

Supply the actual tested PATH explicitly in local configuration; an empty PATH is a valid deliberate test. The state directory must already exist. Inventory only writes a disposable mode-0600 readiness file there, fsyncs it and removes it. It does not create a state directory, install packages, provision a service, read account credentials, connect to a remote machine or invoke inference. `.local` and `host-evidence` must be private directories without symlinks. This is a current-host command, not an SSH wrapper. Installation-specific paths/evidence never belong in tracked examples or issue bodies.

`context` is `interactive`, `service`, `ci` or `unspecified`, supplied as a declaration; numeric real/effective UID records actual execution identity locally. A context string alone does not prove supervisor startup. Routes are at most eight `{route,model,configured}` records; `route` is a non-sensitive local alias, `model` is a selected exact ID or null (null only when not configured). Aliases/model IDs use a bounded lowercase identifier grammar and reject address/credential-like input. They are not URLs, login state, credential values, policy changes or fallback choices. Record fields contain no PATH/cwd/state-directory strings, usernames, environment or raw process/protocol output.

| Public entry | Behavior |
| --- | --- |
| `parseConfig(raw, root)` in `src/evidence/inventory.ts` | Strict bounded config, resolves explicit local paths. Unknown keys fail. |
| `inventory(config, InventoryPorts)` | Versioned evidence with fake-clock/ID/host/process/dependency/directory seams. One inventory attempt, total deadline 100–10000 ms. Per-route attempts remain zero. Probe failures become safe unverified observations where possible. |
| `localPorts()` | Fixed OS/runtime/package observations; exact `bun --version` argv with no shell and only tested PATH in child environment; output ≤128 bytes and hard process kill on deadline/oversize. Current process Bun and tested-PATH Bun are distinct observations. |
| `routeEvidence(input)` in `src/evidence/contract.ts` | Pure trusted-adapter classifier; route/model/probe class, observation class, maximum/actual attempts, deadline/elapsed time, state and next action. Attempts 1–10 maximum, deadlines 1–60000 ms. Configured access/fixtures/lifecycle observations cannot prove inference readiness. |
| `validateEvidence(value)` | Rejects unknown fields, unsafe values, inconsistent classified states and records over 32768 bytes. Supports separately labeled future probe observations; does not execute them or grant authority. |
| `writeEvidence(root, value)` / `readEvidence(root, id)` in `src/evidence/records.ts` | Private `.local/host-evidence/<id>.json`, exclusive mode-0600 creation, file/directory sync, bounded regular-file reads, no overwrite or unsafe symlink traversal. |
| `exportSummary(value)` | Rebuilds allowlisted facts; drops installation alias and UID, replaces route/model identifiers with local ordinal/redacted markers. No raw diagnostics or arbitrary extra fields. |
| `runEvidenceCommand(args, root, ports?)` in `src/evidence-cli.ts` | Returns `{exitCode,output}`. CLI prints that safe JSON only. Invalid/config/storage failures use fixed codes and next actions; a storage failure returns available sanitized inventory with `stored:false`, never false persistence success. |

Inventory records ID/time, OS/architecture/kernel, process Bun, Bun on tested PATH, exact declared/installed package versions, declared context plus numeric actual identity, working-directory readiness and persistent-state write readiness. This application currently has no runtime npm dependencies; the tool records its two declared development dependencies (`typescript`, `@types/bun`) without running them. Compatibility remains `unverified`. Missing Bun on one PATH means `absent-on-tested-PATH`, not machine-wide absence. Malformed/unreadable/timed-out process data becomes `unverified`. Version grammars deliberately reject unfamiliar release strings rather than copying arbitrary diagnostics.

Route states: `not-configured`, `configured-unverified`, `observed-ready`, `needs-login`, `store-unavailable`, `quota-waiting`, `rejected`, `failed`. Only actual bounded `live-request` + `inference` success can yield observed-ready. It is time-scoped evidence, never a permanent route or whole-host promise. Observation classes also distinguish `inventory`, `fixture`, `service-start`, `credential-read`, `renewal`, `restart`, `reboot`. Readiness and next actions do not authorize login, quota, route/billing substitution, plaintext storage, mutation or reboot. The envelope remains blocked/failed because target compatibility and broader host gates are separate; an observed-ready route can coexist with a blocked host.

Successful CLI execution/persistence exits 0 even if honest readiness outcome is `blocked`; inspect `outcome`, per-route state and `nextAction`. Configuration/record/persistence failure exits 2. Export omits `stored` because it is a projection of a previously stored record. Export is for review before sharing; it does not automatically publish anything.

Deterministic checks: `bun test tests/evidence.test.ts`, `bun test`, `bun run typecheck`. Command fixtures cover ARM64/x64, absent/alternate PATH, malformed output, unavailable state, every route class, finite bounds, stalled process, secret/address/header/env sentinels, invalid/oversized records, symlink/store failure and standalone inventory/export. No SSH, account or network inference is used. Live target/account/reboot evidence remains FEAS02–05 and OPS05.

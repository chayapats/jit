---
status: accepted
scope: APP01 local implementation
---

# Use Bun HTTP and server-rendered forms for the first owner workspace

APP01 needs a runnable owner path without a provider or Schway build. Use Bun's HTTP server, TypeScript, escaped server-rendered HTML/forms and a separate static stylesheet. No browser JavaScript, frontend build pipeline, framework runtime or outbound telemetry is needed for this slice. Future adapters call the same `Application` command boundary; introducing a client framework remains reversible.

Use `bun:sqlite` behind `TransactionStore` for the local application state. Immediate write transactions cover project/group creation, command receipts and bounded audit metadata together. Deferred read transactions give a consistent projection. WAL with `synchronous=FULL` and finite busy timeout provides local writer serialization; this does not make application commits atomic with future Schway session writes.

The alternatives were a client framework plus a separate API service, and JSON files for app state. The first adds deployment/build machinery without a needed interaction; the second would require implementing transactional receipts, revisions and concurrent writes ourselves. The native APIs are documented in [Bun SQLite](https://bun.com/docs/runtime/sqlite) and [HTTP server](https://bun.com/docs/runtime/http/server).

Deterministic evidence in `tests/foundation.test.ts` covers duplicate commands, independent concurrent-process writes, SIGKILL between project/receipt writes, actual SQLite deferred-constraint failure at COMMIT, fresh reopen, pre-migration snapshots, future-schema rejection, origin/CSRF/identity rejection and Thai/English project labels. See [the public application contracts](../contracts/app-foundation-v1.md).

This accepts the HTTP/UI choice and the first local SQLite slice. [ADR 0006](0006-local-transactional-state.md) stays **proposed**: Pi power-loss/restore evidence and memory/search/retention decisions are later milestones. Development limits are finite initial settings, not measured pilot capacity. No provider, host activation, live quota or full-app support is certified by these tests.

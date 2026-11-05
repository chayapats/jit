# S16 owner memory client v1

Implemented by MEM16-01 [#416](https://github.com/chayapats/jit/issues/416) under [ADR 0081](../adr/0081-s16-owner-memory-client.md). It extends the [shared client](s16-client-v1.md) with owner search, inspection, correction and forget over the existing [S15 memory](s15-memory-v1.md) authority and its [file ancestry](s16-file-memory-v1.md). It adds no memory store, extraction path, model/tool command or retention policy. Types live in `src/s16/client/contracts.ts`; the projection is `src/s16/memory.ts`.

## Capability

`s16-client-capabilities/v1` gains the additive optional field `memory`: `{ available: true, contract: "s16-client-memory/v1" }` when the composition supplies the MEM owner port, otherwise `{ available: false, code: "memory_unavailable" }`. The capability revision number is unchanged; older clients ignore the field. When unavailable every memory route refuses `memory_unavailable` (503).

## Operations

All routes inherit the shared client's owner session, exact Host, Fetch-Metadata, no-store and 8 MiB response bound. POST requires exact Origin and current CSRF and rechecks both after the body stream.

| Method / path after `/api/s16/client` | Result |
| --- | --- |
| GET `/memory?q=&kind=&category=&state=&bot=&offset=` | `s16-client-memory/v1` page of at most 50 `ClientMemoryItem`s, the exact parsed `query`, `total` and the Bot IDs that own private items. |
| GET `/memory/:claimId` | `s16-client-memory-detail/v1`: the item with exact `text`/`quote` while active, current file-pin state, correction chain and retained usage counts. Unknown ID: `not_found` (404). |
| POST `/memory/commands` | The existing exact `s15-memory-command/v1` (`memory.impact`, `memory.correct`, `memory.forget`). Returns `s15-memory-impact/v1` or `s15-memory-receipt/v1` unchanged from MEM. |

### Query grammar

Only `q`, `kind`, `category`, `state`, `bot` and `offset` are accepted, each at most once; anything else refuses `invalid_memory_query` (400) rather than widening. `q` is at most 256 characters without control characters. `kind` is `all|fact|inference`, `category` is `all|fact|preference|working_knowledge`, `state` is `active|inactive|all` (default `active`), `bot` is an identifier, `offset` is a non-negative integer. The page size is fixed at 50.

### Search semantics

1. Start from MEM's owner view, which already erases text of forgotten/superseded claims and of claims whose file sources are withdrawn.
2. Apply state, kind and category filters.
3. With `bot`, keep only items whose own scope and every transitive dependency scope is team or that Bot. This runs before relevance scoring and before any snippet is built, so another Bot's private item is never ranked, counted or excerpted.
4. With `q`, match only active text: a normalized substring match scores 100, plus the shared lexical word/trigram score; items below 3 are dropped. Order is score, then newest. Without `q`, newest first.
5. Snippets are at most 280 characters and are empty for every non-active item.

Without `bot`, the owner sees every scope, matching the existing S15 owner memory page. `ClientMemoryItem.state` is `superseded`/`forgotten` from owner commands, `withdrawn` when MEM reports the source withdrawn, else `active`.

### Usage and last use

New MEM context/native/summary/artifact derivatives record an optional creation time `at`. `lastUsedAt` is the newest `at` of a context that included the item; rows written before this contract have no time and report `null`. Usage counts include retired lineage so the owner can see past use. Counts describe Jit's retained lineage only; content already shown to a provider, downloaded or sent elsewhere cannot be recalled.

## Commands and recovery

Commands are explicit and exact-revision. The client never retries. A lost response is reported as an unknown outcome with the original `requestId`; the only offered recovery is sending the same retained command again. MEM's command table returns the original receipt for the same ID and payload and refuses `request_id_conflict` (409) for a changed payload. A changed item refuses `stale_revision` (409); the owner reopens the current item. `memory.impact` is read-only and not recorded.

Correction supersedes: MEM withdraws TEAM ancestry, tombstones the old claim and its derived contexts/summaries/artifacts, and creates a new owner-stated fact that keeps the original scope, resource and file ceilings. Forget does the same without a replacement. In-flight work that bound a now-retired context is refused at its next guard (`memory_context_stale`) instead of publishing. Original conversations are not deleted.

## Client

`JitClient.memory`, `memoryDetail` and `memoryCommand` validate response shapes. The `/s16/memory` route renders the authored memory view (`src/s16/web/MemoryView.tsx`); conversation rows link to it with the retained item preselected. The S15 server-rendered `/memory` page remains for installations without the capability.

## Evidence

`tests/s16-memory-client.test.ts` runs the production composition with scripted models: search/detail/impact/correct/forget through HTTP, correction and forget reaching actual later model input, duplicate/conflicting/stale commands, a forget racing in-flight work, restart, Bot-private search filtering and a team correction following work to another Bot, protected-boundary refusals, unknown-outcome recovery through `JitClient`, and the pure search/filter/paging rules. `tests/s16-memory.browser.test.ts` (opt-in `JIT_S16_BROWSER_TESTS=1`) drives the real bundle in Chrome at 1440 px English and 390 px Thai.

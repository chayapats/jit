# SPACE16-01 scoped search evidence

Issue #428 / parent #392. Runtime implementation:
`d4535a0e9f800fb4ea5f372831a6d8f418517eab`; test-only focus synchronization:
`a6e579fe0156e0e35ccec29961c0c130f629ee40`. The latter waits for actual focus
restoration after the existing animation-frame callback, retaining the same
assertion. Evidence documentation does not change runtime bytes.

## Observable evidence

- **15 search scenarios** in `tests/s16-search.test.ts` exercise real protected
  composition: CHAT beyond 32 rows and 64 conversations, WORK responsibilities,
  routines, active sourced MEM and committed artifacts; exact original source
  opening; private S14 scope and descendants before Bot-filtered counts/facets;
  DATA15/resource/file/forget withdrawals; stale opening/download refusal;
  revision races; original label receipts after response loss/restart; unchanged
  lineage and no new work; candidate overflow; and actual Bot model selection,
  computer-registry generation change and restart retaining IDs/labels.
- **310 deterministic tests passed, zero failed, 4,694 assertions / 24 files**
  at runtime revision above, including all 15 search scenarios. The affected
  client, memory, artifacts, routines, Bots/models, WORK, composed service,
  DATA15, adoption journals, file-memory, desktop boundary/package/worker and
  i18n regressions passed.
- Real Chromium executed **10 distinct browser scenarios** across Search,
  Memory, Routines and Models. Search passed at English 1440px and Thai 390px,
  including Enter/Ctrl+K, filters, label mutation response loss followed by a
  service restart and original read-back, oldest source navigation, forget and
  empty state. Both search layouts had no horizontal overflow or external
  request, no page error and no search data in localStorage. Memory's focused
  final rerun passed **4/4, 52 assertions** after synchronizing its pre-existing
  focus assertion with the actual animation frame; the other six scenarios
  already passed against unchanged runtime bytes. Actual screenshots were
  inspected; private fixture logs/screenshots remain ignored.
- Frozen Bun installation, root typecheck, whitespace and upstream provenance
  validation passed. Provenance validator retained **2 inventoried upstream
  files / 6 licenses**. No dependency, upstream code or asset was added.
- The actual native desktop package was built from clean runtime source and
  its complete seal reverified: `s16-desktop-native-release/v1`, **130 files /
  15,676,176 bytes**, ID
  `fe97401094b2993ef20f1618e97cd3710547a6f489ac408384c719f42142210b`.
  Source was clean at `d4535a0e9f800fb4ea5f372831a6d8f418517eab`, Bun 1.4.2,
  Playwright 1.64.1, lock SHA-256
  `05901663c7a3f9c3fd8e75b26adb6cb147313f41ffdb5417f9531a21ebce3076`.
  This validates native packaging and the updated exact document boundary;
  real browser tests validate the current service's React bundle. It is not
  a new physical-device, account, signing or owner-host deployment receipt.

## Reproduction

```sh
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 30000 tests/s16-search.test.ts tests/s16-client.test.ts \
  tests/s16-memory-client.test.ts tests/s16-artifacts.test.ts \
  tests/s16-routines.test.ts tests/s16-bots.test.ts tests/s16-models.test.ts \
  tests/s15-work.test.ts tests/s15-work-resume.test.ts \
  tests/s15-composition.test.ts tests/s15-memory.test.ts \
  tests/s15-memory-conversation.test.ts tests/s15-disclosure.test.ts \
  tests/s15-disclosure-model.test.ts tests/s15-disclosure-browser.test.ts \
  tests/s15-disclosure-effects.test.ts tests/s15-disclosure-github.test.ts \
  tests/s15-disclosure-vm.test.ts tests/s15-adoption-journals.test.ts \
  tests/s16-file-memory.test.ts tests/s16-desktop-boundary.test.ts \
  tests/s16-desktop-package.test.ts tests/s16-desktop-worker.test.ts \
  tests/s15-web-i18n.test.ts
JIT_S16_BROWSER_TESTS=1 bun test --timeout 60000 \
  tests/s16-search.browser.test.ts tests/s16-memory.browser.test.ts \
  tests/s16-models.browser.test.ts tests/s16-routines.browser.test.ts
bun run upstream:check
bun run ops:desktop build --source <clean-checkout> --output <fresh-artifact>
bun run ops:desktop verify --artifact <sealed-artifact>
git diff --check
```

The final browser focus correction additionally ran
`JIT_S16_BROWSER_TESTS=1 bun test --timeout 60000 tests/s16-memory.browser.test.ts`.

## Limits and acceptance boundary

`s16-client-search/v1` performs fresh owning-service projection, without a
second content index or cached snippets. It refuses above 10,000 candidates
rather than returning a false complete result. Pages are live, not frozen;
concurrent changes can alter rank. Labels are bounded, exact revisioned owner
metadata in additive CHAT tables and count toward existing custody capacity.
Old binaries can ignore organization without ignoring source authority stamps.
The selected no-Spaces tradeoff and migration/rollback semantics are in ADR
0101 and the contract.

The memory lineage inspection is read-only and owner-authenticated; no new
model/tool port, source release, reservation or work admission was introduced.
S14 default, S15 opt-in, installed policy, original private scope and owner-host
configuration remain unchanged. Models/VM/provider/record transports in these
tests are controlled deterministic fixtures. The computer-change scenario
changes its real protected registry generation; it is not a physical guest
replacement receipt. Exact-build real host/device/account acceptance remains
#431 and owner-host/service cutover remains #432. Parent #392 stays open.

Merge still requires the latest PR head's fourteen required checks, primary
review and resolution of valid findings. These local results do not replace
those checks or certify another PR/head.

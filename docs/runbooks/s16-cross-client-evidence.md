# S16 cross-client evidence inputs

[ADR 0121](../adr/0121-s16-executable-cross-client-evidence-matrix.md) and the
[v1 contract](../contracts/s16-cross-client-evidence-v1.md) govern the
[reviewed matrix](../evidence/s16-cross-client-matrix.json). This inventory is
separate from the historical backlog and does not close #430 or parent #392.

Validate the matrix without executing tests:

```sh
bun ops/evidence/s16-cross-client.ts validate
```

Validation requires all 22 ACs, 56 FR/NFR IDs, narrower requirement traces beyond
AC22, outcome assertions, negative cases and evidence owners. Missing owning
test deliveries are reported as unavailable, not omitted. Unknown fields,
commands, environment assignments, path traversal and linked test paths refuse.

Run selected inputs from a clean committed checkout with installed dependencies.
Choose a fresh absolute directory below this checkout's ignored `.local`:

```sh
bun ops/evidence/s16-cross-client.ts run --profiles bots,search --out "$PWD/.local/s16-evidence/run-001"
```

The executor creates that directory privately (0700), with 0600 `receipt.json`
and per-suite logs. It refuses an existing destination. It constructs fixed Bun
argv without a shell, isolates fixture HOME/temp/cache, and passes no owner
credentials or inherited live flags. Browser profiles enable only the existing
`JIT_S16_BROWSER_TESTS`, `JIT_S16_DESKTOP_TESTS` and `JIT_BROWSER_LIVE` fixture
flags. The last flag selects local protected-browser conformance fixtures; it
does not authenticate a real website. Chromium is the fixed installed Chrome
path on macOS or `/usr/bin/chromium` on Linux. A missing browser is unavailable;
the executor never downloads it or substitutes native device evidence.

Each declared suite runs separately under the profile's finite wall-clock budget
(at most ten minutes), with a 64 KiB combined output bound and process-group
SIGTERM/SIGKILL disposal. Bun's default per-test timeout is 30 seconds; existing
tests may declare their own bounded timeout. A successful process still needs a
complete consistent Bun summary, observed passing case names and assertions.
Required skips, zero assertions, failed/crashed/timed-out/unobserved cases and
bounded-output truncation block that input. Run profiles explicitly; absent or
unselected required profiles remain in the assessment.

Receipts bind clean source, matrix/governing documents, lockfile, source
dependency tree (including only bounded internal file links), vendored engine
archive, executing public engine contract and Bun executable hashes. The source
dependency seal is separately labelled and is not a shipped package seal.
The engine revision remains `unverified` unless independently established.
Before/after source and dependency pins must agree. Private logs preserve test
names; receipts hash names and contain no host paths or raw test output.

`source_inputs_passed` means the declared source profiles actually passed at that
receipt's revision. It does not certify each broad product outcome or packaged
parity. The `journeys` profile uses the actual shared JitClient and owning service
with scripted provider/VM transports: one reviewed routine delegates to a peer,
retains parent/child results through service restart, and runs only the next due
occurrence. A smaller finite read budget visibly holds before the VM byte read;
pause prevents the next model call. This is source-client evidence, not a rendered
browser or physical native-device claim. Artifact import for
service/web/desktop/mobile/parser digests and same-service voice/mobile continuity
are still required. #429's full compatible service/client lifecycle remains a gap.
`deterministicAcceptance` and `productAcceptance` therefore stay blocked in this
initial executor. Real devices, Linux isolation, configured local speech,
subscriptions/accounts and owner-host cutover retain independent pending rows.

Static validation exits 0. An executed partial/blocked acceptance run exits 2
after writing its receipt. Refused preconditions exit 1 before tests begin.
Historical receipts are never automatically promoted across revisions. Keep
raw logs and installation-specific evidence under `.local`; publish only reviewed
digests/outcomes with their exact source and artifact basis.

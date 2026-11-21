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
path on macOS or `/usr/bin/chromium` on Linux. The fixed task-private
`.local/s16-evidence-browser/Google Chrome.app` takes precedence on macOS when
present. It must pass the unchanged complete Google vendor signature guard;
no profile/account data belongs in this copy. Executable, Info.plist and signed
resource-index hashes are recorded before/after. A missing or invalid browser is unavailable;
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

Binary fixture inputs also need installed Python/Pillow and Poppler. The runner
uses the fixed Homebrew bin directory on macOS (`/opt/homebrew/bin` on arm64,
`/usr/local/bin` on x64) and `/usr/bin` on Linux; it never inherits the operator's
PATH or arbitrary `JIT_TEST_PYTHON`. Receipts pin those actual executables,
Python/Pillow versions, complete Pillow package bytes and the sanitizer script
before/after. Fixture Python uses `-I -B`; no user import path or bytecode write
is needed. These are explicitly host fixture tools, separate from a shipped
parser-image digest and #431's isolation proof. The runner downloads nothing.

`source_inputs_passed` means the declared source profiles actually passed at that
receipt's revision. It does not certify each broad product outcome or packaged
parity. The `journeys` profile uses the actual shared JitClient and owning service
with scripted provider/VM transports: one reviewed routine delegates to a peer,
retains parent/child results through service restart, and runs only the next due
occurrence. A smaller finite read budget visibly holds before the VM byte read;
pause prevents the next model call. This is source-client evidence, not a rendered
browser or physical native-device claim. The integrated `voice_mobile` profile
uses actual native controllers, shared clients and one HTTP owning service:
dictation stays an editable draft until explicit Send; a lost accepted Send
recovers the same work after restart without another POST, microphone start,
transcription, model call or effect. Speech, keystore and microphone ports are
scripted. The integrated operations profile also drives actual sealed earlier/
current services through first setup, upgrade, fallback and uninstall/reinstall,
with separate manager/account/VM fixture ports and interrupted root jobs.

Mobile source is retained from `5c13d7ac1c7f99bd73dff3c922c730f34c75634a`;
the operations integration starts at
`d3cc8326dda17ba7857afbfa8eb4fc101acfda0b` and includes the Linux bootstrap
dependency/provenance fix. Shared-client merge resolution retains owner export,
native notification capability and original upload-creation recovery together.
This source integration never promotes the independent native-device gate.
Exact-head artifact qualification uses the separate delivery command below.
The integrated operations inputs additionally retain the eighteenth native
notification journal through protected capture without dispatching APNs/FCM.
`deterministicAcceptance` and `productAcceptance` stay blocked in the source
executor. Real devices, Linux isolation, configured local speech,
subscriptions/accounts and owner-host cutover retain independent pending rows.

Static validation exits 0. An executed partial/blocked acceptance run exits 2
after writing its receipt. Refused preconditions exit 1 before tests begin.
Historical receipts are never automatically promoted across revisions. Keep
raw logs and installation-specific evidence under `.local`; publish only reviewed
digests/outcomes with their exact source and artifact basis.

## Complete delivery execution

[ADR 0132](../adr/0132-s16-exact-source-delivery-evidence.md) and the
[delivery contract](../contracts/s16-delivery-evidence-v1.md) govern the separate
complete execution. Commit and freeze source first. Build both mobile Release
artifacts using `ops/mobile/main.ts` at that exact head and retain local build
logs privately. Earlier artifacts are ineligible. No device operation is needed.

```sh
bun ops/evidence/s16-delivery.ts accept --out "$PWD/.local/s16-evidence/delivery-001" --ios "$PWD/.local/releases/ios" --android "$PWD/.local/releases/android"
```

The command qualifies native seals and a checked Git archive, builds/independently
verifies desktop, and executes every reviewed profile with the actual bundled
desktop fixtures and retained tested lifecycle package. Qualified service public
web bytes must equal the source browser bundle. Native stays build-only. Source,
dependencies, seals and re-observed logs are checked again before a successful
delivery receipt. Refusal exits 1 with private diagnostics and no success receipt.
A complete join exits 0 for deterministic acceptance; all five independent
product gates stay pending. Source-only execution retains exit 2. No result
approves production deployment or owner-host adoption.

# Current-source protected browser on actual Linux

Scoped LIVE16-01 (#431) evidence at clean source
`beab27ae9c276c200189c6e744e195ffcae70db7`, collected
`2026-11-21T17:42:46.014Z`–`2026-11-21T17:43:28.887Z`.
This supplements the [delivery proof](s16-delivery-proof.md) and
[protected browser workflow](s16-protected-browser-workflow.md). It does not
close #431 or replace named production-host, private-account or native-device
acceptance.

## Executed paths

The existing suites ran unchanged through the actual Jit protected browser
engine and its production launcher on Ubuntu 24.04.5 arm64, kernel
`6.8.0-142-generic`, Bun 1.4.2. The operator-supplied full Chrome for Testing
`156.0.8078.4` was selected by frozen Playwright-core 1.64.1, Chromium revision
1248. No launcher, proxy, resolver, screenshot or approval guard was changed.
This is a host Chromium fixture, not a claim about a shipped browser container
or a production installation's selected executable.

| Suite | Pass | Assertions | Duration |
| --- | ---: | ---: | ---: |
| `tests/s15-browser-live.test.ts` | 5 | 141 | 23.43 s |
| `tests/s16-browser-intents.native.test.ts` | 7 | 78 | 19.11 s |
| Total | 12 | 219 | |

Both suite processes and the final collector exited 0, with no failures or
skips. Separate complete Bun logs passed the unchanged one-file observation
verifier, including actual case-name/count consistency. Earlier collection
attempts without qualifying per-suite summaries remain private partial records
and are excluded from these counts.

The actual renderer exercised static/general JavaScript behavior, synthetic
login/TOTP, exact send/payment/disclosure holds, ordinary edits and denial of
redirect/popup/download paths. Approved names resolving to loopback could not
reach the controlled controller-local service. Async fetch/XHR/double dispatch
retained exact pre-input intent and dispatched once after the fixture decision;
recipient substitution refused. SPA observations retained the actual safe URL
and withheld secret-route text/screenshots. Concurrent owner views, document
control IDs and lease disposal retained their existing custody assertions.

Those login/payment/recipient/owner decisions are controlled synthetic fixtures.
Their loopback DNS/dial seams are explicit test ports; they do not establish
private-account login, a real payment or an owner approval. The separate
read-only public task used the actual [Excalidraw application](https://excalidraw.com/):
its client-rendered `Shapes`/`Canvas actions`, 27 observed controls and a
1280×800 screenshot were verified. The screenshot was visually inspected and
remains private; no account or drawing was created.

## Exact inputs and records

The same independently checked Git archive used by the native release builds
was transferred to the disposable VM. A separate host recomputation matched
the full Linux public source tree against the immutable Git snapshot. All
source paths/modes/content, the entire Chromium distribution, executable,
root lock and vendor archive matched before and after. The OS package manifest
also matched after execution. Browser bytes came from Playwright's official
CDN; they are separately supplied test dependencies, not imported project code.

| Input or record | SHA-256 |
| --- | --- |
| Source archive, 1,901 files / 47,080,233 bytes | `9f01cffe5f472511f8ecb211f50e8d8c16d9e7ad73d92c65e8076df34759b319` |
| Public source tree seal | `62d4470714998719b5c6dbe0d3b0004edab7724d0abda4c21bcda9f013d46bbd` |
| Chromium distribution, 301 files / 418,439,600 bytes | `9d0da563c74757835acea44d7b4edb5db84cf729b1a8587fa07e163101ad419a` |
| Chromium executable | `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65` |
| OS package manifest | `57026480a41fa0f888b8012e44c37086094a1b50170eae2147bc87d815feb09d` |
| Final per-suite receipt | `dd1cd46964bcf853b67002d05901e76a44b5fa7df6430ce325e07b2352c13679` |
| S15 browser log | `82d70d7576fd91bad41c4974926cfdaebcdaa9e810b6643041dd83cbba80fcae` |
| S16 browser-intent log | `110baceef1d1a59d0451b12a9ab07ddfaf2dcb9bf96dad7ab144e147b69b5c52` |
| Collector | `73353f15cd46ad9e73becccc8f637fbf37e4ffe1b412df60ce6c9264a5e5fab5` |
| Inspected public screenshot | `66cb6c59928d820050ee2cdd6825120609bfc22ec62cae5ec54913c71c8ecfdc` |

Only the task-owned VM was used, without host mounts or SSH-agent forwarding.
Owning fixture cleanup completed; the VM was shut down and its `Stopped` state
read back. Raw logs, profiles, package manifests and paths remain ignored private
records. No installed owner service, policy, credential or production host was
changed.

This proves the named current-source browser paths on this Linux fixture.
Browser-engine/host compromise, packet-level escape campaigns, nested working
VMs, other executable/platform qualification, live model/account work,
physical microphone/push/native UI and exact owner-host adoption retain their
separate #340/#341/#426/#431/#432 obligations. The 885-case delivery matrix and
its immutable external rows are not rewritten by this supplement.

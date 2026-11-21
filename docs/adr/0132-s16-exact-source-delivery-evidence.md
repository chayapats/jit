---
status: implemented scoped pipeline; exact-head execution pending
date: 2026-11-21
scope: EVID16-01; S16-AC01–AC22; FR-01–FR-42; NFR-01–NFR-14
---

# Qualify delivery artifacts during the complete matrix execution

ADR 0121's source executor deliberately leaves artifact acceptance blocked. A
passing source suite cannot establish what a delivered client contains. Retain
that behavior and add a separate `s16-delivery-evidence/v1` pipeline. It builds
the desktop package from the current clean source, independently rebuilds its
seal, and supplies that package to the existing installed desktop browser
fixtures. The selected lifecycle suite preserves only the actual current service
package it exercised; state, harnesses, sessions and credentials never enter the
delivery directory. Compare its packaged inputs independently with current
source before loading any module from it. Record its separately verified runtime
dependencies, actual lifecycle observations and bounded test-log hashes.

Observe the public web release and worker from that qualified service package.
Require byte equality with the source handler used by the browser fixtures.
Accept only bounded native Release trees produced at the same exact commit,
with current lock/native-input/notice pins and an independently materialized Git
archive matching their build-source records. Native seals establish local build
integrity, not physical signing, native UI or permission to install. Parser pins
describe actual host fixture tools, not a shipped isolation container.

Use one internal execution, rather than importing arbitrary historical green
receipts or promoting artifacts across revisions. Recheck source, dependencies,
logs and all artifact seals after execution. Every reviewed profile and scenario
must pass without skips or driver gaps before deterministic acceptance can pass.
Any mismatch refuses the join. The source receipt remains independently scoped;
only the delivery receipt may conclude deterministic acceptance. The five live,
device, isolation, speech and owner-host rows always remain pending here.

The finite CLI accepts only fresh private output and the two native artifact
directories. It has no arbitrary executable, environment, endpoint, receipt or
approval input. Browser fixtures may use a fixed task-private copy of installed
Chrome whose complete original vendor signature passes the unchanged launcher
guard. No account/profile is copied, browser is downloaded or global install is
altered. Evidence grants no execution, disclosure, policy, deployment or adoption
authority and changes no S14 default or S15 opt-in behavior.

The actual compiled macOS desktop fixture hangs in Chrome's persistent
`Storage.setCookies` with a synthetic HOME, before any PWA command. The same
bounded probe with the OS account context completes cookie storage, PWA
installation/launch and uninstall. Select OS default HOME resolution for only
the macOS `desktop_web` profile: omit HOME instead of inheriting an operator
value. Jit fixture data, exact-service profiles, TMP and cache remain private;
other profiles retain private HOME. Record this finite environment basis in
source fingerprints. Keep the actual vendor signature, sandbox and native
credential-store behavior. No browser profile/session or credential is copied,
and real OS credential-store/device acceptance remains separately pending.

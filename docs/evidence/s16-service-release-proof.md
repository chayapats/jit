# Scoped owning service/client release proof

Scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38;
NFR-02/04/05/08/09/12. This extends
[ADR 0127](../adr/0127-s16-guarded-release-selection-protocol.md) and the
[guarded selection contract](../contracts/s16-guarded-release-selection-v1.md).
It also exercises [ADR 0129's installed wiring dispatcher](../adr/0129-s16-retained-installed-wiring.md)
and [ADR 0130's first selected setup](../adr/0130-s16-first-selected-setup-with-original-intent.md)
over actual service processes. Final aggregate and actual Linux/owner-host
acceptance remain separate requirements.

`tests/s16-ops-service-release.test.ts` builds sealed immutable earlier
`23cfb85d` and current packages with their actual locked dependencies. Each
service process imports its own package's S14 owner application, S15 composition,
stores and supported Schway public host. The same actual sealed shared client
retains the original owner session/CSRF and request identities through A → B
and A → B → A. Private IPC replaces only the HTTP wire for deterministic
transport; no service/authority implementation is emulated.

A third journey upgrades to B, then uses B's actual sealed installed wiring
dispatcher and helper processes to uninstall/reinstall the current service.
Its config/state use canonical paths inside the disposable host root. Actual
fixed root-owned unit files disappear and return byte-for-byte; the existing
config and owner session remain. Scripted systemd/account ports bind real
process PIDs and wait for actual close/exit/start. The readiness transport checks
the actual client bootstrap; this is not rendered-login or real HTTP evidence.
No credential-service unit is created in this owning fixture; its separate
presence/activation path is covered by installed-wiring adapter conformance.

A separate first-selected journey starts with no current path, units or app
state. The sealed current package's first-setup coordinator executes its actual
initializer, operations adoption and current readers, publishes real generated
unit bytes, and starts an actual owning service process. The same sealed client
performs native file-to-artifact work and creates one conservative unknown
payment. Historical setup-response retry leaves the actual running PID, original
client receipt, usage/session and external counters untouched. Private owner-link
delivery is an explicit fixture port; the service's actual owner provisioning/
login occurs once in its original seed mode. This is not rendered signup proof.

Initial state comes from the shipped earlier CLI and owning owner/policy/TEAM/VM
writers. Actual file-to-artifact work uses scripted providers, genuine service
dispatch and public native sessions. Separate private computers prevent one
work's VM lineage from contaminating another. The owner stops the second VM;
controller stop/start never silently marks it ready or starts it. An owning
POLICY payment fixture claims once, commits an external fixture result and loses
its response. Its protected slip/usage remain unknown and conservative.

Attach mode never reseeds policy, TEAM, VM registration, credentials or external
records. Independent fixture state retains model/VM/payment invocation counters,
VM bytes/manager identity/state and payment results across processes. The unused
record-site fixture keeps one independent backend implementation and database
across both controller versions, just as a remote service would. Reopening that
fixture uses explicit existing read/write SQLite flags; missing state refuses
rather than initializing. No real provider, payment, account or VM is used.

The real root selector/process exclusion and protected operation helper perform
the upgrade. The controlled supervisor conclusively exits one actual service
process and starts the actually selected package. Trials use the original client
to read receipts, withdraw input, retire its private computer and install a new
owner policy revision. Failed health triggers a fresh-current reverse selection,
never old SQL/composition/native restoration.

The trial policy fences publication under the original grants. Those old artifacts
must remain withheld after fallback; retained protected bytes are not a new
release permission. The earlier service then executes fresh file-to-artifact
work under the current policy on a newly assigned private computer. Original
receipts, owner generation/session, private retirement, owner-stopped VM, charges,
unknown slip and one external payment invocation remain. Startup/maintenance
does not replay original model/VM/payment work. Historical root-job retry keeps
the active process and new work untouched.

Before uninstall, the same client produces withdrawal/private retirement and a
new policy revision. Its current receipts, conservative usage/unknown slip,
owner-stopped private computer, private assignment and artifact withholding
survive reinstall. An independent persistent VM port stops only fixture VM
states while the controller is actually closed; those explicit management
counter changes remain distinct from unchanged model/interpreter/VM-transport/
payment/reconcile counters. It does not seed controller data. Restoring original
wiring boots the same selected package with attach mode, preserves the original
cookie/CSRF/session, refuses duplicate payment and runs fresh artifact work under
the current policy. Healthy dispatcher retry preserves the actual active PID and
all external counters. No historical SQL/native/configuration is restored.

Run `bun test --timeout 30000 tests/s16-ops-service-release.test.ts`.
`JIT_S16_SERVICE_RELEASE_RECEIPT` optionally writes a fresh absolute private
artifact-only receipt containing exact source/package/dependency/lock/driver
pins, platform/Bun, unchanged seals and labelled observations. Passing outcomes
require the separate test log; source/build presence is not acceptance.

This is actual owning service/client logic with persistent scripted external
ports and a controlled process supervisor. It does not establish rendered Web,
desktop/mobile UI, real systemd/UID enforcement, physical computers/devices,
live accounts, speech accuracy or owner-host cutover. Those remain #430/#431/#432.

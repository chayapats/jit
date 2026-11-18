# S16 protected-browser reference proof

Date: 2026-11-18. Scope: #408 / BROW16-01A; [ADR 0079](../adr/0079-s16-modern-browser-mediation.md), [s16-modern-browser/v1](../contracts/s16-modern-browser-v1.md). Requirements: S16-AC06/07; FR-07/10/17/18/35/36/37/38/40/41; NFR-07/10/11/14. Source revision: `9b5a31e1d007001415b7d91cb6c38bcfcb0f8bad`. Later PR revisions must distinguish code changes from documentation and record their own checks.

This is a bounded sensitive-site feasibility proof. S16-D09 leaves public/trusted browsing in the working VM, with its accepted trusted-session residual. It does not enable protected general mode in the provisioned runtime or close #397/#392. #409 owns the remaining protected product integration and asynchronous intent/request binding; #431/#432 retain live account/device and owner-host adoption evidence.

## Actual topology and builds

A macOS arm64 management host ran a separate Linux arm64 controller VM and a separate root-administrable QEMU working VM. The controller owned Chromium, POLICY, protected profiles/continuity and the actual authenticated owner port. The working VM had root, sudo and Docker. Its external manager used QEMU restricted networking, IPv6 disabled and no filesystem exports, host credentials or agent forwarding. An authenticated loopback management relay carried the test adapter's finite operations; the guest did not receive its management credential. The controller was not inside the working guest.

This optional reference topology is not the target default nested Linux KVM deployment. Guest-reported negative probes alone do not prove isolation: the receipt also captured the external manager configuration/network inventory and positive controller canaries. It does not attest against a hypervisor or browser-engine exploit, other installations, hardware power loss or live owner credentials.

| Component | Observed build / SHA-256 |
| --- | --- |
| Linux controller | aarch64, kernel `6.8.0-147-generic` |
| Bun | `1.4.2`; `616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1` |
| Linux Chrome for Testing | `156.0.8078.4`; `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65` |
| Playwright | `1.64.1` |
| Lima | `2.2.1` |
| QEMU | `11.1.3`; `a7ace1986bb2af7e706402c3bd36b8450a463409e17a707a4c5a078cc521aba1` |
| Restricted QEMU wrapper | `875a5bef3358ad59e2ee6cfeb3a7aa41ed57da5f656da9472f7e8c4a64664d07` |
| Controller configuration | `84b18fa4cb9fd0ab6eea9425745eba4271332dc212c2aec2d9167de110dcd197` |
| Working-VM configuration | `a68ec48443ca8ad317727a507d8d03bc69a0a479e9acf026d6b1a21ae43fcb7e` |
| Public Schway artifact | `39194f7`; `58c80215fa0d8330c73c07674038ae50aed5dd5e69cc9d95e5d421e689091b8a` |

The supplied Linux executable was observed directly, not provisioned by this change. The macOS native run used installed Google Chrome `156.0.8078.80`, Bun `1.4.2` and Playwright `1.64.1`. Configuration hashes bind the reference inventory; installation addresses, instance identifiers, paths and raw receipts stay in ignored `.local` records. No owner credential, model inference, paid service or real payment was used. Login used ephemeral synthetic password/TOTP through the actual protected owner port.

## Observed outcomes

The reference runner `ops/evidence/s15-arm64.ts` archived the clean source revision, executed the actual composition on the Linux controller and returned **PASSED, nine cases**, then stopped its disposable working VM. The surrounding run stopped the controller too; both final states were verified stopped. Baseline recovery snapshots were retained.

| Case | Actual evidence |
| --- | --- |
| Guest administration | Actual guest root session, rather than an emulated root flag |
| External egress boundary | Guest firewall flush did not remove the external manager's proxy-only restriction |
| Protected paths | Guest attempts plus external no-export/network inventory |
| Snapshot recovery | Guest marker restored; protected POLICY usage unchanged; recovery is not prevention |
| Authenticated dynamic task | Real password/TOTP login, real fetch and XHR hydration, live field edit, held exact request, one verified service effect/body hash, second resume unsupported |
| Live protected-browser boundary | Exact kernel argv showed pipe-only Chromium control, no TCP debug option/control discovery file; persisted cookie file present. Guest root could not open cookie/canary paths, see the controller browser, find shared mounts, mount a 9p share or reach tested controller/control ports. Controller canary was positive; guest attempts produced zero canary requests |
| Communication hold | Controlled service received no held effect before approval |
| Browser bypass | Background/beacon/socket/events/popup/frame/hidden-submit/worker attack endpoints not reached |
| Payment policy | Synthetic payment remained held; no real settlement |

While the real profile was live, `ops/evidence/s16-browser-boundary.ts` performed the file/process/mount/socket attempts through the actual VM backend. It combines those negative results with protected process facts and the manager inventory. The finite tested probes do not constitute a universal exploit search. Chromium's deny-only proxy, disabled protocols and semantic request broker remain separate enforcement layers; production still refuses private/loopback destinations. The controlled test alone uses explicit DNS/fixed-dial injection to reach its local HTTP fixture.

Native conformance ran on both platforms at the source revision above:

| Suite | macOS arm64 | Linux arm64 |
| --- | --- | --- |
| `s16-browser-conformance.test.ts` + `s16-browser-crash.test.ts` | 9 pass, 0 fail, 104 assertions | 9 pass, 0 fail, 104 assertions |
| Controlled `s15-browser-live.test.ts` | 4 pass, 0 fail, 134 assertions | 4 pass, 0 fail, 134 assertions |

The static negative control cannot create or submit the authenticated JS task. General mode obtains real fetch/XHR responses, edits the form and dispatches the exact approved bytes once. Changing recipient/body requires new authority; JS mutation and submit-time substitution cannot borrow native input. Both modes can immediately navigate after denied download/redirect and after takeover cancels a held navigation, without sleeps, retries or extra approval.

The crash fixture keeps its HTTP service in the parent process. After that service actually receives the POST and withholds its response, it SIGKILLs the controller worker and its protected browser. A new controller opens the original POLICY/continuity state. The action remains unknown, cannot resume or replay, and an owner statement does not clear it. Actual protected HTTP read-back verifies the exact body hash and count of one before uncertainty clears; a fresh navigation then works. This is process-loss recovery, not a machine power-loss test.

The first recovery read without a verifier now fulfills with unknown rather than leaving the reconciliation read lane uncertain. The original effect claim/charge remains uncertain. A later service verifier can therefore run without retrying the original effect. Native settlement also retains its input lease until real pending I/O/frame completion; closing the native browser unblocks pending renderer operations before gateway shutdown waits for scopes. None of these lifecycle steps claims to recall an already dispatched request.

## Reproduction and remaining gates

Use the existing opt-in reference runner only with an explicitly configured disposable controller/working VM; see [the runner guide](../../ops/evidence/README.md). `JIT_S15_ARM64_EVIDENCE=1 bun run s15:evidence:arm64` requires a clean source revision and records build/configuration facts. It is not part of ordinary CI or authorization to change a real owner host.

On each supplied native executable:

```sh
JIT_BROWSER_LIVE=1 JIT_BROWSER_EXECUTABLE=<installed-chromium> bun test --timeout 60000 tests/s16-browser-conformance.test.ts tests/s16-browser-crash.test.ts
JIT_BROWSER_LIVE=1 JIT_BROWSER_EXECUTABLE=<installed-chromium> bun test --timeout 60000 tests/s15-browser-live.test.ts -t 'actual navigation|approved name'
```

The external public Excalidraw case is intentionally filtered out. Deterministic, package, typecheck and final-head CI/review results belong in the PR. Earlier failed diagnostic runs remain in private receipts and are not counted as passing evidence.

#409 must implement reviewed attribution for asynchronous mutations and the protected modern-browser product path; unknown semantics continue to refuse. Guarded downloads/file transfer remain under their owning file contracts. Repeat isolation/network/custody checks for the exact shipped deployment, and obtain real account/device/host acceptance through #431/#432. No schema, installed policy, S14 default, S15 opt-in selection or historical private scope is migrated here. The Rakazo comparison/provenance remains pinned in ADR 0079; this slice copies no upstream source/assets and adds no dependency.

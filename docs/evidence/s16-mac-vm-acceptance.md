# Disposable arm64 host and iOS simulator acceptance run

Date: 2026-11-23. Scope: #340, #341, #426, #429, #431 and #432; S15-AC01–AC16
host rows and S16-AC17/AC21/AC22 host rows. Related records:
[x64 single-host run of 2026-11-03](https://github.com/chayapats/jit/issues/340),
[Linux installer proof](s16-linux-installer-proof.md),
[mobile build proof](s16-mobile-build-proof.md) and
[native acceptance checklist](../operations/s16-mobile-acceptance.md).

The x64 reference host `jit-vm` no longer exists. On 2026-11-23 the owner
directed that the remaining host work run in a virtual machine on the owner's
Mac and that the test files be removed afterwards. Everything below ran on
that disposable machine or on an iOS simulator. **Nothing here is an owner-host
cutover, a physical-device result or a live-account result.** Addresses,
passwords, the first-owner link and raw logs stayed in ignored `.local`
records and inside the machine, which is deleted after the run.

## Hosts

| Item | Fact |
| --- | --- |
| Outer host | Apple M4 Pro, macOS 27.2.1, Lima 2.2.1, Virtualization.framework with nested virtualization |
| Disposable Linux host | Ubuntu 26.04.1 LTS arm64, kernel 7.0.0-34-generic, 6 vCPU, 14 GiB, 90 GiB disk, `/dev/kvm` present |
| Working computer | QEMU 10.2.1 with KVM inside that host; pinned image `ubuntu-26.04-20261016-arm64`, SHA-256 `8eb876c2ccc4b6ff89e4a65d511815923b285e04503ba465809bf587f763da24`, recomputed on download |
| Simulator | iPhone-class iOS 27.0 simulator, arm64 |

## Installed service (#341, #429, #432)

`install.sh --s15 --yes` ran from an extracted `git archive` of each exact
commit, under a pseudo-terminal whose transcript stayed inside the machine.

| Step | Source | Result |
| --- | --- | --- |
| Fresh install | `4c860cf63082f431f413736be8cb012d6b069d7d` (tree `01aff5450548d6e025976dd717c1612de50fdc09`) | Exit 0. Every installer step passed, through `health`, `owner-link` and `working-computer`. The working computer went from host check to **Ready** in about three minutes. `jit-s15.service` ran as `jit-s15` with 0 restarts; QEMU ran as `jit-s15-vmm` (member of `kvm`); `jit-s15` was not in `kvm`; the sudoers rule allowed only the fixed launcher. |
| First owner | same | The single-use link opened *Create your password*; a fixture password generated for this run was set through the Web form. `/` then led to first-time setup with password and working computer done and rules not installed. |
| Web on the install | same | `/s16` and `/s16/computers` served the current client from the installed release; the shared computer showed **Running**, then **Sleeping** after *Sleep now*, with QEMU gone from the host. |
| Operations adoption | same | With the service stopped: `s16:ops adopt` returned `adopted` at revision 0; `s16:ops backup` returned `retained` (1,782,749 bytes, manifest SHA-256 `9db8fbd0f90fc12a46e5875a2ebc7680227e6015e2a30e1590a0c19a40f3626f`); `status` then reported one retained point. The service restarted healthy. |
| Upgrade | `a93b0630f97cbfdab1a84555921392469c7e0c8e` (tree `6b29713e70a6b61c20c84d61d2b4461f7964faa7`) | Exit 0 through `s16-guarded-upgrade`: "completed with current state preserved". The active release changed, the runtime configuration was byte-identical, the original owner password still signed in, the computer was still **Sleeping**, and operations stayed `adopted` with two retained points. |
| Failed target | the upgrade source plus one injected line that throws when the service starts | Exit 1 at `s16-guarded-upgrade`: "The target failed its trial. A compatible prior executable is healthy over current state; no historical data was restored." The active release was unchanged, the service was active and the sign-in page answered 200. |
| Uninstall | `a93b0630…` | Exit 0: controller wiring removed; state, configuration, identities, keyring, receipts and working disks stayed. No unit remained and nothing listened on the service port. |
| Reinstall | `a93b0630…` | Exit 0 through the guarded path. No new first-owner link was issued; the original owner password signed in and the computer state was unchanged. |

Not done on this host: sign-in to the model provider for the service identity,
a GitHub token, Google consent, installed standing rules and therefore the
first real conversation. Those are owner inputs. The setup overview marks
*Model account* as done while its own section says the route is unavailable
until sign-in; the section is the accurate statement.

## Working-computer boundary cases (#340)

Runner: `JIT_S15_X64_EVIDENCE=1 bun ops/evidence/s15-x64.ts --sha a93b0630f97cbfdab1a84555921392469c7e0c8e --cases provision,root,apt,egress,snapshot,restart,docker,concurrency`,
as a disposable non-root identity in `kvm` with a lingering user manager, with
the installed working computer asleep. The runner now accepts arm64 and reports
`s15-single-host-evidence/v1` there, so this is not x64 evidence. Source tree
hash `0cf5f2a5378db7c5ccfc5aa8c74fcab24ddd44726f12ea5ace27ec02ff93a62e`; result
file SHA-256 `d10743e18bd5d628c062ab4b6bdbb8af5317690bd6e1303120c6103c3ae367a5`.
Exit 0; the evidence machine was stopped at the end.

| Case | Result | Detail |
| --- | --- | --- |
| provision | pass | Ready in 180 s; 3 vCPU, 6144 MiB, 60 GiB; image checksum recomputed equal to the pin; management network `proxy-only`. |
| root | pass | uid 0, systemd 259, virtio devices, protected paths absent (guest-reported). |
| apt | pass | `apt-get install tree` exited 0 through the registry proxy. |
| egress | pass | After flushing iptables, ip6tables and nft in the guest: DNS over UDP and TCP, ICMP, host SSH and HTTP, public HTTP and HTTPS all failed; the proxy without a lease answered `407 Refused`. |
| snapshot | pass | Live snapshot, guest change, restore: the marker returned to baseline, policy usage was unchanged and the generation advanced. This is recovery, not prevention. |
| restart | pass | The guest survived the controller's exit in the same boot and re-registered as ready. |
| docker | pass | `hello-world` ran inside the guest through the proxy (guest-reported). |
| concurrency | pass | Two sessions each ran a five-second command at the same time; both exited 0 in 5.3 s. The cancel-one-sibling case was not part of this run. |

Not run: the multi-hour soak, the browser and payment boundary cases on this
host, any x64 case at this build, and every case that needs model inference
or an owner account. The x64 results of 2026-11-03 remain attributed to build
`9082327dbb2534962cf2065a2a1537e723746046`.

## Paired arm64 reference host (#340)

The existing reference pair (a disposable Linux controller and a separate QEMU
working machine under Lima on the same Mac) was run again at the head that
contains this record's first revision: `JIT_S15_ARM64_EVIDENCE=1 bun run s15:evidence:arm64`
at `9765bedfc0cf1d4a0d7c5c90e4922af10c4dffeb`, contract `s15-arm64-evidence/v1`,
result file SHA-256 `e00a415d1f11d2fd64db997bc3ca0e2f9755206946d0e082d150b043fe06600c`.
Exit 0, **9 of 9 passed**, baseline snapshots retained, working machine stopped
afterwards: guest root, egress after a firewall flush, protected paths,
snapshot recovery, an authenticated dynamic task (fixture password and TOTP in
the protected owner port, one exact approved dispatch verified by body hash, no
credential exported), the protected-browser guest boundary, a held browser
communication click, browser bypass attempts and the payment policy. No model
inference or owner credential was used; DNS and dialling for the fixture sites
were controlled loopback.

## Packaged iOS client on the simulator (#426)

Each build came from `bun ops/mobile/main.ts build` at a clean exact commit and
passed `verify`. The observed build is the last one.

| Artifact ID | Source |
| --- | --- |
| `16bd8774bf434fbcbd242da6d1d21af068ae1ff7222875773612000d82cf21d5` | `4c860cf63082f431f413736be8cb012d6b069d7d` |
| `c01d794c05576188b61a2397fd412d69a813feb767c289a62703a9b3336949bb` | `b4e41c5c55230e5534429b1e664044f6d96c406c` |
| `e9cb0fef85ef73ba594f7fcb1c4e39ce6dd45333acc07f9ccc3859eaedc83dbc` | `f508330712dc79d54e3fe51b2ebadd1429631730` |
| `dfbb316e6fe50306973ea43edfbd762509e0d29f2a8030fb58c4edd11acfebbe` | `a93b0630f97cbfdab1a84555921392469c7e0c8e` |

Final executable SHA-256 `d65375820b43c40a04c038e8095ff421f4e0ad2837d1ea0d6c69c90569c2b0f3`;
bundled Hermes JS `62e8365c9fdca0a3359e5ff2e36bb3bdde305940b83c2d21754870ed7eff01cc`.
The service was the composed loopback fixture from
`tests/fixtures/s16-mobile-app.ts` with a scripted model; requests were logged
without cookies or tokens.

Observed through the compiled renderer:

- Password sign-in through the existing protected ingress. Protected reads
  reached the service as `GET /api/s16/client/bootstrap` with no cache-buster
  and returned 200. Before the transport fix in #471 the same build line sent
  `?_=<time>` and every read failed with `invalid_body`.
- A saved service that no longer answers shows the reconnect state and now
  offers *Use another Jit service*. Two origins on different ports were
  registered; the session of one was never sent to the other.
- New conversation, typed English and Thai messages, `202` admission, the
  scripted work and its result in the transcript above a docked composer.
- Native file picker: cancelling changed nothing; choosing a real Markdown
  file created one upload, sent its bytes once, showed it as ready and the
  message carried its receipt.
- Needs you, Work and More pages; honest *not configured* notification state
  and *unavailable* local voice state.
- English and Thai, light and dark, and the accessibility-large text size.
- Background for seven seconds produced no protected read; returning to the
  foreground read current facts again. Relaunch and an in-place app update
  restored the session; sign-out returned to the connect screen and a relaunch
  stayed signed out.

Not observed: Android on any device or emulator (no emulator exists on this
Mac), notification delivery and taps, an exact approval card decided in the
native app, microphone capture, artifact preview and export, the app-switcher
cover, held-request barriers and response-loss recovery. Those remain covered
only by the deterministic suites named in the mobile build proof, and physical
device rows remain owner inputs.

## Web client checks

All 26 `tests/s16-*.browser.test.ts` files ran locally against the real bundle
with `JIT_S16_BROWSER_TESTS=1` after the presentation change: the 21 active
files passed and the five desktop files stayed skipped behind their own
opt-in. Every S16 page was reviewed at 1440 and 390 wide, light and dark,
English and Thai.

## Rows that stay unrun

| Row | Missing input |
| --- | --- |
| Model inference on the install, first real conversation, AC01/AC13/AC14 live | Codex device sign-in for the service identity |
| Live GitHub publication, review remediation and merge | Fine-grained sandbox token |
| Self-addressed mail and calendar evidence | Google consent |
| Physical iOS and Android, signing, APNs/FCM delivery, real microphone | Devices, developer accounts and signing identities |
| Modern website login and 2FA handoff, protected takeover with a real account | Owner account and second factor |
| x64 host cases at the current build, multi-hour soak | An x64 KVM host; time on a host that is kept |
| Owner-host cutover | A production host. None exists: the earlier hosts were retired |

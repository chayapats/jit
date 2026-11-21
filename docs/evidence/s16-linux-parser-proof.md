# S16 strict parser on actual rootless Linux

Scoped LIVE16-01 (#431) evidence collected on 2026-11-21. This records the
generation-3 parser and actual kernel controls at the named source. It does not
close #431, certify the complete S16 product, establish model vision or substitute
for native/account/owner-host acceptance. The tested source is the unmerged
[convergence revision](https://github.com/chayapats/jit/commit/ae3d8f88b6578a739b35d4a1108a7cd20f4da26c),
not an assertion that main or an owner installation adopted that release.
The [binary-file contract](../contracts/s16-binary-files-v1.md) retains the
separate parser, image-account and private-source acceptance obligations.

## Exact inputs

| Input | Observed value |
| --- | --- |
| Source | `ae3d8f88b6578a739b35d4a1108a7cd20f4da26c` |
| Checked Git archive | `a50a7f059e2fc8e308c3fd3868b7a30c0594776613aac66be564bb75e356076e`; 1,900 files / 47,070,736 bytes |
| Containerfile | `7b5ba75a0b5e2c437b3c164d1c4a20ed97b9f094609abda4c28de925b9fd650b` |
| Sanitizer | `72f8611f63ae80092510100caf56e749658cb282dff65694edf435aea0f7c035` |
| Runner | `d0b44d1e567cdf752bae8169a551aa82df025e1d0256bd0918e38b6e2f71fa46` |
| Root lock | `05901663c7a3f9c3fd8e75b26adb6cb147313f41ffdb5417f9531a21ebce3076` |
| Vendored engine archive | `58c80215fa0d8330c73c07674038ae50aed5dd5e69cc9d95e5d421e689091b8a`; executing engine revision remains unverified |
| Linux Bun executable | 1.4.2; `616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1` |
| Built OCI manifest | `sha256:1627e45d8580a7cdf13a4ceadcd2b60d94ebf6fb0d0063bf4f0200fa2dfc6214` |
| Built image configuration | `489df7be3bd9aab4c4ed28b806ab0fdb3b97ffae6c54783976d4dadcfb52dcce` |

The archive was materialized with the bounded Git source checker and every
extracted byte/mode checked against that immutable tree. Its SHA-256 was checked
again after transfer. No host mount or SSH agent was supplied to the disposable
VM. The base target was built inside it from the archived Containerfile, whose
Debian base manifest is pinned; parser label `jit.sanitize.version=3` and the
actual built image digest were read back. Frozen root installation disabled
lifecycle scripts. Later apt repositories can produce another image: a rebuild
must retain its own digest and observations instead of reusing this receipt.

## Executed owning parser

Host: Ubuntu 24.04.5 arm64, kernel `6.8.0-142-generic`, Podman 4.9.3, rootless
UID 1001, cgroup v2 with CPU/memory/PID controllers. No installed owner service
was reconfigured or enabled for binary files.

The actual existing opt-in test ran through `binaryFileRuntime`, `FileParser`
and `PodmanAttachmentSanitizer`, with the locally built digest selected explicitly:

```sh
JIT_PODMAN_MODE=local JIT_LIVE_S16_FILES=1 \
JIT_LIVE_BOX_IMAGE=localhost/jit-box-base@sha256:1627e45d8580a7cdf13a4ceadcd2b60d94ebf6fb0d0063bf4f0200fa2dfc6214 \
bun --no-env-file test --timeout 30000 tests/s16-binary.live.test.ts
```

Result: **1 passed, 0 failed, 7 assertions, 7.92 seconds**. The actual PDF yielded
the expected source text; PNG/JPEG produced nonempty validated image outputs;
the encrypted PDF was refused. Inputs were the repository's public synthetic
fixtures. No provider, model inference, account, private recording or billing
route participated.

## Actual process controls

A separate observation driver retained the production run arguments and original
cleanup. It inspected each live container and its actual process's procfs/cgroup
files while those same PDF/PNG/JPEG jobs ran. It changed no parser command,
container image, limit, mount or network setting. Driver SHA-256:
`2fc246a08ad11e3bc78a07122be6d11da955c364886c62df1f364c03149b5e32`.
All three jobs produced complete observations; none was promoted from a process
that had already disappeared or from configuration alone.

| Control | Kernel/container observation |
| --- | --- |
| Image | Actual configuration ID matched the pinned image above |
| Memory | PDF `270598144` bytes; PNG/JPEG `302055424` bytes; exact configured decoding plus output budget |
| Swap | `memory.swap.max=0` |
| Processes | `pids.max=64` |
| CPU | `cpu.max=100000 100000` (one CPU) |
| Privilege | `CapEff=0`, `NoNewPrivs=1`, `Seccomp=2` |
| Root | Actual root mount read-only |
| Scratch | `/tmp`, `/run`, `/out` mounts had `noexec` |
| Input | Sole user bind `/in`, read-only |
| Network | Network mode `none`; zero IPv4 routes in the actual process namespace |

Both owning cleanup paths completed and the identity's container inventory was
empty afterwards. The task-owned VM was shut down after collecting the records.
Source archives, commands, raw inspection/build/test output,
driver and shutdown records remain in ignored private evidence. Public records
exclude installation addresses, host paths, credentials and private content.

This is bounded parser isolation evidence, not a kernel/runtime escape audit,
IPv6/UDP exploit campaign, nested working-VM proof, all supported host/platform
acceptance, live model image challenge, protected website/account workflow,
physical microphone/push/native UI or owner-host cutover. Those retain their
separate #340/#341/#426/#431/#432 gates. No runtime default, policy, private scope,
service configuration or owner installation was changed.

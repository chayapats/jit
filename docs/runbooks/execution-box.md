# Runbook: execution boxes on rootless Podman (EXE02)

Owner-executable checklist for box images, operator `execution` config and `jit ops box-doctor`
(`ops.execution_config/v1`, `ops.box_image/v1`, `ops.box_doctor/v1`). Build and plan run anywhere;
install and Podman setup on the Pi happen only in an owner-approved change window. Never paste tokens,
digests beyond the pinned image references, addresses or raw diagnostics into issues; attach only
sanitized summaries.

## 1. Install Podman (Ubuntu 24.04)

```sh
sudo apt install podman uidmap slirp4netns passt
```

- Create a dedicated non-root, non-login service identity (for example `jit`, shell `/usr/sbin/nologin`).
- Add subuid/subgid entries for the service user (for example in `/etc/subuid` and `/etc/subgid`):

```text
jit:100000:65536
```

- Verify `podman --version` is 4.4 or newer (`jit ops box-doctor` checks `podman-version>=4.4`).
- When the service user's home (and so its rootless container storage) lies under `/var/lib` (for example
  `/var/lib/jit`), create `/var/lib/cni` once as root (`sudo mkdir -p /var/lib/cni`). Podman 4.x otherwise mounts a
  tmpfs over `/var/lib` inside its rootless network namespace, which hides the user's network definitions there, and
  every box on `jit-box-internal` fails with `unable to find network with name or ID jit-box-internal` (observed on
  the Pi with Podman 4.9.3, 2026-10-28).

## 2. Enable lingering

```sh
sudo loginctl enable-linger <serviceUser>
```

- The service user needs a lingering user manager so rootless Podman and its networks survive logout.
- Re-check with `loginctl show-user <serviceUser>`.

## 3. Build images

```sh
bun ops/box/build.ts --target base --tag 2026-10-28
bun ops/box/build.ts --target browser --tag 2026-10-28
```

- Each build prints `{ "image": "jit-box-<target>:<tag>", "digest": "sha256:..." }`.
- Copy the printed digests into the service config `execution.images` as
  `<name>@sha256:<hex>` (for example `jit-box-base@sha256:...` — use your registry
  or local name prefix plus the printed digest).
- Images are `ops.box_image/v1`: `base` is `debian:bookworm-slim` plus the fixed
  package set; `browser` adds Chromium, Xvfb and Thai fonts. Never use unpinned
  `latest` tags.

## 4. Configure `execution` in the service config

Add the `execution` block to `.local/service-config.json` (validated by `parseServiceConfig`):

```json
{
  "execution": {
    "directory": "/var/lib/jit/boxes",
    "secretsDirectory": "/var/lib/jit/box-secrets",
    "images": { "base": "jit-box-base@sha256:..." },
    "maxBoxes": 2,
    "memoryMb": 2048,
    "cpus": 2,
    "pidsLimit": 512,
    "idleMinutes": 30,
    "registryHosts": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"],
    "fullAllowed": false
  }
}
```

- `directory` and `secretsDirectory` must be absolute paths that do not equal,
  contain, or lie inside `stateDirectory`, `backupDirectory`, the ledger directory,
  `workingDirectory` or the releases directory, and must not contain each other.
- `images.base` (and optional `images.browser`) must be `<name>@sha256:<hex>`.
- `registryHosts` is the only egress allowlist for `workspace` boxes.
- Plan and install through the service package (`docs/runbooks/ops-service.md`):
  the unit renders `JIT_EXECUTION_*` / `JIT_BOX_*` variables and writable paths
  for both directories.

## 5. Run `jit ops box-doctor`

`box-doctor` reads the same `JIT_EXECUTION_*` / `JIT_BOX_*` environment the
supervised unit sets (see `serviceEnvironment`). The service config file alone
is not enough: run the command with the unit's environment, for example as the
service user with the installed unit's `Environment=` values exported, or from
a shell that already has those variables.

```sh
jit ops box-doctor
```

- Exit 0 only when all eleven checks pass; otherwise exit 1 with the failing check,
  its `detail` and its `nextAction`.
- The command never runs containers and never prints secrets; it only probes
  `podman --version`, `podman info`, `podman image exists`, `podman image inspect` and the two directories. The `sanitizer-image` check requires the rebuilt base image label `jit.sanitize.version=2`.

## 6. What `fullAllowed` means

- `fullAllowed: false` (default) keeps the `full` access level unavailable:
  widening to `full` is rejected until there is Pi resource evidence.
- Set it to `true` only after EXE06 opt-in evidence (real Podman run plus Pi
  resource measurements) is recorded. It is an operator decision, not a model
  decision, and only the owner widens access in Web.

## 7. Troubleshooting

| Check | Next action |
| --- | --- |
| `podman-installed` | `install-podman`: install Podman 4.4+ and put `podman` on `PATH`. |
| `podman-version>=4.4` | `upgrade-podman-to-4.4`: upgrade Podman to 4.4 or newer. |
| `rootless` | `enable-rootless-podman`: run as the service user without `sudo`, add subuid/subgid entries. |
| `cgroup-v2` | `enable-cgroup-v2`: boot with cgroup v2 (unified hierarchy). |
| `controllers` | `enable-cgroup-controllers`: enable the `memory`, `cpu` and `pids` controllers. |
| `execution-configured` | `configure-execution-block`: set `directory`, `secretsDirectory` and `images` in the service config. |
| `image-base-present` | `build-box-images`: run `bun ops/box/build.ts --target base --tag <tag>` and pin the digest. |
| `sanitizer-image` | `rebuild-base-image-and-pin-digest`: rebuild base with Pillow/Poppler and `/opt/jit/sanitize`, then pin the new digest. |
| `image-browser-present` | `build-box-images`: run `bun ops/box/build.ts --target browser --tag <tag>` and pin the digest (skipped when not configured). |
| `execution-directory` | `create-execution-directory` / `chown-execution-directory` / `restrict-execution-directory`: create the directory, chown to the service uid, chmod 0700. |
| `secrets-directory` | `create-execution-directory` / `chown-execution-directory` / `restrict-execution-directory`: same as above for the secrets directory. |

## Runtime (EXE03)

Once configured, Jit creates one box per project on demand (`jit-box-<projectId>`) with the hardening of [execution-box-v1](../contracts/execution-box-v1.md); it never pulls an image (`--pull=never`), so pre-build and pin both targets. `workspace` boxes use the internal network `jit-box-internal`, which Jit creates on first use, and reach only the registries in `registryHosts` through Jit's proxy on that network's gateway. Idle boxes stop after `idleMinutes`; the workspace stays under `<directory>/<projectId>/workspace`.

Live evidence on the host (opt-in, not a release test):

```sh
bun ops/box/build.ts --target base --tag <tag>          # prints the digest
JIT_LIVE_PODMAN=1 JIT_LIVE_BOX_IMAGE=jit-box-base:<tag>@sha256:<digest> bun test tests/box-podman.live.test.ts
```

It checks the inspected mounts, zero capabilities, no Jit variable or path in the box, and that the internal network blocks `example.com` while the proxy allows `registry.npmjs.org`.


## Attachment sanitizer (ATT02)

The operator rebuilds the existing base image; no separate image is downloaded, no image is built in CI, and ATT02 does not depend on the installer under review. On the operator-approved host/window:

```sh
bun ops/box/build.ts --target base --tag <new-tag>
# Set execution.images.base / JIT_BOX_IMAGE_BASE to the actual new digest, then restart through the normal service workflow.
jit ops box-doctor
```

The base now includes `python3-pil`, `poppler-utils`, `/opt/jit/sanitize` and label `jit.sanitize.version=2`. The optional browser target inherits it; rebuild browser too when the operator wants matching targets. Never invent a published digest or reuse the prior digest for changed contents. The image is selected by the same base-image pin already used by execution boxes, so no extra installer image entry is required.

For opt-in acceptance on any disposable Linux x64/arm64 host with rootless Podman (never ordinary CI):

```sh
JIT_LIVE_PODMAN=1 JIT_LIVE_BOX_IMAGE=<base-name>@sha256:<real-digest> bun test tests/attachment-sanitizer.live.test.ts
```

Record tested commit, OS/architecture, memory, image digest and sanitized pass/fail only in ignored `.local` evidence. The test processes a tiny repository metadata/polyglot fixture in its own temporary directories. To extend evidence in that authorized window, use the bomb/huge/malformed fixtures from `tests/fixtures/attachments`, verify rejection, and inspect an active `jit-sanitize-*` container: network `none`, no added capabilities, non-root user, read-only root, only the private `/in` read-only bind mount, and `/out` tmpfs with its byte/inode caps. Confirm a deadline removes the container. Keep raw file content, installation paths, addresses and diagnostics out of issues.

The output tmpfs cap is 32 MiB + 64 KiB for images (4 inodes including root) or 2 MiB + 64 KiB for PDFs (3 inodes). It is fully included in the disk reservation and added to the parser cgroup memory/swap ceiling. Outputs return over a bounded length-prefixed stdout stream; no writable output bind mount reaches service disk. Host writes follow successful container cleanup only. Cleanup uncertainty quarantines work and its reservation until reset succeeds.

Runtime defaults are host-scaled memory `min(512, max(256, RAM/16))` MiB, up to 40 MP scaled with memory, 30 seconds and one parser at a time. PNG stays PNG, JPEG stays JPEG, WebP becomes PNG; model copies fit 2048 px. Images have a 16 MiB cap per derivative; PDFs produce at most 50 pages / 2 MiB UTF-8 text, never a rendered page. Attempt counts survive restart; two failed/interrupted attempts reject the file and remove its original when unshared.

Without a capable rootless runtime/rebuilt image, PNG/JPEG use metadata stripping only and are download-only; PDF/WebP upload is refused. No host image decoder is used by the service. `JIT_ATTACHMENTS` remains release-gated until ATT04 and ATT06 merge. ATT03 owns composer/preview serving; ATT04/ATT05/ATT07 must preserve the container/service/fallback eligibility rules in `docs/contracts/app-attachments-v1.md`.

Deterministic parser tests require local Python 3 with Pillow and Poppler (`python3-pil` and `poppler-utils` on Debian/Ubuntu), alongside the existing runner dependencies. They use generated fixture paths through the fake runtime, never Podman or live host files.

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

- Exit 0 only when all ten checks pass; otherwise exit 1 with the failing check,
  its `detail` and its `nextAction`.
- The command never runs containers and never prints secrets; it only probes
  `podman --version`, `podman info`, `podman image exists` and the two directories.

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

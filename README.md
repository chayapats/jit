> **S14 is the default for new source runs and installations.** It uses fresh Bot-first state beside retained legacy data. `--s14` remains an alias; `--legacy` selects the project-centric pilot explicitly. Existing service configs without `runtime` remain legacy. The owner-host first reply, consistent legacy-byte comparison and prior-release rollback remain #267 acceptance work. See the [cutover runbook](docs/runbooks/s14-default-cutover.md).

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/design/assets/lockup-dark.svg">
  <img src="docs/design/assets/lockup-light.svg" alt="Jit" height="72">
</picture>

### Just in time. Just for you.

A self-hosted assistant with persistent Bots and private local computers.<br>
Chat with one assistant, bring in specialists when needed, and pick up where you left off the next day.

[![GitHub stars](https://img.shields.io/github/stars/chayapats/jit?style=flat-square&logo=github&color=0a0a0a)](https://github.com/chayapats/jit/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-0a0a0a?style=flat-square)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4.2-0a0a0a?style=flat-square&logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-0a0a0a?style=flat-square&logo=typescript)](tsconfig.json)
[![Runs on Linux x64 and arm64](https://img.shields.io/badge/runs%20on-Linux%20x64%20%7C%20arm64-0a0a0a?style=flat-square&logo=linux)](docs/runbooks/ops-service.md)
[![Greptile: The War on Bugs](https://www.greptile.com/badge.svg)](https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source)

**English** · [ไทย](README.th.md)

<img src="docs/design/assets/bot05-continued-dark-en.png" alt="Historical legacy project pilot" width="860">

*Historical legacy pilot screenshot; see the [S14 experience](docs/design/S14-bot-first-experience.md) for the current design.*

</div>

---

## What is Jit?

Jit is a personal assistant that runs on a machine you control: a mini PC, a home server, a VPS or a Raspberry Pi. The service runs on 64-bit Linux (x64 or arm64) with systemd. For development, any OS with Bun works. You talk to **Jit**, the main bot. Jit keeps persistent Bots, conversations, work, decisions and sourced memory across days. A conversation needs no Project. Research can use bounded parallel Bots and publish reports with citations and downloadable artifacts.

Jit uses [Schway](https://github.com/chayapats/schway) as its execution engine. Schway runs the agent loop and the provider sessions. Jit owns Bots, work grants, conversations, memory, computers, artifacts and durable jobs.

## Capabilities

| Capability | Boundary |
| --- | --- |
| Persistent Bots and conversations | Permanent Bot creation requires acceptance of the exact proposal. Membership grants no access. |
| Research and reports | Anonymous Parallel reads, finite overlapping work, committed citations/artifacts and explicit source gaps. |
| Sourced memory | Bot-private claims and explicit revision-bound sharing; correction, forget and deletion follow lineage. |
| Work and routines | Task acceptance is separate from execution; only current owner grants authorize work. Quiet outcomes retain history. |
| Bot computers | Separate bounded workspace/profile filesystems and rootless components; no service credentials or state enter a box. |
| Coding and personal assistance | Scoped repository/Git and email/calendar brokers; exact external actions require approval. Support remains bounded by the [recorded evidence](docs/evidence/s14-mvp-evidence.md). |
| Web | Thai/English, dark/light first-run, sign-in, inspection and recovery flows. |

Schway owns execution loops, provider protocols, native sessions, compaction and model retries. Jit consumes its pinned public host contract. A configured route or healthy login page does not prove a working subscription or computer.

## Principles

- **Authority comes from you.** Model output and retrieved content can never create permanent Bots, grants or owner decisions, and they cannot widen access.
- **Proposed, accepted and done stay separate.** Every change has a revision and a receipt you can inspect.
- **Your data stays on your host.** Jit sends no telemetry. Relevant data goes to the selected inference provider, authorized Parallel reads and explicitly enabled brokers; local execution does not imply local inference.
- **Credentials stay out of the box.** No Jit credential, database or backup ever enters the execution box.

## Status

Jit is a single-owner pilot. [#256](https://github.com/chayapats/jit/issues/256) closed after PR #304 merged at `143ca067e3728af94badfc2eb677b4f04a5cdb59`; its Linux x64/arm64 evidence remains attributed to the exact builds and routes in the [evidence record](docs/evidence/s14-mvp-evidence.md). Owner-unread reports and deferred assistive-technology/mobile permutations remain disclosed limits. The default change does not certify another host, route, browser or website. #267 still requires actual owner-Pi installation, first reply, byte preservation and prior-release rollback.

## Quick start

Use Bun 1.4.2 or later for development. The installed service uses pinned Bun 1.4.2.

```sh
bun install --frozen-lockfile
bun start            # S14, http://localhost:3001
```

Run foreground `bun start` from an interactive terminal. Open the one-time owner link displayed there, set the password in Web and follow the existing provider device sign-in and setup flow. Redirected/non-TTY output receives no capability. No `JIT_S14_ROUTES` is required. Live replies use the selected Schway route; there is no default scripted or billing fallback. Optional local provisioning remains `bun run setup` (hidden terminal password).

For a reviewed, published release on Linux x64/arm64 with systemd, run its extracted `./install.sh`. Bare installation selects the independent `jit-s14` service at loopback port 3001. `./install.sh --uninstall` removes only its service units and retains data; legacy repair/uninstall requires `--legacy`. Follow [service installation](docs/runbooks/ops-service.md) and the [cutover procedure](docs/runbooks/s14-default-cutover.md). A moving `latest` URL is not proof of a reviewed build.

## Configuration

Source S14 uses independent environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `JIT_S14_DATABASE` | `.local/s14/application.sqlite` | Fresh schema-17 application store with its own lifecycle database |
| `JIT_S14_ORIGIN` | `http://localhost:3001` | Exact origin and loopback listener; private HTTPS ingress retains the supported loopback binding |
| `JIT_S14_VAULT_DIRECTORY` | Sibling `s14-vault` directory | Protected service credentials, outside application state and execution boxes |
| `JIT_S14_GIT_SCRATCH` | Unconfigured in source | Host Git requires verified bounded tmpfs/prlimit; the installer provisions 128 MiB |

`JIT_DATABASE` never maps to S14. An unselected source command with that legacy variable refuses; select `--legacy` or explicitly acknowledge separate S14 settings with `--s14`. Unknown/duplicate/conflicting selectors and mismatched service configs refuse before writable application state. See [selection and compatibility](docs/adr/0061-s14-default-selection-and-legacy-compatibility.md).

### Retained legacy pilot

```sh
bun src/main.ts setup --legacy
bun src/main.ts serve --legacy          # http://localhost:3000
bun run owner:reset                     # legacy only; no S14 reset command
./install.sh --legacy                   # independent retained jit layout
./install.sh --legacy --uninstall       # retains both installations' data
```

Project access levels, scripted replies, `jit ask`/`pending`, signed webhooks, Telegram and the legacy schedule feed describe this retained runtime. They are not S14 capabilities. Legacy still uses `JIT_DATABASE` (`.local/jit.sqlite`), `JIT_ORIGIN`/`JIT_PORT` (3000) and `JIT_RUN_PORT` (`scripted` by default); see [`src/config.ts`](src/config.ts). Existing canonical `serve --service-config <legacy-config>` and upgrade descriptors remain supported without adding flags to old builds. Service operator commands select the exact installation via config; S14 uses `--config /etc/jit-s14/service-config.json`, with no auto-discovery or switch to another installation.

> [!IMPORTANT]
> For remote access, put Jit behind an HTTPS reverse proxy on your VPN that preserves `Host`. Never expose the backend port directly. Jit does not trust `Forwarded` headers, and being on the VPN does not count as owner identity.

## Deploy

| Guide | Covers |
| --- | --- |
| [Service install and upgrade](docs/runbooks/ops-service.md) | Build, plan, install and upgrade the systemd service |
| [Execution box](docs/runbooks/execution-box.md) | Rootless Podman setup and `box-doctor` |
| [Pi live round](docs/runbooks/pi-live-round.md) | Host, subscription and reboot evidence on a Pi |
| [Load drill](docs/runbooks/ops-load-drill.md) | Capacity and release-evidence drills |

## Development

```sh
bun test             # deterministic: scripted models, protocol fixtures, fake clocks
bun run typecheck
```

Work is tracked in GitHub Issues. Before you change behavior, read [`AGENTS.md`](AGENTS.md), [the workflow](docs/agents/workflow.md), the relevant [spec](docs/specs/README.md) and its [ADRs](docs/adr).

## Documentation

| | |
| --- | --- |
| [Product](docs/product/README.md) | Vision, PRD, architecture, security and roadmap |
| [Specs](docs/specs/README.md) | MVP, S01, S09–S11 |
| [Contracts](docs/contracts) | Versioned behavior contracts |
| [ADRs](docs/adr) | Architecture decisions |
| [Design](docs/design/README.md) | Visual system, tokens and logo |
| [Glossary](CONTEXT.md) | Domain terms |

## License

[MIT](LICENSE) © Jit contributors. See [NOTICE](NOTICE) for Schway attribution.

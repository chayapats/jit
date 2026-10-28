# ADR 0009: Local inventory and classified host evidence

Status: accepted for FEAS01 (Jit #5).

## Context

S01 separates observed facts from configured access and requires current-host runtime/service evidence before Pi support claims. FR-13/15 and NFR-04/06/07/09/10 prohibit secrets in ordinary artifacts and require finite, reproducible checks. APP01 provides Bun/TypeScript execution and tests. Inventory must remain usable without a production Schway bridge or real subscription.

## Decision

Provide a separate `host:evidence` CLI with only `inventory --config` and `export --id`. Local configuration lives beneath the installation root's ignored `.local`. It supplies non-sensitive aliases, a declared execution-context label, exact tested PATH, working/state directories and declared routes/models. No remote target or credential field exists. Inventory observes the current host; a context label does not prove the process was launched by its final supervisor.

Use fixed local probes: OS/architecture/kernel, running Bun version, a byte-bounded `bun --version` on the explicitly tested PATH with an empty inherited environment, package-manifest versions and disposable write/fsync/remove in an existing configured state directory. Never run a shell command string. No network, credential-store read, installation, account login, supervisor provisioning or reboot occurs. Route entries remain not-configured or configured-unverified. Dependency architecture compatibility remains unverified even when versions and ARM64 are observed.

Persist only validated structured fields, not stdout, stderr, exceptions, environment, executable paths, directory paths or raw protocol data. Exact numeric/vendor versions use strict grammars; unexpected values become unverified/null. Store record files exclusively under private `.local/host-evidence`, never overwrite IDs, bound record size, and acknowledge only after file and directory sync. Export reconstructs an allowlisted summary, omitting installation aliases/UID and replacing route/model IDs. Unknown fields, symlinks, malformed records and unsafe/oversized config fail with fixed safe next-action codes.

Keep the classifier separate from observations. Only a trusted live-request inference success with a selected model, actual attempt and remaining deadline may classify observed-ready. Fixture, startup, credential-read, renewal, restart and reboot successes remain separately labeled and cannot substitute for inference. Inventory itself makes zero route attempts. Later FEAS02 owns an explicitly invoked bounded live probe; classifier availability does not authorize one.

## Consequences

Deterministic command fixtures can prove safe classification, bounds, missing/alternate PATH behavior, storage failure and sentinel exclusion without accounts or a Pi. A completed inventory remains blocked on target dependency verification and selected-route probes. Private local evidence is still local data and is not suitable for automatic issue publication. Export removes identifying fields but its remaining observations must be reviewed before sharing. Alias configuration is an explicit declaration that the alias itself is non-sensitive; it cannot contain addresses or credentials.

No capacity, credential accessibility, renewal, unattended boot or Pi deployment claim comes from this slice. See [host-evidence-v1](../contracts/host-evidence-v1.md) for exact signatures and invocation.

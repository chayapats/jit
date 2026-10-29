# Managed search — ops.searxng/v1 (WEB02 #178)

`src/web-tools/searxng.ts` implements Schway's public `SearchProvider` with
`ManagedSearxng`, `PodmanSearxngRuntime` and a fakeable `SearxngRuntime` seam.
`status()` returns `ready | unavailable` with a fixed reason (`disabled`, `podman`,
`rootless`, `runtime`). It never starts a container or sends a search. Search
validates 1–20 results and 8 KiB query input, honors cancellation, bounds JSON to
256 KiB and requires container-local health. Diagnostics/response failures are
sanitized to `searxng_unavailable`; no query is logged by the container or relay.
Cancellation (including the 45-second deadline) settles the caller even while
queued. The aborted slot skips runtime work when reached; an active slot retains
the lock until runtime work completes, so cancellation cannot overlap queries.
Queries still appear in the existing owner-visible WEB01 audit by design.

The optional installer image list pre-pulls the same digest under the service
identity; failed optional pulls do not prevent chat. Lazy first use can pull the
pin. `searxngEnabled: false` / `JIT_SEARXNG_ENABLED=0` disables Built-in regardless
of project access. Before constructing WebTools, `serviceAppConfig` combines the
parsed environment setting with the service file: either opt-out wins. Thus file
`false` disables search with the environment unset or `1`, and environment `0`
keeps it disabled even when the file says `true`. An omitted file setting retains
the environment value (default enabled). Rootless Podman/cgroup v2 with memory/cpu/pids controllers is
required, independently of whether execution boxes are configured.

[ADR 0044](../adr/0044-managed-web-search.md) defines the pin, memory scaling,
private ingress, lifecycle and network residual. The generated signing secret
lives under `<database>.searxng` with service-only permissions, never in tracked
files, SQLite, a host mount, ordinary exports or managed backup images.

## Opt-in live evidence (never part of deterministic acceptance)

On an owner-approved Linux host, as the configured service identity with rootless
Podman/cgroup v2 prepared and the optional pinned image pre-pulled:

1. `bun src/ops-cli.ts box-doctor` — inspect the `searxng` row.
2. `JIT_LIVE_SEARXNG=1 bun test tests/searxng.test.ts` — submits one public
   `SearXNG documentation` query, then removes the test container.
3. Through Web select Built-in, Test, make a public search in chat, verify
   citations/Details, wait five minutes without traffic and inspect the service
   identity's labelled container list, then search again to verify restart.
4. In an approved window stop the labelled container and search again. Verify
   recovery, readonly root, zero bind mounts and no published host ports.
5. Record only sanitized OS/architecture, image index, memory cap, pass/fail,
   tested commit and lifecycle timings in ignored `.local` evidence. Never attach
   raw queries, secret settings, addresses, container diagnostics or vault values.

This branch runs no live Podman, engine query, SSH or host change.

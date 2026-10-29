---
status: accepted
scope: S12-D03/D09/D13 engineering choices; extends ADRs 0036, 0037 and 0040
---

# Managed keyless search and Web provider settings

Confirmed: Built-in SearXNG is the default. It forwards queries to outside engines
from the installation's IP without an account or key. Tavily/Exa require explicit
Web owner selection and a vault key. Read results never grant authority.

Engineering choices (WEB02 #178):

- Official `docker.io/searxng/searxng`, release `2026.10.28-c360868e5`, pinned to
  multi-arch index `sha256:268a4b460136dcefc8f2e896b6098ba3f770c8218dbbddcb86811b06b06816f1`
  (amd64/arm64/arm). One read-only Docker Hub tag lookup verified this index.
- Rootless Podman, same service identity, capabilities dropped, no new privileges,
  read-only root, non-root uid 977, tmpfs only, 128 PIDs, one CPU. Image-declared
  volumes are ignored. No host mounts, workspace, Jit state, credentials or socket.
- SearXNG listens on **container-local** `127.0.0.1:8080`. No host port is published.
  Fixed Python HTTP relay code runs through the service user's `podman exec -i`;
  queries/configuration go through stdin, never argv or environment. Only that
  identity's container control channel reaches the loopback service. A compromised
  service identity retains control over its own containers, as with boxes.
- Bypass the image entrypoint's root ownership/CA setup. Start Granian as uid 977
  after writing generated JSON (valid YAML) configuration into container tmpfs.
  JSON search only, strict SafeSearch, only DuckDuckGo/Brave, no autocomplete,
  metrics, access logs or container logs. The limiter is off: there is no public
  listener, requests are serialized and the existing web call budget still applies;
  no Valkey sidecar is necessary.
- Generate a random 32-byte SearXNG signing secret lazily per installation. Reuse
  vault filesystem protections (0700 directory, 0600 file, no symlink traversal)
  in `<database>.searxng`, outside database/backup/export images. Only its generated
  SearXNG settings are copied into tmpfs. It is not an owner's connection credential.
- Readiness probes do not pull/start/search. First search lazily pulls the pinned
  image if absent and starts a fresh container. A process restart never trusts a
  leftover container. Inspect hardening before health/reuse. Two startup attempts
  at most within a 45-second cancellation deadline; never retry a submitted query.
  Five minutes idle stops/removes the container, serialized with search. Service
  shutdown stops it. Memory is one eighth of host RAM, clamped to 256–1024 MiB.
- `searxngEnabled: false` in service config (`JIT_SEARXNG_ENABLED=0`) opts out.
  Missing Podman/rootless cgroup support is a sanitized unavailable status; chat
  Details links directly to Settings > Web search. `box-doctor` checks the image.
- Residual: SearXNG needs outbound internet and can reach other hosts, including
  LAN destinations permitted by rootless networking. This is not the box registry
  allowlist or Schway's fetch SSRF boundary. No credentials enter this container.
  Engine availability, CAPTCHA/rate limits, kernel/container escape and an owner
  service identity compromise remain outside deterministic fixture evidence.

WEB03 #184 reuses schema 42's `web_provider`, `web.provider.set`, registry and
`web_search_key`. No duplicate table/command is required. Migration 43 adds only the nullable `key_missing` fallback audit marker. Fresh installer homes prepare a sibling service-only connections vault even when execution images are absent. A legacy
null selection means Built-in. Missing/removed selected keys fall back only to
Built-in, visibly and with an audit marker; no other vendor or billing fallback.

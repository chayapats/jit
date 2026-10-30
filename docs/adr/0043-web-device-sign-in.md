---
status: accepted
scope: SIGN01 engineering choices (S12-D10, FR-13, NFR-07/09)
---

# Web owner device sign-in through the service's secure store

The confirmed decision is S12-D10. These choices implement it with the pinned
`schway.host.device-sign-in/v1` public surface; they do not change credential or
billing authority.

- `setup.sign_in` and `setup.sign_in.cancel` are Web-only owner commands. They
  require the existing session, Origin and CSRF checks, a UUID request id, the
  revision of the displayed setup/owner-team surface, a receipt and an audit row.
  A local API actor's Web channel is insufficient. Models and Telegram cannot
  invoke these commands. A replay never starts a provider operation again.
- Setup's provider-specific Sign in button explicitly selects that provider's
  route, retaining a custom model/alias already selected on that provider, or
  using #167's configured/recommended model. Settings signs in without changing
  any route. This is an owner selection, never a failure fallback (FR-13).
- A process-owned manager keeps at most one current flow per provider. Jit uses
  only Schway's public `beginDeviceSignIn`, `checkAuthReadiness` and capability
  APIs. Production supplies no store/fetch overrides: Schway uses the service
  process identity's native secure store (Secret Service on Linux). The fixture
  profile does not read a real store while rendering readiness.
- The initial POST returns code/link once in a no-store response with `Referrer-Policy: same-origin`. That policy sends no referrer to the provider's link, and it still lets the page's cancel form post a real `Origin`. Under no-referrer, browsers post `Origin: null` (amended 2026-10-30, #222).
  The host handle remains private to the manager until settlement; no Jit read
  model retains its approval fields. GET, receipt replay, logs, model inputs and
  exports never receive them. Only `{ id, expiresAt, state }` enters existing
  command receipts, so no schema migration or credential table is needed. The
  start request UUID is also its flow id, enabling indexed receipt lookup.
- Local store reads have a five-second deadline; Schway bounds provider start
  to 30 seconds. Jit caps the whole flow at ten
  minutes and at the provider's earlier expiry. Cancellation and shutdown abort
  polling and fence credential writes. A live owner-session check runs before
  and after Schway store writes through `credentialWriteGuard`; revoked sessions,
  upgrade/restore fences and shutdown cannot authorize a late write. Native
  cleanup uncertainty remains an explicit blocked state, with store recovery
  guidance rather than a success claim. Recovery-required state is independent
  of credential reads and replacement flows; only a successful guarded commit
  clears it. Shutdown tracks the start promise before invoking host work, aborts
  it and waits for start plus polling cleanup for at most 30 seconds.
- Ready means credentials were committed, not inference access. A ready flow
  admits the existing bounded setup route check only if Jit's exact captured
  route is still current and the initiating owner's authority remains live.
  This replaces an older pending check and also works from Settings after setup.
  No model is needed to sign in. Readiness labels use local host results plus an
  existing exact-route quota result, never a new inference request.
- Plain HTML forms and a manually refreshed status page cover the full flow.
  The local script reads credential-free status every 1.5 seconds until the
  deadline, with a five-second request timeout, and returns to the provider cards
  on ready. Transient HTTP/network errors back off from three seconds to at most
  ten seconds within that same deadline; definitive HTTP errors show a localized
  error with a manual refresh retry. Refresh/replay loses the one-time approval display; the page warns
  the owner to open the verification page first. Busy offers a return/wait/retry
  action. Unknown pending ids after restart become cancelled and retryable;
  stored terminal outcomes remain terminal. No flow is resumed automatically.

Deterministic protocol/store fixtures, a fake clock and a minimal DOM cover both
providers, success, denial, expiry, cancellation (including late store writes),
busy, locked/failed stores, uncertain cleanup, restart, session revocation,
route changes, Web authority, receipt replay and the script enhancement.
Live reference-host evidence remains opt-in; see `setup-v1.md`.

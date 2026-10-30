---
status: proposed
scope: LIFE14-01/02; S14 Phase C; owner provider/client/scope decisions from issues 259/260 on 2026-10-30
---

# Installation-local Google personal broker

Owner-confirmed: Gmail + Google Calendar, separate readonly and send/events scopes, owner-supplied OAuth client per installation, no shared Jit client or central service, credentials outside execution, untrusted source content, exact-action approval and no blind retry. No authority comes from mail, an attachment, an event or a model. FR/NFR IDs remain in the slice contracts.

Selected engineering: dedicated `src/s14/personal*` modules and credential-free fresh-store tables; existing ScopePolicy/work/routine/memory/result barriers remain the integration surface. Explicit resource slots name one Bot generation/connection rather than importing Projects or extending Schway auth protocols. Personal slot ownership reserves the identity even when policy is withdrawn, so another port cannot reinterpret it. Independent consent/resource tombstones fence stale images.

Use the existing hardened ConnectionVault for atomic mode/ownership/no-symlink storage and the existing webhook AES-256-GCM pattern for sealing, with per-value AAD and a vault-only key. Jit, not a model/provider/box, performs Google's authorization-code, refresh and revoke protocols. Setup metadata never promises working consent. Exact token scopes are required; implicit incremental union is refused. Gmail readonly profile verification is available; write-only/Calendar account labels remain owner assertions unless an allowed scope verifies them. Do not add identity permissions to pretend otherwise.

A Web client has an exact registered callback on the installation's HTTPS origin, served through a trusted loopback reverse proxy. An external device must reach that origin; a localhost callback on a phone cannot reach the server. Google redirect-host/TLS/consent-app restrictions still apply. Callback consumes state and vault-captures the code without cross-site cookies, then an authenticated same-origin CSRF POST claims the exchange. No OOB copy/paste or shared relay. An interrupted exchange needs fresh consent. Proxy logs must omit callback queries. Guided UI is a later Opus deliverable.

Read choices: finite seven-day windows, five inbox messages, one small plain text attachment per message, twenty expanded events and explicit missing pagination/unsupported MIME. Calendar timezone is retained separately from the owner's brief timezone. Fifteen-minute input freshness is an engineering limit, not a statement that an old email is stale. Brief coverage derives from read outcomes and required slots rather than model no_update text. Every emitted source inherits account/resource/claim provenance; revocation blocks context and derived publication, without claiming to recall prior disclosure.

See `app.personal-read-connectors/v1`, pinned Google public sources/date in `src/s14/protocol/google-personal.json`, and the HTTP seam. Real login/provider usefulness, public Google consent verification, remote TLS deployment and Opus UI/device evidence remain opt-in and unrun.

LIFE14-02 extends the generic single-use ledger with typed exact personal draft envelopes, `calendar` class and independent provider observations. Gmail plain-text MIME has deterministic Message-ID correlation, never assumed remote deduplication; send-only consent cannot verify a sent copy and records accepted unknown. Calendar uses generated client ID/conditional etag plus exact desired-state GET read-back. Unknown is read-back/owner-reconcile only. Scope identity never follows a draft edit; content edits invalidate approval. Provider observation is not an owner statement and does not rewrite an uncertain dispatch as if it were originally known.

Opt-in live evidence is enforced in the trusted broker with same-token profile/test-calendar metadata, refusing when the extra readonly consent needed for those checks is absent. It is off for ordinary product use. Timed events/explicit recurrence and plain mail are the deliberately narrow first write slice; no all-day/attachment/conference/organizer or bulk operation is inferred. See `app.personal-effects/v1` for limitations and source links.

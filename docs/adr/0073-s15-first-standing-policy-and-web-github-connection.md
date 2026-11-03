---
status: accepted for POLICY15-02 (#384) and GIT15-04 (#385) engineering choices
date: 2026-11-03
scope: POLICY15-02, GIT15-04; FR-06/08/09/14/15/18/21/23/29/35/37/38; NFR-05/06/07/10/12/14; S15-AC01/02/08/10/15/16
---

# S15 first standing policy and Web GitHub connection on a fresh install

## Context

After `install.sh --s15` the runtime could do no work. The installer writes `policy: null`, a catalog with only the Bot, the computer resource and the Codex route/model (no purpose and no recipient for the model provider), and `github: null`. The Web rules step could only propose the configuration file's policy and refused an owner budget (`configured_budget_required`). POLICY marked a proposal installable only with a monetary budget, although the orchestrator decision of 2026-11-03 (owner may overturn) allows approved subscription routes without an owner budget through the protected subscription registry with finite concurrency and per-work bounds. GitHub could only be configured by editing the configuration file and storing the token with `credential --s15` in a terminal. Both break the owner's "just works" rule: after installing, the owner never edits a file or uses a terminal for these.

## Confirmed decisions and required behavior

- Standing owner policy is established once by the owner (S15-D01, S15-D23). Nothing installs without the owner's explicit press; model output and retrieved content cannot install, widen or renew policy.
- No numeric money allowance is chosen by the product (S15-D07). Metered spending needs a finite budget the owner types.
- Subscription-only model routes may run without an owner budget through the protected registry (orchestrator decision 2026-11-03).
- The product-default GitHub profile holds every push, pull request, review reply and merge for exact approval; the personal exception is separate opt-in (S15-D17). Production always waits (S15-D19).
- The GitHub token never enters configuration, logs, exports, prompts, the guest or HTML.
- Default policy expiry: 180 days, visible and renewable (orchestrator choice 2026-11-03).

## Selected implementation

### Protected default catalog

`s15DefaultCatalog` (`src/s15/policy/defaults.ts`) registers two runtime purposes, `owner_requested_work` and `conversation_interpretation` (revision 1), and the provider recipient of every approved model route. `runS15` resolves explicit configuration rows first, then these rows, so existing configured catalogs keep working. A later release that changes a default ref's meaning bumps its revision, which makes installed policies stale and produces a new proposal for the owner.

### Default proposal

When no policy is configured (`defaultPolicy` composition option), composition builds the proposal from what is actually composed and active in the catalog: the configured Bot; the two purposes; the working-computer pool resource; the protected browser resource when one is composed; every selected Web-connected GitHub repository; the approved routes whose route, model and recipient are active; their provider recipients; and the GitHub service recipient while repositories are connected. It has one `ordinary` rule over exactly those refs, covering the composed adapters' operations and every action class. POLICY's per-class gates still apply: ordinary edits and guest administration run, while communication, publication, merge, production, payments, disclosure, new egress and major changes each hold for exact approval. The rule names every class so the owner can approve each held action. A rule that omitted a class would leave its actions unapprovable (`policy_match_required`). The proposal never contains a personal GitHub exception, a recurring payment, a money amount, a recipient or a resource the installation does not have. An update or renewal carries over unchanged personal GitHub and recurring-payment rules that the owner installed separately, when every ref they name is still present.

Proposal instants (`now`, policy and rule expiry, budget start) use the start of the current UTC day. The exact proposal, and so its hash, is stable for a day instead of changing on every page view. Expiry is 180 days from that instant. The rules page offers renewal from 30 days before expiry, and after expiry. An expired policy blocks new admission with `expired`, and renewal installs the same scope as a new revision.

The F1 step and `/rules` show the exact rows, the expiry, the held classes and "no personal GitHub exception". One press posts the proposal hash and the TEAM list hash of the same rows. The web handler installs the proposal, then registers exactly that TEAM list. TEAM refuses if the list changed after it was shown. A changed catalog or resource set is a new proposal (`update`), never a silent change to the installed policy.

### Installability without a budget

`proposePolicy` treats `budget: null` as installable only when every selection is admitted by the protected subscription registry (`SubscriptionModels.current`) and the registry has finite tool bounds. Otherwise the owner must enter a finite budget. `runS15` builds the registry over the approved routes, admitting only a `subscription` route that is currently `available`. Its concurrency is the team concurrency.

The registry gains optional `tools` bounds: attempts, steps, calls, reads, output bytes and active time per durable work. With no monetary budget, a tool, read, effect or recovery charge is admitted only when it is zero-spend (`spendMinor: '0'`), its work's own selection is a current subscription route, the work's cumulative non-inference charges stay within `tools`, and installation concurrency allows it. A non-zero spend bound holds as `cost_unknown`. Without `tools`, the previous behavior is unchanged: tool charges hold for a finite budget. Inference keeps its separate per-work bounds. The per-work read limit comes from `tools.reads`. Human gates, adapters and all other POLICY checks are unchanged. This amends ADR 0070's "effects and reads retain their existing budget gates" only for zero-spend charges under a registry with `tools`.

Every enforced `tools` bound (attempts, steps, calls, reads, output bytes, active time) is a provided proposal field, so it is part of the exact review and `proposalHash`.

The product profile (`s15SubscriptionProfile`) sets, per work: 64 model calls, 64 steps and 4 hours of model time; and 512 tool calls, 512 reads, 512 MiB output and 8 hours of tool time. This leaves room for one GitHub implementation of 24 turns plus its VM commands, while a runaway work still stops on its own. These are technical bounds, not money.

### Metered routes

A metered route may declare its `currency` (`ApprovedModelRoute.currency`, ISO 4217). One budget covers every included metered route, so they must share one known currency. Metered routes in different currencies (`metered_currency_mixed`) or a metered route without a currency (`metered_currency_unknown`) offer no budget choice. The proposal stays uninstallable and the owner sees why. The owner types an amount, chooses that shared currency and one period (30, 90 or 180 days, never past the policy expiry). `s15MeteredBudget` turns that into an `OperatingBudget`. Its spend ceiling is the owner's amount. Its technical ceilings scale a documented per-day profile by the period, and active time also by concurrency. The budget is part of the exact proposal hash. The scope check against the installed policy uses the installed budget unless the owner has just typed a new one. Revisiting an installed, unchanged metered policy therefore shows it as current; a new amount is asked for only when the owner changes or renews the rules.

### Web GitHub connection

`GithubConnections` (`src/s15/github/connection.ts`) keeps a revisioned connection record in the protected GitHub journal (`github.sqlite`: `connection/current` plus `connection_history/r<revision>`) and the token only in `ConnectionVault` under `s15CredentialKey(installationId, 'github_web_connection')`. The token is fingerprint-registered before any use and on every boot.

- **Connect.** The token must be fine-grained (`github_pat_…`). A classic token is refused as broader than the owner steps. Verification only reads: `GET /user` for the login and the reported expiry, then `GET /user/repos` (at most 100, truncation shown). Replacing the token keeps the selection for repositories the new token can still reach.
- **Token custody.** Connect commands are serialized. A request whose receipt already exists returns its own committed record and never touches the vault. A reused request ID with another token conflicts before any verification or vault write. Only a new, verified connect writes the vault, and it does so before the journal commit. A failed commit restores the previous vault value, or removes the new one if there was none. The committed record stores the SHA-256 of the token written. `credential()` reads the vault, compares that fingerprint and refuses (`github_credential_unavailable`) on any mismatch.
- **Select.** The owner ticks repositories from the verified list. Each becomes the resource `gh_<slug>_<hash8>`, whose revision and generation both advance when a repository is selected again after it was unselected or disconnected. Unselected or removed repositories resolve as inactive, so existing work and policies over them fail as revoked. The live connection identity takes precedence over an older TEAM row. The default proposal then offers a reviewed TEAM refresh: TEAM `registerReviewed` accepts an existing row only to move it to a newer revision, with every other field unchanged. The owner's install press registers it, and until then TEAM refuses the work. The read handler, conversation tools and GitHub service follow the live selection.
- **Private DATA15 sources.** Each selected repository generation is the PRIVATE source `ghs_<slug>_<hash8>` (`ownerReleasable`), like a configured source. `workSources` adds it for work over that repository, so its content carries lineage. While selected, it has approvals only for the default policy's model provider recipients (work and interpretation purposes) and the GitHub service recipient (work purpose). Lineage reaching any other recipient is held. Unselecting removes future approvals, but every earlier generation's source stays resolvable and private, so existing lineage is never declassified.
- **Bundle bound.** The default read bound reserves 16 MiB, the protected preload's largest accepted bundle. The preload also passes the smaller of that limit and the reserved bound to the bundle broker, so an accepted bundle never overruns its charge. An overrun would set POLICY's persistent `budgetOverrun` and stop every later charge.
- **Remove.** Removal first commits the record as `removed`, so `credential()` refuses at once. It then deletes the vault value; the next boot repeats the deletion if the process stopped in between. No new GitHub work is admitted, the history stays, and anything already pushed is not undone.
- **Runtime.** With no explicit `github` configuration and a disclosure configuration present, composition builds the GitHub runtime over the live connection (`githubConnectionRuntime`), so connecting, selecting and removing apply without a restart or configuration edit. Product defaults have no inferred acceptance commands. The only test is a whitespace check of the reviewable commit, criteria never pass automatically and the production consequence is `unknown`, so merges keep their evidence and production gates. The GitHub service recipient `github_service` is active only while connected. An explicit configuration path still composes exactly as before.
- **Store addition.** This uses the same rule as the BROW15-02 browser store. An existing installation whose manifest differs only by missing additive stores (`browser.sqlite`, `github.sqlite`) gains them on reopen. An unlisted existing store is adopted, never replaced. A failed boot removes only the stores it created. The manifest is replaced atomically after every store has opened. A store the manifest already lists must still exist; a missing listed ledger refuses as before.

### Related fixes found by the fresh-install composition test

- Reading the owner's own conversations, responsibilities and model routes no longer requires a standing policy. Before this change, a fresh install could not render `/setup`, because the conversation list refused with `policy_match_required`. Admission still requires the policy.
- The installer's model-call bound now has `attempts: 1`. The model service settles one attempt per call, so `attempts: 0` recorded a permanent budget overrun on the first call. `runS15` reads a preserved `attempts: 0` bound as one attempt.

## Consequences

- A fresh install can establish standing policy and connect GitHub from the Web UI alone. The first ordinary tool-backed conversation and GitHub readiness work right after the owner's presses.
- Subscription-only installations run tool work under finite per-work technical bounds instead of a money budget. Money is never inferred.
- Web-connected repository content is private lineage by default. Releasing it to a recipient other than the model provider or GitHub needs the owner's exact approval.
- Live evidence (the owner's sandbox token on jit-vm) remains an owner step on #340/#341.

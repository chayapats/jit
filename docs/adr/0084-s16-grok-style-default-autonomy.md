---
status: accepted owner decision 2026-11-06; implementation tracked by AUTH16-01 (#442)
date: 2026-11-06
scope: S16-D06–D09, S16-D11; S16-AC02/06/07/11; FR-07/10/11/15/17/30/35/37/38/40; NFR-07/10/14
supersedes: S15-D05, S15-D06, S15-D17 (product default), S15-D20 (per-recipient part); ADR 0064 and ADR 0068 in part
---

# Grok-style default autonomy, in-chat approval and website trust tiers

## Context

S15 gave Bots standing policy but still held every message to another person, every GitHub publication outside an opt-in personal rule, and every new private-data recipient. The protected browser kept every website session outside the working VM and mediated every request, which made general browsing slow to deliver (#397, #408–#410). On 2026-11-06 the owner asked for the Grok-style experience instead: the Bot just does the work, and only what is dangerous or genuinely needs a person reaches the owner, approved inside the conversation.

## Decision

**Default autonomy (S16-D06).** Owner-requested and responsibility work runs without per-action approval. Model output, retrieved content and imported tools still cannot create authority; the standing policy remains authenticated owner configuration.

**Human-required list (S16-D07).** Only these wait for the owner:

| | Waits for the owner | Runs without approval |
| --- | --- | --- |
| a | Payments, purchases, transfers, new billing or provider accounts, budget increases. Recurring payment rules (S15-D08) stay. | Spending inside the approved operating budget |
| b | A message or email to another person that the Bot initiated itself (routine, reaction, delegation, own idea) or that reaches a recipient the owner did not name | A send the owner's own message in that conversation asked for, to the recipients the owner named |
| c | Public posts to an audience | — |
| d | Production deployment, including a merge whose consequence is a production deploy | GitHub push, PR create/update, review replies, merge after the target's required checks and reviews pass |
| e | Destructive, bulk or hard-to-reverse changes to real data outside the working VM (S15-D21 major change) | Reversible edits; anything inside the expendable working VM (RT15-01 B) |
| f | Password, account, credential, permission, authentication or approval-policy changes | — |
| g | The first disclosure of private data to a new external service or recipient. Approval registers that recipient for later use. | Already registered services/providers |
| h | Login, 2FA and CAPTCHA steps (an owner handoff, not an approval) | — |

S15-D08, D09, D19, D21, D22 and D23 remain. The product-default versus opt-in personal GitHub distinction (S15-D17/D18) ends: the former personal behavior is now the product default, and production still waits.

**In-chat approval (S16-D08).** A held action appears as a card in the conversation that shows the exact recipients, content, amount or target, with Approve and Decline. One press is an authenticated owner decision bound to that action revision and executes it once; changed content needs a new card. A typed reply such as "ok", model output, page content and notifications never approve. The separate review page remains as a deep link for long content, not as the required path.

**Website trust tiers (S16-D09).** At the login handoff, or later in settings, the owner marks a site:

- *Trusted ("use freely")*: its session lives in the working VM browser profile and the Bot uses it like the owner would. The human-required list is applied by tool policy and Bot instructions for these sites, **not** bypass-resistantly: root in the working VM can use the session for anything. The owner accepted this residual.
- *Sensitive* (default for banking, payment, primary email, identity providers and any site not marked trusted): the session stays in the protected browser outside the VM, and S15/S16 request mediation and gates apply.

The working VM browser may reach the public web so that public and trusted-site work functions. Private-data disclosure through a public site from inside the VM is therefore a recorded residual: (g) is enforced bypass-resistantly only on Jit-mediated paths (protected browser, connectors, effects broker).

## Consequences

- Policy contract revision 3 reclassifies `communication` (owner-requested, named recipients), `github_publish` and `github_merge` as ordinary and adds a remembered-recipient rule; installed policies keep their meaning until the owner accepts a new proposal.
- The protected browser is required only for sensitive sites. #408/#409/#410 narrow accordingly; general public and trusted-site browsing uses the VM browser.
- Human-required gates (a, c–g on mediated paths) keep ADR 0064's proof obligations: held until an authenticated decision, exact once, unknown outcomes reconcile without blind retry.
- Credentials for Jit itself, providers, vaults and sensitive sites never enter the working VM.

## Alternatives considered

- *Keep S15 defaults*: safest, but contradicts the requested experience and keeps the general-browser work blocked.
- *Approve by typed reply*: closest to chat, but a page or quoted text could imitate it; the one-press card gives the same flow with an authenticated, exact decision.
- *Everything in the VM*: simplest, but would expose banking/email sessions to a root-controlled guest.

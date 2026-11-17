---
status: implemented for MODEL16-01 (#421); deterministic and real-bundle checks passed; CI/review pending
date: 2026-11-18
scope: S16-AC14; FR-02/13/14/27/31/38; NFR-02/03/06/09
---

# Explicit Bot model pins and observed model usage

## Context and alternatives

BOT16-01 already stores an owner-selected route/model/effort and resolves it when admitting work. MODEL15 already owns physical-send authorization, exact effort controls, conservative reservations, provider telemetry and native contexts through Schway's public host API. The S16 client has Bot model controls but does not show these recorded observations. Its Bot resolver and form also silently return to the installation default when a saved selection disappears.

Reusing the existing MODEL service and Bot controls is simpler than adapting Rakazo's provider settings, which would import assumptions about upstream accounts and execution. A separate model registry, provider SDK or session migration would duplicate protected authority. No upstream source or new dependency is needed for this slice.

## Decision

1. A non-null Bot selection is an exact pin. If no longer approved, interpretation/admission holds with `selection_pinned`; neither the resolver nor an unrelated profile edit substitutes the default. The owner can explicitly choose another approved selection or the installation default. This supersedes only the fallback behavior in ADR 0088 decision 6 and `s16-bots/v1`.
2. Updating a Bot's model applies to newly admitted work. Existing work retains its POLICY `selectionPin`, native context and reservations. Later requests retain the same Bot/conversation and current sourced memory, using a fresh native work context under the new selection. No native session or credential is copied between routes.
3. Add `s16-client-models/v1`: a protected read-only catalog/budget projection and bounded per-request observations in conversation snapshots. Show actual recorded provider/model, requested/sent/reported effort, tokens, physical sends, state and unknown measurements. Scripted sends remain explicitly unobservable; subscription spend remains unknown and configured upper bounds are not described as measured bills.
4. Display route/account/billing/recipient identities, current availability and finite limits alongside the existing Bot model controls. Sign-in uses the existing protected `/settings/provider` flow. A catalog read makes no provider/network call and cannot register a route, create an account, increase billing or approve disclosure. New route/account/billing configuration retains its existing owner boundary and current POLICY/DATA15 intersection.
5. Query observations by at most 32 already-authorized work identities, using an additive index and a bounded SQL result. No prompt, output, credential or native-session handle enters the client projection. No journal-format/default-runtime/policy migration occurs. Old clients ignore additive fields; services without MODEL omit the capability.

## Verification

Deterministic composed-client tests must cover unavailable pins without fallback, profile edits preserving explicit pins, active-work selection versus subsequent requests, retained Bot/conversation/memory, actual versus unknown telemetry, stale/authenticated reads, bounded SQL projections, current recipient/account/budget guards and no provider work on reads. Run the existing packed Schway consumer and model dispatch/renewal/disclosure/restart regressions. Real React bundle tests cover English/Thai controls and usage at desktop/mobile widths. Live subscription/account/device evidence remains separately attributed to #431; fixtures do not certify it.

## Current evidence

The composed client/model/Bot/dispatch/disclosure/restart/packed-consumer suites pass 118 tests. Reinstating the old resolver makes the withdrawn-pin regression fail. Real React bundle checks pass in English at 1440 px and Thai at 390 px, including an unavailable saved pin, an unrelated profile edit, explicit default selection, protected sign-in entry, recorded unknown usage and no horizontal overflow. The exact packed Schway artifact is loaded in a fresh process: importing/creating a headless host loads no unselected provider implementation or TUI, then the existing protocol consumer checks exact physical-send authorization, pins, caps and renewal. Local typecheck, provenance and diff checks pass. Live provider/account evidence remains unrun here and owned by #431.

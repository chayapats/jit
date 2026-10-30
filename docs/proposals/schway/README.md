# Schway prerequisites for S14

These are issue briefs prepared for the owner, not published Schway changes or supported APIs. Parent: [Jit S14 #244](https://github.com/chayapats/jit/issues/244).

- [SCH14-01](SCH14-01-shared-credential-lifecycle.md): new proposal for safe concurrent per-run hosts sharing the selected subscription lifecycle.
- [SCH14-02](SCH14-02-session-recovery-414.md): acceptance refinement for existing [Schway #414](https://github.com/chayapats/schway/issues/414); do not open a duplicate.

Keep application authorization, Bot orchestration, computer isolation, artifacts and durable jobs in Jit. Schway owns provider renewal/retries, native sessions and supported host primitives. Separate account aliases (#413) and reusable vendor-fetch adapters are optional, not automatic prerequisites.

A closed upstream issue is insufficient: each dependent Jit ticket must pin the actual supported capability/version and passing packed-consumer evidence before enabling live behavior.

# Exact-source S16 deterministic delivery evidence

This scoped run completed the [delivery contract](../contracts/s16-delivery-evidence-v1.md)
at clean source `beab27ae9c276c200189c6e744e195ffcae70db7` on macOS arm64,
Bun 1.4.2. It records deterministic delivery inputs for #430 and #392.
Product acceptance remains blocked; this record does not close either issue or
replace #426/#431/#432 acceptance.

## Executed result

The `s16-delivery-evidence/v1` pipeline completed with exit 0. All 36 profiles
and 98 suite executions passed: 885 passing case executions, 8,112 assertions,
zero failures and zero skips. Reused suites are counted as executions, not
distinct tests. All 24 scenario rows passed their required source inputs;
the matrix retains all 56 FR/NFR requirements.

The pipeline independently observed log bytes, hashes and Bun summaries,
required every declared profile/assertion, and verified unchanged clean source,
governing documents, tools and dependencies before and after execution. It then
completed the artifact join below. Neither historical logs nor process exit
alone can produce this result.

| Record | SHA-256 |
| --- | --- |
| Final delivery receipt | `32ca68eb29c171e49862942b4c04eb6a2077f5fe7b65ff7f572958b5e481b0c1` |
| Source execution receipt | `3048d9bc77f32875306cf8abc513aa9e3999a56520ffb02e0853f075811cddbb` |
| Delivery command output | `891017997c8cedc8328d8c983577d26b4c6063aec15214832f76cfcf7178e25d` |

Receipts, raw logs and installation-specific fixture paths remain in ignored
private evidence storage. These digests identify this exact completed run;
they do not qualify another source revision automatically.

## Artifact join

| Artifact | SHA-256 | Observed basis |
| --- | --- | --- |
| Selected current service | `cf96c7ac42e4e9815e51ba7100c59b0687632f500ca10829506983f2fc86a918` | Actual package used by all four selected lifecycle journeys; independently rebuilt public source inputs match before package code is imported. |
| Service dependencies | `702579cc4a25e0720518d38f594315078d598315332c4b5ac0db396e602da962` | Full installed dependency seal, verified again after execution. |
| Service lifecycle receipt | `7a8757e7eb4a4bcc74c8d9007a96563d3287d813079e1e23b9c97ef67fc8a999` | Actual first setup, upgrade, compatible fallback and retained uninstall/reinstall. |
| Public Web assets | `1b6fa6f80cdc91361c9a4ad900a8998d1e886a38a7cb8cd5d2c74aed070b3170` | Eight assets, 1,953,670 bytes; qualified lifecycle package bytes equal the source browser bundle. |
| Web release metadata | `8a2b7f486e301e3cb35fca09ba198020d0163e6c0e3b99c9d761c105ab3d297d` | Same qualified public Web release. |
| Web worker | `5615140dd80e0fc0e84b79410542e86227f274834abb4c05223ba837fe1b2d27` | Same qualified public Web release. |
| Desktop package | `b740f8083880ed47060b5862358abfa94be79e9e316b48dd4983dc995116f663` | Exact sealed compiled package used by installed browser fixtures. |
| iOS simulator build | `d468ba1de5f6f1f7fdd9693c8502b836a581effafedbe0600ca3fc5b3f18fcab` | Release build only, 216 sealed files; native UI was not observed. |
| Android build | `6cb87abf8daf59982cefc23668329b6880b19614dffd6ab43e790e7809551e54` | Release build only, 23 sealed files; native UI was not observed. |
| Native source archive | `9f01cffe5f472511f8ecb211f50e8d8c16d9e7ad73d92c65e8076df34759b319` | Independently materialized same-commit archive: 1,901 files, 47,080,233 bytes. |
| Host parser fixture tools | `aea6d630ba6b16d245325f73b9e285fc8fc115015331d0e70ebd629ff81c2049` | Actual host tools without container-isolation acceptance. |

The service outcomes were `first_selected_healthy`, `selected_healthy`,
`fallback_healthy` and `installed_reinstalled`. The compiled desktop profile
completed all three workflow/lifecycle/connection suites: 11 passing cases,
107 assertions. Native manifests, source archives, locks, notices and complete
seals matched the same tested source and were checked again after execution.

A separate same-source GitHub negative-case supplement completed 74 passing
cases and 256 assertions across six existing owning suites. It is supplemental
scripted protocol/VM evidence, outside the 36-profile counts and without live
account acceptance.

## Corrections and remaining acceptance

Earlier complete attempts at `ae3d8f88` and `64b7d1d2` refused acceptance.
The former exposed an obsolete Search privacy assertion and the macOS desktop
cookie-store hang under synthetic HOME. The latter retained the desktop problem
and exceeded the guarded-selection profile timeout. Their logs are retained as
failed historical evidence, not relabelled as this successful run.

The tested source preserves Search privacy assertions on the current Search page.
On macOS only, desktop fixtures omit HOME to retain the OS account context needed
by vendor Chrome. Managed browser profiles, fixture state, TMP and caches remain
private; product launcher, sandbox, signature and credential-store behavior are
unchanged. All 12 operations suites completed in this run, including the full
26-case guarded-selection suite in 532.49 seconds.

The receipt intentionally retains `productAcceptance: blocked` and five pending
external rows: actual native UI, Linux VM/protected-boundary acceptance, live
provider/connected accounts, exact owner-host cutover, and configured local
speech. The separately published [Linux parser proof](s16-linux-parser-proof.md)
is scoped to its own earlier source and does not automatically satisfy these rows.
Physical signing/push, native secure-storage/background/microphone behavior,
Thai speech accuracy and owner adoption are not inferred from builds or fixtures.
The native UI merge gate on #426 remains in force.

No default-runtime cutover, installed-policy migration, production deployment,
credential disclosure or owner approval follows from this evidence.

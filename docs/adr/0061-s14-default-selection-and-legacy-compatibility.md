---
status: accepted for CUT14-01 code delivery and named owner-host evidence
date: 2026-11-01
scope: S14-D12/D13/D14/D16; S14-AC01/11/13/14; FR-01/19/22/23/25; NFR-06/08/11/12/14
---

# S14 default selection with retained legacy installations

## Confirmed decisions and prerequisites

The owner confirmed #267 on 2026-10-30: after EVID14-01 passes, switch the default and install fresh S14 separately on the existing owner host, preserving legacy and rehearsing its prior-release rollback. The owner-selected production target is the Pi; evidence VMs are not substitutes. No state erasure, conversion or credential transfer is authorized. UI/UX remains Opus 5.5 high under S14-D14. Jit retains its pinned public Schway surface under S14-D16.

PR #304 merged at `143ca067e3728af94badfc2eb677b4f04a5cdb59`; GitHub #256 and first-run #265 are closed. This supersedes the preparation plan's earlier `c051d06` observation that #256 was open. Existing #281 installer/service delivery is retained. This record refines the historical opt-in choices in accepted ADRs 0049/0059, without rewriting their evidence or promoting the broader proposed ADRs 0045–0048 to fully accepted architecture.

## Engineering choice

| Invocation/configuration | Selection |
| --- | --- |
| Bare source `serve`, `setup`, `ops` | S14, independent `.local/s14/application.sqlite`, origin `http://localhost:3001` |
| Source `--s14` | Retained explicit S14 alias |
| Source `--legacy` | Retained legacy CLI and its unchanged environment/defaults |
| Canonical `serve --service-config <legacy-config>` or other supported legacy command with named config | Legacy when validated config omits `runtime`, even with new code |
| S14 config passed as source `--service-config` | Refuse; use existing rendered S14 unit/environment |
| `service ...` | Existing config-selected operator contract; default `/etc/jit`; S14 names `--config /etc/jit-s14/service-config.json` |
| `owner-link --s14 --output-fd 3` | Exact existing private bootstrap protocol, with no bare/default alternative |
| Bare installer/internal apply/omitted `InstallerOptions.s14` | Existing independent S14 installation |
| Installer `--s14` / internal `s14:true` | Explicit S14 alias |
| Installer `--legacy` / internal `s14:false` | Explicit legacy installation/repair/uninstall |

Resolve one single-use runtime selector before application imports, writable databases, locks, native hosts, capabilities or workers. Duplicates and conflicts refuse rather than choosing precedence. Invalid S14 command/flag combinations and config mismatches refuse before state. An unselected source command carrying `JIT_DATABASE` refuses with `legacy_database_requires_explicit_runtime`; explicit `--legacy` uses that legacy setting, while explicit `--s14` acknowledges independent S14 settings. It is never copied to `JIT_S14_DATABASE`. Existing S14 legacy-format refusal remains byte-preserving, with its existing browser refusal page or explicit `--no-refusal-page` CLI behavior.

Persisted `ServiceConfig.runtime` omission is a compatibility contract, not the new-install default. It remains legacy; no parse/serialize/repair step adds S14 to old configs. Service operator commands never discover or automatically select another installation. Keep both descriptor formats unchanged: legacy `serve --service-config <path>`, S14 `serve --s14 --no-refusal-page`. Retained old builds receive their original supported argv, including during upgrade/rollback.

Root service bootstrap checks protected invocation/Bun/release/ancestor paths before operator imports. Config/unit/drop-in paths remain checked before legacy application/status imports. Shared recurrence/quiet-outcome and document primitives retain their exact existing algorithms/HTML but no longer import legacy workers at S14 module load; the stable legacy schedule module path loads its persistence implementation only on legacy invocation. No product layout or copy is authored by this extraction.

## Installer and operation boundaries

Reuse `jit-s14`, `/opt/jit-s14`, `/etc/jit-s14`, `/var/lib/jit-s14` and loopback 3001. Carry explicit legacy choice through source/downloaded bootstrap and sudo re-exec. Do not change low-level home/schema boolean defaults. Bare uninstall removes only S14 service units; `--legacy --uninstall` removes only legacy units. Both preserve all state, identities, credentials, config, immutable releases, backups and the S14 pool/mount units.

Retain eight finite 1 GiB workspace/profile ext4 pairs, full sparse commitment plus reserve/staging checks, image preparation, private 128 MiB Git scratch, protected pinned Bun/code, controlling-terminal-before-stop and exact private fd 3 capture-before-start/display-after-health ordering. S14 health remains exact login HTTP 200 with manual redirects. Configured/unverified status and its fixed computer requirement label are not inference or computer failure/readiness proof.

Same-schema code rollback keeps supported service upgrade gates and prior artifact argv. OPS14 maintenance supports schema 17→17 with current independent lifecycle/fence/native reconciliation; no downgrade, manual symlink cutover or replacement of the current ledger is introduced. No schema, vendor, provider, model, account, backend, network or default grant changes participate.

## Validation and owner-host evidence

Deterministic source/package tests cover default/alias/legacy, omission compatibility, invalid selectors/commands/configs before state, exact fd 3, import isolation, rendered old argv, scripted packaged Web first run, internal/shell/re-exec selection, x64/arm64 fake-root coexistence/repair/uninstall, health/rollback/trust and finite disk regressions. They do not establish actual Pi behavior.

Host closeout requires an actual fresh default install on the owner-selected Pi to reach its first real reply, complete consistent legacy-byte comparisons and rehearsal of the actual retained prior legacy release followed by S14 reactivation. The code-delivery PR used `Refs #267`. Refusal guidance selects `--legacy` with the current build while retaining original argv for earlier builds. Installer consent names the selected runtime and install/repair or uninstall action; uninstall lists no provisioning or setup-link steps. Existing first-run/sign-in flows are unchanged. The [cutover runbook](../runbooks/s14-default-cutover.md) records the host evidence sequence. #256's exact-build support, owner-unread reports and deferred AT/mobile coverage remain separately attributed.

## 2026-11-01 owner-Pi checkpoint

PR #305 merged at `5eec7aa7adb73858b5f7091348ef1611949cc82a` with the same tree as its six-shard CI head. The [separate cutover record](../evidence/s14-owner-pi-cutover.md) records the actual arm64 bare-default installation, one receipt-correlated tool-free Codex `gpt-6.1-sol` reply, complete R0/R1 and R2/R3 legacy-byte equality, independent Pi/Mac recoveries and actual retained prior legacy-release health. The failed start-control helper remains a failed invocation; its later independent health observation is the rollback evidence. No credential migration, legacy deletion or prior-S14 rollback is implied. Post-reply R4 equality also passed. Reviewed #267/#244 closeout remains pending; the historical engineering and evidence above keep their original attribution.

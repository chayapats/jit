# Disposable Linux installer proof

Scope: #429 / S16-AC21. This is actual Linux account/systemd installation and
HTTP owner/file continuity, separate from scripted manager tests and independent
physical-device, nested-VM isolation, live-account and owner-host acceptance.

On 2026-11-21 a new task-private Lima 2.2.1 VZ arm64 VM ran Ubuntu 24.04 with
systemd 255. It had no host mounts, forwarded SSH agent, provider login or real
owner data. Only this newly created fixture was started. The public image was
the pinned `release-20260926/ubuntu-24.04-server-cloudimg-arm64.img`, SHA-256
`1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55`.

The real `install.sh --yes --s15 --source <trusted-source>` ran through package
provisioning, SHA-pinned Bun 1.4.2, frozen dependencies, non-login accounts,
Secret Service, immutable artifact staging and first selected setup. The explicit
file configuration retained its original bytes and owner-supplied VM choice.
The actual hardened controller ran as `jit-s15`, with `KillMode=mixed`,
`SendSIGKILL=yes`, no pending manager job/control PID, and a private 0700 state
directory. The private first-owner terminal delivery was redacted in memory
before logging; its disposable HTTP setup completed with a genuine owner session.

This run exposed two source-bootstrap omissions: the public engine contract was
loaded before frozen dependencies existed, and the snapshot omitted required
license/provenance inputs. The corrected bootstrap explicitly installs missing
production inputs with scripts disabled and private cache, removes unused bin
links, and retains canonical root-owned modes. Dependency-free release dry runs
load selected operations only after their real-path selection. The original
release-tarball dry-run regression passes without downloading dependencies.

Ubuntu's globally enabled keyring also exposed an actual uninstall mismatch:
disabling its local user enablement can still report `enabled`. The corrected
protocol preserves keyring enablement, stops/read-checks its process, and restores
the original active state. It never changes global user configuration. Earlier
completed disable receipts retain their original restoration semantics.

The retained failed uninstall resumed without clearing its current fence or
replacing state. Reinstallation restored original root units, then completed an
actual compatible package upgrade over the current owning file and owner state.
At source `5e68072db251444b6cc7351b1882f475715980de`, a further complete lifecycle
passed: same-code installation retained the original PID, uninstall removed the
controller unit and stopped it, and reinstall restored wiring and a running
controller. The same original authenticated HTTP session read the same ready
upload afterward; its actual stored bytes and config hashes remained equal.
No model, payment, provider login or live native push was used.

The final Linux artifact passed runtime validation. Its package inputs were
independently rebuilt from the exact clean source, then hashed with the actual
Linux manifest metadata; this matched the actual installed seal:

- Package: `c555937ab1793eeded18288eccbc0f77801f708f93de922a95e7f8cdd5e2835d`.
- Linux dependency tree: `f2f9caf9737a664cde0cbe3cd8d1ecc36cc86eecc897f2e9f612f80cbd909c60`.
- Retained fixture file: `e61302c7e5b4c05164710360aa4cc78169e446adf7c50271ac05e1bbe80d142f`.

Private receipts retain exact commands, redacted terminal logs, source/package
comparison, config hashes and manager read-back. The disposable VM was stopped
after receipt collection. This does not establish a populated physical working
VM, real browser/provider account, native UI/push delivery or production cutover.
The engine revision remains explicitly unverified; the public contract and
vendored dependency/artifact pins are recorded rather than relabelled live proof.

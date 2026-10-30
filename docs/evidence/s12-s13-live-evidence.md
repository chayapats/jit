# S12/S13 live evidence (EVID01 #222)

This is the sanitized summary of the opt-in live rounds the owner approved on 2026-10-29/30. It has no addresses, hostnames, tokens, device codes, passwords, cookies or setup links. Raw notes live in ignored `.local` records.

## Hosts

- **Reference host:** Raspberry Pi 5 (arm64), Ubuntu 24.04, Podman 4.9.3, hardened `jit.service` (OPS09), main `45c5f0e`.
- **Fresh hosts:** two disposable Ubuntu 24.04 VMs, one arm64 (Apple virtualization) and one x64 (QEMU). Each was installed from release assets built at the tested revision with `ops/package/installer/release.ts`, then run from the extracted tarball. The assets were not published. Both VMs were deleted after the round.
- **Tested revisions:** `45c5f0e` (the start of the round) and the EVID01 fix branch (final `982dd79`).

## Results

| # | Item | Result |
| --- | --- | --- |
| 1 | INST01 one-command install | **Pass after fixes.** Both fresh VMs reach the setup link and run the service as non-root `jit` on loopback only. `<data>/attachments` is 0700 and the keyring unlock file is 0600. Linger, user `podman.socket` and the Secret Service are active, with the login collection unlocked. Re-runs repair and preserve config, data, owner and keyring; an existing owner gets `/login`. A link from an earlier run and an expired link (>15 min) are both refused with 403. A used link is also refused. A forced low-disk run fails at `disk-reserve` with its next action, and the retry succeeds. `--uninstall` removes the units and keeps the database, config, backups, attachments, keyring unlock file, identity and Bun. A reinstall afterwards works. On the arm64 VM, after a power cycle, the service, user bus and unlocked collection returned with no terminal, the pinned SearXNG image was kept, and a web question started SearXNG and was answered with a source. Found and fixed: #237, #238, #240. Not run: a fresh install on the Pi 5 itself, which would mean reflashing the reference host in use. |
| 2 | SIGN01 Web sign-in | **Pass after fix.** On the fresh arm64 VM the owner approved a Codex device code. The account reached Ready, "connect and verify" made one real call on `gpt-6.1-sol`, and Jit replied in chat with no terminal. Found and fixed: #239, plus the cancel form in #237. Grok sign-in was not run: the owner's Grok account has no credits (see item 7). |
| 3 | WEB02 managed SearXNG | **Pass** (2026-10-29 round on the reference host; again on the fresh arm64 VM). |
| 4 | ATT02 sanitizer | **Pass** (2026-10-29 round on the reference host). |
| 5 | ATT03 composer in a real browser | **Pass** on the reference host in Chromium. Pick used the real file chooser (PNG, PDF). Drop and paste used DOM DragEvent/ClipboardEvent with File data (JPEG, text). All four files reached Ready, were sent with the button and with Enter, and Jit read the pasted text file's content. Image previews load. Preview and download headers are `private, no-store`, `nosniff`, CORP same-origin and CSP `default-src 'none'; sandbox`; downloads are `attachment` + `application/octet-stream`. JPEG metadata was stripped. A 430 px-wide mobile viewport has no horizontal overflow, and pick and remove work there. Not run on a physical phone: device access was unavailable, and OS-level drag and paste were simulated in the page. |
| 6 | COMM01 live voice | **Pass** on `codex/gpt-6.1-sol` (27.7 s) after a test fix (#240): a greeting is within 80 words, and a long plan request becomes a task suggestion with a reply of at most 2 lines. |
| 7 | ATT07 image probe | **codex/gpt-6.1-sol: Passed.** A PNG then reached the model, which read it correctly. **grok/grok-4.7: Inconclusive.** The provider answered 403 `personal-team-blocked:spending-limit` (no credits or subscription on the account), which is an account state, not a Jit fault. Follow-up #241 shows that reason instead of "Inconclusive". |

## Owner decisions in this round

- 2026-10-30: the built-in Codex model is `gpt-6.1-sol` (it was `gpt-6-astra`).

## Remaining

- Upgrade the reference host so its unit gets `-/var/lib/jit/.schway` (#239). Until then, a token refresh inside the service can fail.
- #241: image-probe refusal reason.

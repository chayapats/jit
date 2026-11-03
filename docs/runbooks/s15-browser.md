# S15 protected browser

The S15 controller runs a protected Chromium for website reading ([BROW15-01 #322](https://github.com/chayapats/jit/issues/322), [BROW15-02 #380](https://github.com/chayapats/jit/issues/380), [ADR 0068](../adr/0068-s15-protected-browser-operations-and-evidence.md)). It runs on the controller host, not in the working computer, and only the controller's broker opens network connections for it. On an `install.sh --s15` installation it needs no configuration: the owner only chooses which websites Jit may read.

## What happens on its own

1. `install.sh --s15` installs Chromium's system libraries and fonts (Debian/Ubuntu; Playwright's list, with `t64` package names where the distribution uses them). If that step fails the install continues and the Web names any missing library.
2. At every controller start, `jit-s15.service` verifies the pinned Chromium under `/var/lib/jit-s15/state/browser-engine`, or downloads it once (about 200 MB), checks its SHA-256, unpacks it, records the executable's hash and checks that its libraries load. Progress and failures appear in **Manage → Websites Jit may read** (`/resources/websites`).
3. The browser starts on the first website operation after Chromium is ready. Until then the agent is told `browser_provisioning`, not made to wait.

Pinned build (from `playwright-core` 1.64.1 in `bun.lock`):

| Architecture | Chrome for Testing | SHA-256 |
| --- | --- | --- |
| x86_64 | `156.0.8078.4/linux64/chrome-linux64.zip` (200,345,244 bytes) | `43fd31766c7533a02dda2ded5ad50c2f861cd5400be7509c0abad71129f79d79` |
| aarch64 | `156.0.8078.4/linux-arm64/chrome-linux-arm64.zip` (199,750,508 bytes) | `910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce` |

Both come from `https://storage.googleapis.com/chrome-for-testing-public/`, where Playwright's own download location redirects. Updating `playwright-core` means re-pinning both builds in `src/s15/browser/chromium.ts`.

## Owner steps

In **Manage → Websites Jit may read**:

- **Add** a website: paste any link to it or type its name. Jit keeps only the HTTPS origin (for example `https://example.com`) and applies it to the next request, with no restart. `http:`, IP addresses, `localhost` and internal names (`.local`, `.internal`, `.lan`, `.home.arpa`, single-label names and similar) are refused with the reason.
- **Remove** a website: Jit stops opening it at once. Pages already read keep their public lineage.
- Limits: 200 approved at once (`website_list_full`: remove one first), and 500 different websites over the list's lifetime (`website_history_full`). Removed websites still count toward the second limit, because their records keep earlier approvals and lineage resolvable; websites approved before can always be added back. To start a fresh list, stop `jit-s15.service`, delete `/var/lib/jit-s15/state/browser-sites.sqlite` and start it again (this only narrows what Jit may read).
- What an approval allows: credential-free GET navigations without a query or body to that origin, reading and page images. It does not allow links with `?`, forms, sign-in, sending or paying. If a task holds private data, every navigation still waits for the owner's approval as a new-recipient disclosure.

When a task needs a website that is not on the list, the agent receives `website_not_approved` and the conversation shows **Add this website to Jit's list**.

On every request the controller also resolves the website's name once and connects only to the address it checked ([BROW15-03 #386](https://github.com/chayapats/jit/issues/386)). If any address of an approved name is on this machine or a private network (loopback, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, link-local and cloud metadata such as `169.254.169.254`, IPv6 local and mapped addresses), the request is refused with `website_address_not_public` before anything is sent; a name that cannot be resolved gives `request_unavailable`. There is no setting to allow private addresses. Proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) do not apply to these requests.

## Failures

| Code | Meaning | Next step |
| --- | --- | --- |
| `browser_download_unavailable` | the download failed | make `storage.googleapis.com` reachable, press **Try again** |
| `browser_checksum_mismatch` | the download did not match the pin; nothing was kept | press **Try again**; a repeat suggests the network alters the file |
| `browser_extract_failed` | unpacking failed | check `unzip` and free space, press **Try again** |
| `browser_libraries_missing` | a system library is missing; the page names it | re-run `install.sh --s15`, press **Try again** |
| `browser_engine_unavailable` | Chromium did not start for another reason | press **Try again**; search `journalctl --namespace=jit-s15 -u jit-s15.service` for the code |
| `browser_disk_insufficient` | less than 1 GiB free in the state file system | free space, press **Try again** |
| `browser_directory_unsafe` | `browser-engine` is not a private `jit-s15` directory | delete `/var/lib/jit-s15/state/browser-engine`, press **Try again** |
| `browser_host_unsupported` | not 64-bit Linux x86_64/aarch64 | none; other S15 work continues |

**Try again** re-checks files that already passed instead of downloading them again.

## Upgrades and state

- An installation that ran S15 before this browser existed gains `runtime/browser.sqlite` (the browser's generation and effect-uncertainty record) at the first start of the new release. Its manifest changes only by that store; any other difference still stops the controller with `continuity_unavailable`.
- Rollback: the installer (and the documented rollback by hand in [s15-install.md](s15-install.md#rollback-by-hand)) restores the earlier release's manifest, which does not list `browser.sqlite`; the earlier release checks only the stores it lists and starts. The file stays, and the next upgrade adopts it with its generation and any armed effect instead of recreating it. The store is created atomically, so an unlisted `browser.sqlite` that is not a complete store stops the controller with `continuity_unavailable` and is kept for inspection; move it aside only if no website effect was in flight.
- `/var/lib/jit-s15/state/browser-sites.sqlite` holds the approved websites with revisions. Deleting it while the controller is stopped empties the list, which only narrows what Jit may read.
- Deleting `/var/lib/jit-s15/state/browser-engine` while the controller is stopped makes the next start download and verify Chromium again.

## Verify on a host

1. Open `/resources/websites` and wait for **Ready** with `Chromium 156.0.8078.4 · checksum verified`.
2. Add a public website, then ask Jit in a conversation to read one of its pages; the reply uses that page's content.
3. Ask Jit to read a page of a website that is not on the list; it reports that the website is not approved and the conversation offers adding it.

Deterministic coverage: `bun test tests/s15-browser-provisioning.test.ts tests/s15-browser-sites.test.ts tests/s15-browser-egress.test.ts tests/s15-composition-browser.test.ts tests/s15-web-websites.test.ts tests/s15-installer-browser.test.ts`.

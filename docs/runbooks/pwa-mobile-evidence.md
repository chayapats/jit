# Runbook: install Jit on a phone and measure its assets on the Pi (UX03, opt-in)

Owner-executed, opt-in evidence for [web.pwa/v1](../contracts/web-pwa-v1.md) (S09-D13, NFR-06). It is not a release gate: the deterministic tests in `tests/web-ux03.test.ts` are. Nothing here changes the installation, uses model quota or needs public ingress.

Rules:

- Real hostnames, VPN addresses, device names and raw browser output stay in ignored `.local/` notes on the operator machine. Shared summaries use the sanitized installation label and the checks' results only.
- `<origin>` below is the installation's HTTPS `network.origin` from those notes (see [the service runbook](ops-service.md), "Private access").
- Record the Jit commit, the Bun version and the date with every result.

## A. Install on a real phone over the VPN

Preconditions:

- The phone is on the VPN and opens `<origin>` over HTTPS with a certificate it trusts. Browsers allow service workers and installation only in a secure context. A plain `http://` VPN address still serves every page, but it cannot install the app. Record that as `blocked: needs HTTPS origin`. Do not work around it.
- The phone has a supported browser: Chrome on Android, or Safari on iOS/iPadOS 16.4 or later.

Steps:

1. Open `<origin>` and sign in.
2. Install the app:
   - Android Chrome: menu → *Install app* (or *Add to Home screen*).
   - iOS Safari: Share → *Add to Home Screen*. iOS keeps a separate cookie store for home-screen apps, so sign in again inside the app.
3. Launch Jit from the home screen and record each check as pass, fail or blocked, with a note:

   | Check | Expected |
   | --- | --- |
   | Icon and name | The Jit tile (meditating bot on a dark square) and the name "Jit". On Android the maskable icon fills the launcher shape without clipping the figure. |
   | Standalone | No browser address bar. The status bar uses the theme background. |
   | Safe areas | The header sits below the status bar or notch. The composer and the sidebar's sign-out row sit above the home indicator. Repeat in landscape. |
   | Drawer | The menu button opens the sidebar drawer, and the close button or scrim closes it. |
   | Chat | Send a message from the home composer. Jit's reply appears in the topic. The composer stays at the bottom while the keyboard is open. |
   | Panel and search | The topic panel opens and closes. Search opens. |
   | Setup (optional, disposable installation only) | Every ตั้งจิต step fits the screen with no sideways scroll. |
   | Languages and themes | Switch Thai/English and dark/light in settings. Labels change, nothing overflows. |
   | Offline | Turn the VPN off and reopen the app. The browser's own offline page appears. No project data is shown, because pages are never cached. |
   | Sign out | Sign out and reopen. The sign-in page appears. |

4. Inspect the cache, if a desktop is at hand. For Android, use desktop Chrome `chrome://inspect` → the app → Application → Cache Storage. For iOS, use Safari Web Inspector on a Mac.
   - Expected: exactly one cache, `jit-static-<version>`.
   - Expected entries: only `/assets/…` paths. These are the stylesheet, `app.js`, three fonts, `favicon.svg` and four PNG icons.
   - Expected absent: HTML, `/api/`, `/events` and the manifest.
   - `<version>` must equal the `version` in `<origin>/sw.js`.
5. After the next Jit upgrade, reopen the app once, then repeat step 4. Expected: only the new `jit-static-<version>` remains.

Record in `.local/pwa-phone-<date>.md`:

- the device model, OS version and browser version;
- the install path you used;
- each check's result;
- the cache inspection;
- any screenshots. Before you share a screenshot, crop out the address bar and any owner content.

## B. Asset bytes and latency on the Pi

The service worker's table names exactly the cached assets. Measure them over the VPN from the operator machine. For a no-network baseline, also measure on the Pi against loopback. These are first-visit bytes. Later visits read the same files from the phone's cache.

```sh
ORIGIN='<origin>'
curl -fsS "$ORIGIN/sw.js" \
  | bun -e 'const s = await Bun.stdin.text(); const t = JSON.parse(/^const table = (.*);$/m.exec(s)[1]); console.log(`# version ${t.version}`); console.log(t.paths.join("\n"))' \
  > .local/pwa-paths.txt
grep -v '^#' .local/pwa-paths.txt | while read -r path; do
  curl -fsS -o /dev/null -w "$path %{size_download} %{time_starttransfer} %{time_total}\n" "$ORIGIN$path"
done | tee ".local/pwa-assets-$(date +%F).txt"
awk '{ bytes += $2; total += $4 } END { print "bytes", bytes, "seconds", total }' ".local/pwa-assets-$(date +%F).txt"
# Sign-in page latency (no session, no owner data):
for i in 1 2 3 4 5; do curl -fsS -o /dev/null -w "%{time_starttransfer} %{time_total}\n" "$ORIGIN/login"; done
```

Compare the byte total with the same commit's reference on the operator machine:

```sh
bun -e 'import { offlineAssets, offlineVersion } from "./src/web-pwa"; console.log(offlineVersion, offlineAssets.reduce((n, a) => n + a.body.length, 0))'
```

At the UX03 commit the allowlist is 571,840 bytes uncompressed. Most of it is the three fonts: Inter is 352,240 bytes, JetBrains Mono 113,316 and Noto Sans Thai 15,340. The server does not compress responses, so the transfer size is the same as the body size.

Record in `.local/pwa-pi-<date>.md`:

- the Pi model, OS, Bun version and Jit commit;
- whether you measured over the VPN or on loopback;
- per-asset bytes, time to first byte and total time;
- the totals;
- the five `/login` samples.

These are observations for the NFR-06 resource profile. They do not set a numeric limit by themselves.

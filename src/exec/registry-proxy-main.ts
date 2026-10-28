import { statSync } from "node:fs";
import { startRegistryProxy } from "./registry-proxy";

/**
 * Entry of the registry allowlist proxy child (exec.registry_proxy/v1, #163). The service runs it inside Podman's
 * rootless network namespace (`podman unshare --rootless-netns`), where the internal network's gateway exists:
 *
 *   bun registry-proxy-main.ts --hostname <gateway> --port <port> --hosts <host,host,…>
 *
 * It prints one ready line `{"ready":true,"port":<n>,"netns":"<inode>"}` on stdout, logs refusals on stderr (host
 * names only), and exits when stdin closes, so it never outlives the service that started it.
 */
async function main(argv: string[]): Promise<void> {
  const flag = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const hostname = flag("--hostname"), port = Number(flag("--port")), hosts = (flag("--hosts") ?? "").split(",").filter(Boolean);
  if (!hostname || !/^[0-9a-f.:]+$/.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || !hosts.length) {
    console.error("registry proxy refused invalid arguments");
    process.exit(2);
  }
  const proxy = await startRegistryProxy({ hostname, port, hosts, log: line => console.error(line) });
  const stop = async () => { await proxy.close().catch(() => undefined); process.exit(0); };
  process.on("SIGTERM", () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.on("close", () => void stop());
  process.stdin.resume();
  let netns = "none";
  try { netns = String(statSync("/proc/self/ns/net").ino); } catch { /* Not Linux: no namespace identity to report. */ }
  console.log(JSON.stringify({ ready: true, port: proxy.port, netns }));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(() => { console.error("registry proxy failed to start"); process.exit(1); });
}

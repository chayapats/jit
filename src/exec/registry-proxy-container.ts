import { startRegistryProxy } from "./registry-proxy";

// Bundled for Node in the pinned base image. Only this code and registry host names cross the exec pipe.
async function main(): Promise<void> {
  const hosts: unknown = JSON.parse(process.argv[1] ?? "null");
  if (!Array.isArray(hosts) || !hosts.length || hosts.some(h => typeof h !== "string" || !/^[a-z0-9.-]+$/i.test(h))) throw new Error("invalid_proxy_hosts");
  const proxy = await startRegistryProxy({ hostname: "0.0.0.0", port: 3128, hosts, log: line => console.error(line) });
  const stop = () => { void proxy.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.stdin.on("end", stop); process.stdin.on("close", stop); process.stdin.resume();
  console.log(JSON.stringify({ ready: true, port: proxy.port }));
}
void main().catch(() => process.exit(1));

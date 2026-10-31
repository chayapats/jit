import { isIP } from "node:net";
import { AppError } from "../errors";
import { boxInternalNetwork, pinnedImagePattern, type BoxStream } from "./box-runtime";
import { podmanCommandRunner, podmanStreamRunner, type CommandRunner, type StreamRunner } from "./podman-runtime";
import { dropsAllCapabilities, forwardingDisabled } from "./container-checks";

const egressNetwork = "jit-registry-egress";

/** Remote-compatible registry proxy: a mount-free, non-root container on internal and egress bridges, with IP forwarding disabled. */
export class ContainerRegistryProxy {
  #tail: Promise<unknown> = Promise.resolve();
  #live: { stream: BoxStream; ip: string; alive: boolean } | null = null;
  constructor(readonly image: string, readonly hosts: readonly string[], readonly run: CommandRunner = podmanCommandRunner(),
    readonly streams: StreamRunner = podmanStreamRunner(process.env, "podman", "inherit"), readonly bundle: () => Promise<string> = proxyBundle,
    readonly topology = { internalNetwork: boxInternalNetwork, name: "jit-registry-proxy" }) {
    if (!pinnedImagePattern.test(image) || !hosts.length) throw new AppError("box_proxy_unavailable", 503);
  }

  /** Ensures the proxy before each workspace ensure; returns its current internal IP so stale box environments are replaced. */
  url(): Promise<string> {
    const next = this.#tail.catch(() => {}).then(async () => {
      const { name, internalNetwork } = this.topology;
      if (this.#live?.alive) return `http://${this.#live.ip}:3128`;
      await this.#remove();
      const exists = await this.run(["network", "exists", egressNetwork], { timeoutMs: 15_000 });
      if (exists.exitCode !== 0) await this.#command(["network", "create", "--label", "jit.registry-proxy=1", egressNetwork]);
      const networks = JSON.parse(new TextDecoder().decode(await this.#command(["network", "inspect", egressNetwork])));
      if (networks[0]?.internal !== false || networks[0]?.driver !== "bridge") throw new AppError("box_proxy_unavailable", 503);
      try {
        await this.#command(["create", "--name", name, "--pull=never", "--image-volume=ignore", "--label", "jit.registry-proxy=1",
          "--network", egressNetwork, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
          "--sysctl", "net.ipv4.ip_forward=0", "--sysctl", "net.ipv6.conf.all.forwarding=0",
          "--userns=keep-id:uid=1000,gid=1000", "--user=1000:1000", "--pids-limit=64", "--memory=128m", "--cpus=0.5",
          "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777", "--log-driver=none", "--workdir", "/",
          "--http-proxy=false", "--entrypoint", "/bin/sleep", this.image, "infinity"]);
        await this.#command(["network", "connect", internalNetwork, name]);
        await this.#command(["start", name]);
        const [info] = JSON.parse(new TextDecoder().decode(await this.#command(["container", "inspect", name])));
        const host = info?.HostConfig, networks = info?.NetworkSettings?.Networks ?? {};
        const ip = networks[internalNetwork]?.IPAddress;
        // Podman 4.9 lists CapDrop per capability, omits BoundingCaps and has no HostConfig.Sysctls in inspect, so
        // capabilities and forwarding are proven inside the running container when inspect cannot prove them (#224).
        const noCaps = await dropsAllCapabilities(this.run, name, info, 15_000);
        const noForwarding = (host?.Sysctls?.["net.ipv4.ip_forward"] === "0" && host?.Sysctls?.["net.ipv6.conf.all.forwarding"] === "0") ||
          await forwardingDisabled(this.run, name, 15_000);
        if (info?.ImageName !== this.image || info?.State?.Running !== true || info?.Config?.User !== "1000:1000" || typeof ip !== "string" || isIP(ip) !== 4 ||
            Object.keys(networks).sort().join(",") !== [internalNetwork, egressNetwork].sort().join(",") ||
            host?.Privileged !== false || host?.ReadonlyRootfs !== true || (host?.CapAdd ?? []).length ||
            !noCaps || host?.SecurityOpt?.includes("no-new-privileges") !== true ||
            Object.keys(host?.PortBindings ?? {}).length || (info?.Mounts ?? []).some((m: { Type?: string }) => m.Type !== "tmpfs") ||
            !noForwarding) throw new AppError("box_proxy_unavailable", 503);
        const stream = this.streams(["exec", "-i", name, "node", "-e", await this.bundle(), JSON.stringify(this.hosts)], {});
        const live = { stream, ip, alive: true }; this.#live = live;
        void stream.exited.then(() => { live.alive = false; });
        const reader = stream.stdout[Symbol.asyncIterator](); let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([(async () => {
            let report = "";
            while (!report.includes("\n")) {
              const chunk = await reader.next();
              if (chunk.done) throw new AppError("box_proxy_unavailable", 503);
              report += new TextDecoder().decode(chunk.value);
              if (report.length > 1024) throw new AppError("box_proxy_unavailable", 503);
            }
            const value = JSON.parse(report.split("\n")[0]!);
            if (value.ready !== true || value.port !== 3128) throw new AppError("box_proxy_unavailable", 503);
          })(), stream.exited.then(() => { throw new AppError("box_proxy_unavailable", 503); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError("box_proxy_unavailable", 503)), 15_000); })]);
        } finally { clearTimeout(timer); }
        return `http://${ip}:3128`;
      } catch { await this.#remove(); throw new AppError("box_proxy_unavailable", 503); }
    });
    this.#tail = next;
    return next;
  }

  /** Stops the exec stream and removes its container after preceding starts finish. Network definitions contain no state and remain. */
  async close(): Promise<void> { await this.#tail.catch(() => {}); await this.#remove(); }
  async #remove(): Promise<void> {
    this.#live?.stream.close(); this.#live = null;
    await this.#command(["rm", "--force", "--time", "0", "--ignore", this.topology.name]);
  }
  async #command(argv: string[]): Promise<Uint8Array> {
    const result = await this.run(argv, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new AppError("box_proxy_unavailable", 503);
    return result.stdout;
  }
}

async function proxyBundle(): Promise<string> {
  const built = await Bun.build({ entrypoints: [new URL("./registry-proxy-container.ts", import.meta.url).pathname], target: "node", format: "cjs" });
  if (!built.success || built.outputs.length !== 1) throw new AppError("box_proxy_unavailable", 503);
  return built.outputs[0]!.text();
}

import type { CommandRunner } from "./podman-runtime";

const zero = "0000000000000000";

/**
 * Proves a running container holds no Linux capabilities. Podman 5 reports `CapDrop: ["ALL"]` or empty
 * `BoundingCaps`/`EffectiveCaps`; Podman 4.9 lists the dropped capabilities one by one and reports neither, so the
 * proof then reads PID 1's bounding, permitted, effective and ambient sets inside the container. Any added
 * capability, or a failed or ambiguous read, is not proof.
 */
export async function dropsAllCapabilities(run: CommandRunner, name: string, info: unknown, timeoutMs = 2000): Promise<boolean> {
  const value = info as { HostConfig?: { CapDrop?: unknown; CapAdd?: unknown }; BoundingCaps?: unknown; EffectiveCaps?: unknown } | null;
  const added = value?.HostConfig?.CapAdd;
  if (Array.isArray(added) && added.length) return false;
  const dropped = value?.HostConfig?.CapDrop;
  if (Array.isArray(dropped) && dropped.some(cap => typeof cap === "string" && cap.toUpperCase() === "ALL")) return true;
  if (Array.isArray(value?.BoundingCaps) && value.BoundingCaps.length === 0 && Array.isArray(value?.EffectiveCaps) && value.EffectiveCaps.length === 0) return true;
  const status = await run(["exec", name, "cat", "/proc/1/status"], { timeoutMs });
  if (status.exitCode !== 0) return false;
  const text = new TextDecoder().decode(status.stdout);
  return ["CapBnd", "CapPrm", "CapEff", "CapAmb"].every(key => new RegExp(`^${key}:\\s*([0-9a-f]{16})$`, "m").exec(text)?.[1] === zero);
}

/**
 * Proves IPv4 and IPv6 forwarding are off inside a running container. Podman 4.9 has no `HostConfig.Sysctls` in
 * inspect output, so the kernel values are read in the container's network namespace. A missing IPv6 file means
 * the namespace has no IPv6 stack, which forwards nothing.
 */
export async function forwardingDisabled(run: CommandRunner, name: string, timeoutMs = 2000): Promise<boolean> {
  const result = await run(["exec", name, "sh", "-c",
    "cat /proc/sys/net/ipv4/ip_forward; if [ -e /proc/sys/net/ipv6/conf/all/forwarding ]; then cat /proc/sys/net/ipv6/conf/all/forwarding; else echo 0; fi"], { timeoutMs });
  if (result.exitCode !== 0) return false;
  const lines = new TextDecoder().decode(result.stdout).trim().split("\n").map(line => line.trim());
  return lines.length === 2 && lines.every(line => line === "0");
}

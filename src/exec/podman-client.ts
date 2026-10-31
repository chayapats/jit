import { AppError } from "../errors";
import type { CommandRunner } from "./podman-runtime";

/** Explicit client selection. Remote mode accepts only the service identity's local Unix API socket. */
export interface PodmanClient { readonly remote: boolean; readonly argv: readonly string[]; readonly env: Record<string, string> }

/** Builds a credential-free Podman client environment; local mode is the development default, never a remote fallback. */
export function podmanClient(serviceEnv: Record<string, string | undefined> = process.env): PodmanClient {
  const mode = serviceEnv.JIT_PODMAN_MODE ?? "local";
  if (mode !== "remote" && mode !== "local") throw new AppError("invalid_podman_client", 503);
  const env = Object.fromEntries(["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "LANG"]
    .flatMap(name => serviceEnv[name] === undefined ? [] : [[name, serviceEnv[name]!]]));
  if (mode === "local") return { remote: false, argv: ["--remote=false"], env };
  const directory = serviceEnv.XDG_RUNTIME_DIR;
  if (!directory || !/^\/run\/user\/[1-9][0-9]*$/.test(directory)) throw new AppError("invalid_podman_client", 503);
  // The unit exposes only this service-owned directory; its /run/user/<uid> parent appears root-owned.
  // Use the bound directory for client bookkeeping too. Removing XDG_RUNTIME_DIR makes Podman 4.9 race
  // mkdir(/tmp/containers-user-<uid>) across concurrent clients and fall back to a read-only home/rundir.
  return { remote: true, argv: ["--remote", "--url", `unix://${directory}/podman/podman.sock`], env: { ...env, XDG_RUNTIME_DIR: `${directory}/podman` } };
}

/** Sanitized availability shared by search, attachments and execution; no raw runtime diagnostic is returned. */
export type PodmanReadiness = { state: "ready"; reason: null } | { state: "unavailable"; reason: "podman" | "socket" | "rootless" | "runtime" };

/** Probes the executable independently of the API, then the selected backend's rootless/cgroup contract. Never starts a container. */
export async function podmanReadiness(run: CommandRunner, remote = run.client?.remote ?? podmanClient().remote): Promise<PodmanReadiness> {
  try {
    const version = await run(["--remote=false", "--version"], { timeoutMs: 5000 });
    if (version.exitCode !== 0) return { state: "unavailable", reason: "podman" };
  } catch { return { state: "unavailable", reason: "podman" }; }
  try {
    const info = await run(["info", "--format", "json"], { timeoutMs: 5000 });
    if (info.exitCode !== 0) return { state: "unavailable", reason: remote ? "socket" : "runtime" };
    const host = JSON.parse(new TextDecoder().decode(info.stdout))?.host;
    return host?.security?.rootless === true && host.cgroupVersion === "v2" && ["cpu", "memory", "pids"].every(c => host.cgroupControllers?.includes(c))
      ? { state: "ready", reason: null } : { state: "unavailable", reason: "rootless" };
  } catch { return { state: "unavailable", reason: remote ? "socket" : "runtime" }; }
}

/** Exact operator command for a missing user socket; restarting rebinds the socket directory into the hardened unit. */
export function podmanSocketCommand(env: Record<string, string | undefined> = process.env): string {
  const uid = /^\/run\/user\/([1-9][0-9]*)$/.exec(env.XDG_RUNTIME_DIR ?? "")?.[1];
  const user = env.JIT_SERVICE_USER;
  return uid && user && /^[a-z_][a-z0-9_-]*$/.test(user)
    ? `sudo loginctl enable-linger ${user} && sudo systemctl start user@${uid}.service && sudo runuser -u ${user} -- env XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user enable --now podman.socket && sudo systemctl restart jit.service`
    : "systemctl --user enable --now podman.socket";
}

/** Exact installed doctor invocation with only allowlisted non-secret unit configuration; shell values are quoted. */
export function podmanDoctorCommand(env: Record<string, string | undefined> = process.env): string {
  const user = env.JIT_SERVICE_USER;
  if (!user || !/^[a-z_][a-z0-9_-]*$/.test(user)) return "bun src/ops-cli.ts box-doctor";
  const keys = ["XDG_RUNTIME_DIR", "JIT_PODMAN_MODE", "JIT_SERVICE_USER", "JIT_EXECUTION_DIR", "JIT_EXECUTION_SECRETS_DIR", "JIT_BOX_IMAGE_BASE", "JIT_BOX_IMAGE_BROWSER"];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const values = keys.flatMap(key => env[key] === undefined ? [] : [`${key}=${quote(env[key]!)}`]);
  return `sudo runuser -u ${user} -- env ${values.join(" ")} /opt/jit/bin/bun --no-env-file /opt/jit/current/src/ops-cli.ts box-doctor`;
}

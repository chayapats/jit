import type { CommandRunner } from "./supervisor";

/** Optional container readiness never prevents chat. Only the service identity owns the user API socket. */
export interface ServicePodmanStatus { state: "ready" | "not-installed" | "socket-unavailable"; nextAction: string | null }

/** Administrative command vectors shown by plan and used only when Podman is installed; the API unit runs as the identity. */
export function servicePodmanCommands(user: string, uid: number): [string[], string[], string[]] {
  return [["loginctl", "enable-linger", user], ["systemctl", "start", `user@${uid}.service`],
    ["runuser", "-u", user, "--", "env", `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, "systemctl", "--user", "enable", "--now", "podman.socket"]];
}

/** Read-only binary/API probes without container storage as root. Non-root callers skip runuser and need socket permission themselves. */
export async function inspectServicePodman(run: CommandRunner, user: string, uid: number, runAsIdentity = true): Promise<ServicePodmanStatus> {
  const call = async (argv: string[]) => { try { const r = await run(argv, { timeoutMs: 5000 }); return r.exitCode === 0 && !r.timedOut; } catch { return false; } };
  const asUser = runAsIdentity ? ["runuser", "-u", user, "--"] : [];
  if (!await call([...asUser, "podman", "--remote=false", "--version"])) return { state: "not-installed", nextAction: "Install Podman 4.4+, uidmap and rootless networking; re-run service install/upgrade (docs/runbooks/execution-box.md)." };
  const ready = uid > 0 && await call([...asUser, "podman", "--remote", "--url", `unix:///run/user/${uid}/podman/podman.sock`, "info", "--format", "json"]);
  return ready ? { state: "ready", nextAction: null } : { state: "socket-unavailable", nextAction: `sudo loginctl enable-linger ${user} && sudo runuser -u ${user} -- env XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user enable --now podman.socket && sudo systemctl restart jit.service` };
}

/** Enables linger and the identity's user socket idempotently outside jit.service's sandbox. Never runs rootful Podman. */
export async function enableServicePodman(run: CommandRunner, user: string, uid: number): Promise<ServicePodmanStatus> {
  const call = async (argv: string[]) => { try { const r = await run(argv, { timeoutMs: 30_000 }); return r.exitCode === 0 && !r.timedOut; } catch { return false; } };
  if (!await call(["runuser", "-u", user, "--", "podman", "--remote=false", "--version"])) return { state: "not-installed", nextAction: "Install Podman 4.4+, uidmap and rootless networking; re-run service install/upgrade (docs/runbooks/execution-box.md)." };
  const [linger, manager, command] = servicePodmanCommands(user, uid);
  const ready = await call(linger) && await call(manager) && await call(command);
  return ready ? { state: "ready", nextAction: null }
    : { state: "socket-unavailable", nextAction: `sudo loginctl enable-linger ${user} && sudo systemctl start user@${uid}.service && sudo ${command.join(" ")} && sudo systemctl restart jit.service` };
}

import type { ReadinessView } from "./exec/readiness-cache";
import { podmanDoctorCommand, podmanSocketCommand, type PodmanReadiness } from "./exec/podman-client";
import { tr } from "./i18n";
import { escape } from "./web-layout";

/** Localized next action for a service-owned container feature. Privileged host repair is shown as an operator command. */
export function podmanNotice(status: ReadinessView<PodmanReadiness> | undefined): string {
  if (!status || status.state === "ready") return "";
  if (status.state === "checking") return `<span class="container-status" role="status">${tr("podman.checking")}</span>`;
  const reason = status.reason;
  const command = reason === "socket" ? podmanSocketCommand() : reason === "podman"
    ? "sudo apt install podman uidmap slirp4netns passt   # Debian/Ubuntu\nsudo dnf install podman shadow-utils-subid slirp4netns passt   # Fedora/RHEL"
    : podmanDoctorCommand();
  return `<span class="container-status" role="status">${tr(`podman.reason_${reason}`)} ${tr("podman.operator_action")} <code>${escape(command)}</code></span>`;
}

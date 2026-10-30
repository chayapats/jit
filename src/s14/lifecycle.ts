import { createHostCredentialLifecycle, hostCapabilities, RELEASE_CONTRACT, type HostCredentialLifecycle } from "schway/host";
import { AppError } from "../errors";

/** Exact supported public host capabilities required by S14 concurrent admission. */
export function assertConcurrentHost(): void {
  const capabilities = hostCapabilities();
  if (capabilities.releaseContract !== RELEASE_CONTRACT ||
      capabilities.credentialLifecycleContract !== "schway.host.credential-lifecycle/v1" ||
      capabilities.sessionInventoryContract !== "schway.host.session-inventory/v1") {
    throw new AppError("s14_concurrent_host_unsupported", 503);
  }
}

let processLifecycle: HostCredentialLifecycle | undefined;
/** Returns the single opaque process owner shared by every S14 per-run host. */
export function s14CredentialLifecycle(): HostCredentialLifecycle {
  assertConcurrentHost();
  return processLifecycle ??= createHostCredentialLifecycle();
}

import type { AppConfig } from "../config";
import { redactRegisteredSecrets } from "../security/secret-fingerprints";
import type { TransactionStore } from "../store";
import { BoxManager, type BoxManagerOptions } from "./box-manager";
import { PodmanBoxRuntime } from "./podman-runtime";
import { startRegistryProxy, type RegistryProxy } from "./registry-proxy";

/**
 * The service's box manager on rootless Podman, or null when the operator has not configured execution
 * (`JIT_EXECUTION_DIR` and `JIT_BOX_IMAGE_BASE`). Nothing touches Podman until the first box is opened: the internal
 * network and the registry allowlist proxy on its gateway start lazily with the first `workspace` box.
 */
export function createServiceBoxes(store: TransactionStore, config: AppConfig, options: Omit<BoxManagerOptions, "now"> & { now?: () => number } = {}): BoxManager | null {
  const runtime = serviceBoxRuntime(config);
  if (!runtime) return null;
  // app.connections/v1: tool output and search lines pass the fingerprint guard before Schway sees them.
  // exec.browser/v1: with a pinned browser image every box carries the project profile (ADR 0039).
  return new BoxManager(store, config, runtime, { profile: !!config.execution.images?.browser, ...options, backend: { redact: redactRegisteredSecrets, ...options.backend } });
}

/**
 * The service's rootless Podman box runtime, or null when execution is not configured. The registry allowlist proxy
 * starts lazily on the internal network's gateway with the first `workspace` box.
 */
export function serviceBoxRuntime(config: AppConfig): PodmanBoxRuntime | null {
  if (!config.execution.directory || !config.execution.images) return null;
  let proxy: Promise<RegistryProxy> | null = null;
  return new PodmanBoxRuntime({
    config: config.execution,
    registryProxy: async gateway => (await (proxy ??= startRegistryProxy({ hostname: gateway, port: 0, hosts: config.execution.registryHosts })
      .catch(error => { proxy = null; throw error; }))).url,
  });
}

import type { AppConfig } from "../config";
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
  if (!config.execution.directory || !config.execution.images) return null;
  let proxy: Promise<RegistryProxy> | null = null;
  const runtime = new PodmanBoxRuntime({
    config: config.execution,
    registryProxy: async gateway => (await (proxy ??= startRegistryProxy({ hostname: gateway, port: 0, hosts: config.execution.registryHosts })
      .catch(error => { proxy = null; throw error; }))).url,
  });
  return new BoxManager(store, config, runtime, options);
}

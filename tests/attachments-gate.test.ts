import { expect, test } from "bun:test";
import { readConfig } from "../src/config";
import { serviceAppConfig } from "../src/ops/lifecycle";
import { parseServiceConfig, planServiceConfig, renderServiceUnit, serviceEnvironment, type ServiceConfig } from "../ops/package/service-config";

const service: ServiceConfig = {
  serviceUser: "jit-service", executablePath: "/srv/jit/release", workingDirectory: "/srv/jit/work",
  stateDirectory: "/srv/jit/state", ledgerPath: "/srv/jit/state/ledger.json", backupDirectory: "/srv/jit/backups",
  routes: [], secretRefs: [], network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
  resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 },
};

test("satisfied S13 gate keeps uploads off unless the environment or service configuration explicitly enables them", async () => {
  for (const [environment, configured, enabled] of [
    [undefined, undefined, false], ["0", undefined, false], ["1", undefined, true],
    [undefined, true, true], [undefined, false, false], ["1", false, false], ["0", true, true],
  ] as const) {
    const config = readConfig(environment === undefined ? {} : { JIT_ATTACHMENTS: environment });
    const file = { ...service, ...(configured === undefined ? {} : { attachmentsEnabled: configured }) };
    expect(serviceAppConfig(config, file).attachments.enabled).toBe(enabled);
    const env = Object.fromEntries(serviceEnvironment(file));
    expect(env.JIT_ATTACHMENTS).toBe(configured === undefined ? undefined : configured ? "1" : "0");
    if (configured !== undefined) expect(await renderServiceUnit(file, { bunPath: "/usr/bin/bun" })).toContain(`Environment=JIT_ATTACHMENTS=${configured ? "1" : "0"}`);
  }
  for (const value of ["1", "true", 1, null]) expect(() => parseServiceConfig({ ...service, attachmentsEnabled: value })).toThrow("invalid_service_config");
  expect(planServiceConfig(service, { ...service, attachmentsEnabled: true })).toContainEqual({ field: "attachmentsEnabled", before: null, after: true });
});

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mobileBuildConfig } from "../clients/mobile/tools/build-config";

test("native build selection accepts only public app configuration and snapshots it before CNG can copy it", () => {
  expect(mobileBuildConfig({})).toEqual({ applicationId: "io.jit.mobile", buildNumber: 1 });
  const directory = mkdtempSync(join(tmpdir(), "jit-mobile-public-build-")), source = join(directory, "client.json"), cache = join(directory, "cache");
  const config = { project_info: { project_id: "public-fixture-project" }, client: [{ client_info: { android_client_info: { package_name: "io.example.jit" }, mobilesdk_app_id: "public-fixture-app" }, api_key: [{ current_key: ["AI", "za"].join("") + "0".repeat(35) }] }] };
  const env = { JIT_MOBILE_APPLICATION_ID: "io.example.jit", JIT_MOBILE_BUILD_NUMBER: "17", JIT_MOBILE_GOOGLE_SERVICES: source };
  try {
    writeFileSync(source, JSON.stringify(config)); const selected = mobileBuildConfig(env, cache); expect(selected.applicationId).toBe("io.example.jit"); expect(selected.buildNumber).toBe(17); expect(selected.googleServicesFile).not.toBe(source); expect(JSON.parse(readFileSync(selected.googleServicesFile!, "utf8"))).toEqual(config);
    // Changing the input after validation cannot swap a provider credential into the file consumed by CNG.
    writeFileSync(source, JSON.stringify({ type: "service_account", private_key: "controlled-private-fixture" })); expect(() => mobileBuildConfig(env, cache)).toThrow("mobile_google_client_config_invalid"); expect(JSON.parse(readFileSync(selected.googleServicesFile!, "utf8"))).toEqual(config);
    for (const payload of [{ ...config, client_secret: "controlled-fixture" }, { ...config, nested: { refresh_token: "controlled-fixture" } }, { ...config, client: [] }, { ...config, private_key: "controlled-fixture" }]) { writeFileSync(source, JSON.stringify(payload)); expect(() => mobileBuildConfig(env, cache)).toThrow("mobile_google_client_config_invalid"); }
    writeFileSync(source, JSON.stringify(config)); const link = join(directory, "link.json"); symlinkSync(source, link); expect(() => mobileBuildConfig({ ...env, JIT_MOBILE_GOOGLE_SERVICES: link }, cache)).toThrow("mobile_google_client_config_invalid");
    for (const applicationId of ["io.example.jit\n", "https://example.test", "io.*.jit", "io.example/client", "io..jit"]) expect(() => mobileBuildConfig({ JIT_MOBILE_APPLICATION_ID: applicationId })).toThrow("mobile_build_selection_invalid");
    for (const build of ["1\n", "0", "-1", "1.0", "2100000001"]) expect(() => mobileBuildConfig({ JIT_MOBILE_BUILD_NUMBER: build })).toThrow("mobile_build_selection_invalid");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

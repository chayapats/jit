import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const node = process.env.JIT_MOBILE_NODE, native = process.env.JIT_MOBILE_NATIVE_TESTS === "1" && !!node;
(native ? test : test.skip)("actual pinned Expo public config excludes a client-file build path while explicit prebuild retains its validated snapshot", async () => {
  const parent = mkdtempSync(join(tmpdir(), "jit-mobile-config-")), source = join(parent, "public-client.json");
  writeFileSync(source, JSON.stringify({ project_info: { project_id: "public-fixture-project" }, client: [{ client_info: { android_client_info: { package_name: "io.jit.mobile" }, mobilesdk_app_id: "public-fixture-app" }, api_key: [{ current_key: ["AI", "za"].join("") + "0".repeat(35) }] }] }));
  try {
    const project = resolve("clients/mobile");
    const config = async (stage?: string) => {
      const env: Record<string, string | undefined> = { ...process.env, EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1", EXPO_OFFLINE: "1", JIT_MOBILE_GOOGLE_SERVICES: source }; delete env.JIT_MOBILE_CONFIG_STAGE; delete env.JIT_MOBILE_APPLICATION_ID;
      if (stage) env.JIT_MOBILE_CONFIG_STAGE = stage;
      const child = Bun.spawn([node!, "node_modules/expo/bin/cli", "config", "--type", "public", "--json"], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
      const text = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); return JSON.parse(text);
    };
    const publicConfig = await config(), prebuild = await config("prebuild");
    expect(publicConfig.android.googleServicesFile).toBeUndefined(); expect(JSON.stringify(publicConfig)).not.toContain(project); expect(prebuild.android.googleServicesFile).toStartWith(join(project, ".local/public-build/")); expect(prebuild.android.googleServicesFile).not.toBe(source);
    for (const permission of ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"]) expect(publicConfig.android.blockedPermissions).toContain(permission);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 30000);

(native ? test : test.skip).each(['ios', 'android'] as const)('actual Metro %s release graph resolves shared client validation without host runtime imports', async platform => {
  const directory = mkdtempSync(join(tmpdir(), 'jit-mobile-metro-')), project = resolve('clients/mobile');
  const child = Bun.spawn([node!, 'node_modules/expo/bin/cli', 'export', '--platform', platform, '--output-dir', directory], {
    cwd: project, env: { PATH: process.env.PATH, EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1', CI: '1', NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, error: exit === 0 ? null : (output + error).slice(-2000) }).toEqual({ exit: 0, error: null });
    const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8')), bundle = metadata.fileMetadata[platform].bundle;
    expect(bundle).toMatch(/\.hbc$/); expect(statSync(join(directory, bundle)).size).toBeGreaterThan(1024);
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await child.exited; rmSync(directory, { recursive: true, force: true }); }
}, 90000);

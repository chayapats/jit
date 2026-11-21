import { createHash, randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sealMobileArtifact, type MobileArtifact } from "./artifact";
import { appleNativeInputs } from "./apple-inputs";
import { prepareMobileBuildSource } from "./source";

/** Local release compilation only. No signing key, device, credential, endpoint, executable command or deployment. */
export interface MobileBuildSelection { contract: "s16-mobile-build/v1"; platform: "ios-simulator" | "android"; output: string; node: string; android?: { javaHome: string; sdk: string; gradleHome: string } }
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Strict versioned selection; paths refer to operator-owned build tools and a new artifact directory. */
export function mobileBuildSelection(raw: unknown): MobileBuildSelection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("mobile_build_selection_invalid");
  const value = raw as MobileBuildSelection, keys = Object.keys(value).sort().join();
  if (value.contract !== "s16-mobile-build/v1" || !["ios-simulator", "android"].includes(value.platform) || keys !== (value.platform === "android" ? "android,contract,node,output,platform" : "contract,node,output,platform") || ![value.node, value.output].every(path => typeof path === "string" && isAbsolute(path) && !/[\r\n\0]/.test(path))) throw Error("mobile_build_selection_invalid");
  if (value.platform === "android" && (!value.android || Object.keys(value.android).sort().join() !== "gradleHome,javaHome,sdk" || !Object.values(value.android).every(path => typeof path === "string" && isAbsolute(path) && !/[\r\n\0]/.test(path)))) throw Error("mobile_build_selection_invalid");
  return structuredClone(value);
}
/**
 * Builds arm64 release payloads from clean frozen source and reviewed native inputs. Logs remain ignored locally;
 * only build facts, public notices/inputs and the native payload enter the new integrity-sealed distribution.
 */
export async function buildMobileArtifact(raw: MobileBuildSelection): Promise<MobileArtifact> {
  const selection = mobileBuildSelection(raw), source = realpathSync(resolve(import.meta.dir, "../..")), output = resolve(selection.output);
  const rel = relative(source, output);
  if (Bun.version !== "1.4.2" || process.platform !== "darwin" || process.arch !== "arm64") throw Error("mobile_build_host_unsupported");
  if (existsSync(output) || !existsSync(dirname(output)) || output === source || !rel.startsWith("..") && !rel.startsWith(".local/")) throw Error("mobile_build_output_invalid");
  const git = (args: string[]) => { const result = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode) throw Error("mobile_source_unavailable"); return result.stdout.toString().trim(); };
  if (git(["status", "--porcelain"])) throw Error("mobile_source_dirty");
  const commit = git(["rev-parse", "HEAD"]), privateRoot = join(source, ".local/mobile-builds", randomUUID()); mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const snapshot = prepareMobileBuildSource(source, privateRoot, commit), project = join(snapshot.directory, "clients/mobile");
  const node = realpathSync(selection.node), env: Record<string, string | undefined> = { ...process.env, PATH: dirname(node) + ":" + process.env.PATH, NODE_BINARY: node, EXPO_NO_TELEMETRY: "1", EXPO_NO_DOTENV: "1", CI: "1" }; delete env.NODE_OPTIONS; delete env.JIT_MOBILE_CONFIG_STAGE;
  let step = 0;
  const run = async (args: string[], cwd = project): Promise<string> => {
    const log = join(privateRoot, `${String(++step).padStart(2, "0")}.log`), fd = openSync(log, "wx", 0o600);
    let code: number;
    try { const child = Bun.spawn(args, { cwd, env, stdout: fd, stderr: fd }); code = await child.exited; } finally { closeSync(fd); }
    if (code !== 0) throw Object.assign(Error("mobile_build_step_failed"), { code: "mobile_build_step_failed", log });
    return readFileSync(log, "utf8");
  };
  const nodeVersion = (await run([node, "--version"])).trim(); if (nodeVersion !== "v24.22.3") throw Error("mobile_node_version_mismatch");
  await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], snapshot.directory);
  await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
  await run([process.execPath, "run", "typecheck"]); await run([process.execPath, "tools/locales.ts"]);
  env.JIT_MOBILE_CONFIG_STAGE = "prebuild";
  try { await run([node, "node_modules/expo/bin/cli", "prebuild", "--clean", "--no-install", "--platform", selection.platform === "android" ? "android" : "ios"]); }
  finally { delete env.JIT_MOBILE_CONFIG_STAGE; delete env.JIT_MOBILE_GOOGLE_SERVICES; }
  const native: string[] = [];
  let payload: string;
  if (selection.platform === "ios-simulator") {
    native.push(...(await run(["xcodebuild", "-version"])).trim().split("\n"));
    native.push("CocoaPods " + (await run(["pod", "--version"])).trim());
    const sdk = (await run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"])).trim();
    native.push("iOS Simulator SDK " + (await run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"])).trim(), "SDK settings SHA-256 " + sha(join(sdk, "SDKSettings.plist")));
    await run(["pod", "install", "--deployment"], join(project, "ios"));
    writeFileSync(join(project, "ios/.xcode.env.local"), "export NODE_BINARY=" + "'" + node.replaceAll("'", "'\\''") + "'\n", { mode: 0o600 });
    await run(["xcodebuild", "-workspace", "ios/Jit.xcworkspace", "-scheme", "Jit", "-configuration", "Release", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", join(privateRoot, "ios"), "-jobs", "4", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "build"]);
    payload = join(privateRoot, "ios/Build/Products/Release-iphonesimulator/Jit.app");
    if (sha(join(project, "ios/Podfile.lock")) !== sha(join(project, "native-inputs/Podfile.lock"))) throw Error("mobile_native_inputs_changed");
    if (JSON.stringify(appleNativeInputs(snapshot.directory)) !== JSON.stringify(JSON.parse(readFileSync(join(project, "native-inputs/apple.json"), "utf8")))) throw Error("mobile_native_inputs_changed");
  } else {
    const android = selection.android!; env.JAVA_HOME = realpathSync(android.javaHome); env.ANDROID_HOME = realpathSync(android.sdk); env.ANDROID_SDK_ROOT = env.ANDROID_HOME; env.GRADLE_USER_HOME = resolve(android.gradleHome); env.PATH = join(env.JAVA_HOME, "bin") + ":" + env.PATH;
    const java = (await run([join(env.JAVA_HOME, "bin/java"), "--version"])).trim().split("\n"); if (!java[0]?.includes("21.")) throw Error("mobile_java_version_mismatch"); native.push(...java, "Android compile SDK 37, target 36, minimum 24; build tools 37.0.0; NDK 27.1.12297006");
    const platform = ["android-37.0", "android-37"].map(name => join(env.ANDROID_HOME!, "platforms", name, "package.xml")).find(existsSync);
    if (!platform) throw Error("mobile_android_sdk_missing");
    native.push("Java launcher SHA-256 " + sha(join(env.JAVA_HOME, "bin/java")), "SDK package SHA-256 " + sha(platform), "NDK properties SHA-256 " + sha(join(env.ANDROID_HOME, "ndk/27.1.12297006/source.properties")));
    const inventory = join(privateRoot, "android-inputs.json");
    await run(["./gradlew", "-I", "../tools/native-inventory.gradle", ":app:assembleRelease", ":app:jitNativeInventory", "-PjitNativeInventoryOutput=" + inventory, "-PreactNativeArchitectures=arm64-v8a", "--dependency-verification", "strict", "--no-daemon", "--no-configuration-cache", "--console=plain", "-Dorg.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=1g"], join(project, "android"));
    const actual = JSON.parse(readFileSync(inventory, "utf8")), expected = JSON.parse(readFileSync(join(project, "native-inputs/android.json"), "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("mobile_native_inputs_changed");
    payload = join(project, "android/app/build/outputs/apk/release/app-release-unsigned.apk");
  }
  if (!existsSync(payload) || git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"])) throw Error("mobile_source_changed_during_build");
  mkdirSync(output, { recursive: false, mode: 0o755 });
  cpSync(payload, join(output, selection.platform === "android" ? "Jit-arm64-unsigned.apk" : "Jit.app"), { recursive: true, dereference: false });
  for (const name of ["LICENSE", "NOTICE", "third_party"]) cpSync(join(snapshot.directory, name), join(output, name), { recursive: true, dereference: false });
  for (const name of ["notices", "native-inputs"]) cpSync(join(project, name), join(output, name), { recursive: true, dereference: false });
  cpSync(join(project, "bun.lock"), join(output, "client-bun.lock")); cpSync(join(snapshot.directory, "bun.lock"), join(output, "root-bun.lock"));
  writeFileSync(join(output, "build-source.json"), JSON.stringify({ contract: "s16-mobile-build-source/v1", commit, archiveSha256: snapshot.archiveSha256, files: snapshot.files, bytes: snapshot.bytes, nativeProject: "fresh-cng", prebuildClean: true }, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  return sealMobileArtifact(output, { contract: "s16-mobile-artifact/v1", platform: selection.platform, architecture: "arm64", acceptance: "build-only", source: { commit, rootLockSha256: sha(join(snapshot.directory, "bun.lock")), clientLockSha256: sha(join(project, "bun.lock")), podLockSha256: sha(join(project, "native-inputs/Podfile.lock")), appleInputsSha256: sha(join(project, "native-inputs/apple.json")), androidInputsSha256: sha(join(project, "native-inputs/android.json")), verificationSha256: sha(join(project, "native-inputs/gradle-verification-metadata.xml")), noticesSha256: sha(join(project, "notices/index.json")) }, toolchain: { bun: Bun.version, nodeVersion, nodeSha256: sha(node), native } });
}

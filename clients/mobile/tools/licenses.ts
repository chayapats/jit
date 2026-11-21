import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

interface Notice { path: string; text: string; sha256: string; url?: string }
interface Supplement { name: string; license: string; files: Notice[]; commit: string; repo: string; tag: string; licenseReferenceOnly?: boolean }
interface Component { id: string; license: string; notices: string[] }
const project = resolve(import.meta.dir, ".."), root = resolve(project, "../.."), input = join(project, "native-inputs");
const sha = (text: string | Uint8Array) => Bun.SHA256.hash(text, "hex");
const read = (file: string) => readFileSync(file, "utf8");
const texts = new Map<string, { id: string; text: string }>(), components = new Map<string, Component>(), provenance: unknown[] = [];
function text(value: string): string { const id = sha(value); texts.set(id, { id, text: value }); return id; }
function file(path: string): string { return text(read(path)); }
function component(id: string, license: string, notices: string[]): void { if (!notices.length) throw Error("mobile_notice_missing:" + id); components.set(id, { id, license, notices: [...new Set(notices)] }); }
const native = JSON.parse(read(join(input, "notices.json"))) as { supplements: Supplement[]; ndk: { version: string; files: Notice[] }; androidSdkTerms: Notice; brotliSource: { notice: string }; publicSuffix: { source: string; sourceSha256: string } };
const supplemental = new Map<string, string[]>();
for (const value of native.supplements) {
  const ids = value.files.map(notice => { if (sha(notice.text) !== notice.sha256 || !notice.url?.includes(value.commit)) throw Error("mobile_notice_hash_invalid"); return text(notice.text); });
  supplemental.set(value.name, ids); provenance.push({ component: value.name, license: value.license, repo: value.repo, tag: value.tag, commit: value.commit, licenseReferenceOnly: value.licenseReferenceOnly ?? false, files: value.files.map(({ path, sha256, url }) => ({ path, sha256, url })) });
  component("Native reference / " + value.name, value.license, ids);
}
for (const value of native.ndk.files) { if (sha(value.text) !== value.sha256) throw Error("mobile_notice_hash_invalid"); component(`Android NDK ${native.ndk.version} / ${value.path}`, "Original bundled notices, including LLVM runtime exceptions", [text(value.text)]); }
if (sha(native.androidSdkTerms.text) !== native.androidSdkTerms.sha256) throw Error("mobile_notice_hash_invalid");
const sdkTerms = text(native.androidSdkTerms.text), apache = file(join(root, "third_party/rakazo/LICENSE")), mpl = file(join(project, "node_modules/lightningcss/LICENSE"));
component("Jit", "MIT and retained Apache-2.0 adaptations", [file(join(root, "LICENSE")), file(join(root, "NOTICE")), apache]);
component("Public Suffix List in OkHttp 4.12.0", "MPL-2.0", [mpl, text("Original notice: https://publicsuffix.org/list/public_suffix_list.dat\nMPL-2.0: https://mozilla.org/MPL/2.0/\nThe exact reconstructed rule source is included below and in native-inputs/public-suffix-list.txt. Modified by Jit as stated in that source.")]);
const suffix = read(join(input, native.publicSuffix.source)); if (sha(suffix) !== native.publicSuffix.sourceSha256) throw Error("mobile_notice_hash_invalid"); component("Public Suffix List / corresponding source", "MPL-2.0", [text(suffix)]);
const npm = new Map<string, { directory: string; name: string; version: string; license: string }>();
function packageAt(start: string): void {
  let directory = start;
  while (directory.startsWith(join(project, "node_modules") + "/")) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) { const value = JSON.parse(read(manifest)); if (typeof value.name === "string" && typeof value.version === "string") { npm.set(`${value.name}@${value.version}`, { directory, name: value.name, version: value.version, license: value.license }); return; } }
    directory = dirname(directory);
  }
}
const maps = process.argv.slice(2); if (maps.length !== 2) throw Error("mobile_two_platform_sourcemaps_required");
for (const path of maps) {
  const map = JSON.parse(read(resolve(path))) as { sources: string[] };
  for (const source of map.sources) if (source.startsWith("/node_modules/")) packageAt(dirname(join(project, source.slice(1))));
  provenance.push({ sourceMapSha256: sha(read(resolve(path))), platform: path.includes("android") ? "android" : "ios", purpose: "runtime component discovery, not device acceptance" });
}
const podLock = Bun.YAML.parse(read(join(project, "ios/Podfile.lock"))) as Record<string, Record<string, Record<string, string>>>;
for (const value of Object.values(podLock["EXTERNAL SOURCES"] ?? {})) for (const path of Object.values(value)) if (path.includes("node_modules/")) { const location = resolve(project, "ios", path); packageAt(existsSync(location) && statSync(location).isDirectory() ? location : dirname(location)); }
const lock = Bun.JSON5.parse(read(join(project, "bun.lock"))) as { packages: Record<string, unknown[]> };
const rnLicense = file(join(project, "node_modules/react-native/LICENSE")), expoLicense = file(join(project, "node_modules/expo/LICENSE")), hermesLicense = file(join(project, "ios/Pods/hermes-engine/LICENSE"));
for (const [id, value] of [...npm.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const resolved = Object.values(lock.packages).find(entry => entry[0] === id), integrity = resolved?.at(-1);
  if (!resolved || typeof integrity !== "string" || !integrity.startsWith("sha512-") || !["MIT", "ISC"].includes(value.license)) throw Error("mobile_npm_license_review_required:" + id);
  let names = readdirSync(value.directory).filter(name => /^(?:LICEN[SC]E|NOTICE|COPYING|COPYRIGHT|THIRD.PARTY)/i.test(name) && statSync(join(value.directory, name)).isFile());
  const ids = names.map(name => file(join(value.directory, name)));
  if (!ids.length && value.name.startsWith("@react-native/") && value.version === "0.88.1") ids.push(rnLicense);
  component("npm / " + id, value.license, ids);
  provenance.push({ component: id, registryIntegrity: integrity, files: names.map(name => ({ path: name, sha256: sha(readFileSync(join(value.directory, name))) })), ...(names.length ? {} : { licenseFrom: "react-native@0.88.1/LICENSE" }) });
}
const android = JSON.parse(read(join(input, "android.json"))) as { modules: { coordinate: string; licenses: { name: string; url: string }[]; pomSha256: string }[]; artifacts: { coordinate: string; notices: Notice[] }[] };
for (const module of android.modules) {
  const declared = module.licenses.map(value => value.name).join(" OR "), ids: string[] = [];
  if (/Apache|APACHE/.test(declared)) ids.push(apache);
  else if (/Android Software/.test(declared)) ids.push(sdkTerms);
  else if (/BSD/.test(declared)) ids.push(...supplemental.get(module.coordinate.startsWith("com.parse.bolts:") ? "Bolts Android" : "Protocol Buffers license reference")!);
  else if (/MIT/.test(declared)) {
    const coordinate = module.coordinate;
    const reference = coordinate.startsWith("com.facebook.fresco:") ? "Fresco" : coordinate.startsWith("com.facebook.infer.annotation:") ? "Infer annotations" : coordinate.startsWith("com.facebook.yoga:") ? "Yoga" : coordinate.startsWith("org.brotli:") ? "Brotli license reference" : coordinate.startsWith("io.github.expo.kolibri:") ? "Kolibri" : coordinate.startsWith("io.github.expo.pika:") ? "Pika" : coordinate.startsWith("io.github.expo:") ? "Expo Modules V2" : null;
    if (reference) { const notices = supplemental.get(reference); if (!notices) throw Error("mobile_native_license_review_required:" + coordinate); ids.push(...notices); }
    else if (coordinate.startsWith("com.facebook.hermes:")) ids.push(hermesLicense);
    else if (coordinate.startsWith("com.facebook.react:")) ids.push(rnLicense);
    else if (coordinate.startsWith("expo.modules.") || coordinate.startsWith("host.exp.exponent:")) ids.push(expoLicense);
    else throw Error("mobile_native_license_review_required:" + coordinate);
    if (coordinate.startsWith("org.brotli:")) ids.push(text(native.brotliSource.notice));
  } else throw Error("mobile_native_license_review_required:" + module.coordinate);
  for (const artifact of android.artifacts.filter(value => value.coordinate === module.coordinate)) for (const notice of artifact.notices) { if (sha(notice.text) !== notice.sha256) throw Error("mobile_notice_hash_invalid"); ids.push(text(notice.text)); }
  component("Android / " + module.coordinate, declared, ids);
}
component("iOS / CocoaPods acknowledgements", "Original generated acknowledgements", [file(join(project, "ios/Pods/Target Support Files/Pods-Jit/Pods-Jit-acknowledgements.markdown"))]);
const output = join(project, "notices"); mkdirSync(output, { recursive: true });
writeFileSync(join(output, "index.json"), JSON.stringify({ contract: "s16-mobile-notices/v1", components: [...components.values()].sort((a, b) => a.id.localeCompare(b.id)), texts: [...texts.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + "\n");
writeFileSync(join(output, "provenance.json"), JSON.stringify({ contract: "s16-mobile-license-provenance/v1", clientLockSha256: sha(readFileSync(join(project, "bun.lock"))), podLockSha256: sha(readFileSync(join(project, "ios/Podfile.lock"))), entries: provenance }, null, 2) + "\n");
console.log(JSON.stringify({ components: components.size, uniqueTexts: texts.size, npm: npm.size, publicOutput: relative(root, output) }));

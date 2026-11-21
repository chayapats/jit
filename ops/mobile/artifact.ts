import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** An exact unsigned/simulator distribution seal. It never establishes signing, install authority or device acceptance. */
export interface MobileArtifact {
  contract: "s16-mobile-artifact/v1"; id: string; platform: "ios-simulator" | "android"; architecture: "arm64"; acceptance: "build-only";
  source: { commit: string; rootLockSha256: string; clientLockSha256: string; podLockSha256: string; appleInputsSha256: string; androidInputsSha256: string; verificationSha256: string; noticesSha256: string };
  toolchain: { bun: string; nodeVersion: string; nodeSha256: string; native: string[] };
  files: { path: string; bytes: number; sha256: string; executable: boolean }[];
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Complete non-following ordinary-file inventory; output excludes only its own top-level manifest. */
function files(root: string, prefix = ""): MobileArtifact["files"] {
  const output: MobileArtifact["files"] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? prefix + "/" + name : name;
    if (!prefix && name === "mobile-manifest.json") continue;
    if (!name || /[\\\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..") throw Error("mobile_artifact_member_invalid");
    const full = join(root, path), info = lstatSync(full);
    if (info.isSymbolicLink()) throw Error("mobile_artifact_link_refused");
    if (info.isDirectory()) output.push(...files(root, path));
    else if (info.isFile() && info.nlink === 1) output.push({ path, bytes: info.size, sha256: hash(readFileSync(full)), executable: !!(info.mode & 0o111) });
    else throw Error("mobile_artifact_member_invalid");
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
const sha = (value: unknown): value is string => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/.test(value);
function validate(value: Omit<MobileArtifact, "id" | "files">): void {
  if (value.contract !== "s16-mobile-artifact/v1" || !["ios-simulator", "android"].includes(value.platform) || value.architecture !== "arm64" || value.acceptance !== "build-only" || !value.source || typeof value.source.commit !== "string" || value.source.commit.length !== 40 || /[^a-f0-9]/.test(value.source.commit) || Object.entries(value.source).some(([key, data]) => key !== "commit" && !sha(data)) || Object.keys(value.source).sort().join() !== "androidInputsSha256,appleInputsSha256,clientLockSha256,commit,noticesSha256,podLockSha256,rootLockSha256,verificationSha256" || !value.toolchain || Object.keys(value.toolchain).sort().join() !== "bun,native,nodeSha256,nodeVersion" || value.toolchain.bun !== "1.4.2" || value.toolchain.nodeVersion !== "v24.22.3" || !sha(value.toolchain.nodeSha256) || !Array.isArray(value.toolchain.native) || value.toolchain.native.length < 1 || value.toolchain.native.length > 16 || value.toolchain.native.some(line => typeof line !== "string" || !line.length || line.length > 256 || /[\r\n\u0000]/.test(line))) throw Error("mobile_artifact_manifest_invalid");
}
/** Seal a newly built, already staged payload. Callers supply only verified build facts, never an acceptance claim. */
export function sealMobileArtifact(directory: string, metadata: Omit<MobileArtifact, "id" | "files">): MobileArtifact {
  validate(metadata); const root = resolve(directory);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error("mobile_artifact_root_invalid");
  const inventory = files(root); if (!inventory.length) throw Error("mobile_artifact_empty");
  const unsigned = { ...metadata, files: inventory }, manifest: MobileArtifact = { ...unsigned, id: hash(JSON.stringify(unsigned)) };
  writeFileSync(join(root, "mobile-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o644 }); return manifest;
}
/** Check an integrity seal and actual payload without running, installing, trusting or following any contained file. */
export function verifyMobileArtifact(directory: string): MobileArtifact {
  const root = resolve(directory), info = lstatSync(root), manifestPath = join(root, "mobile-manifest.json");
  if (info.isSymbolicLink() || !info.isDirectory() || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink() || lstatSync(manifestPath).size > 16 * 1048576) throw Error("mobile_artifact_root_invalid");
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as MobileArtifact; validate(value);
  if (Object.keys(value).sort().join() !== "acceptance,architecture,contract,files,id,platform,source,toolchain" || !sha(value.id) || !Array.isArray(value.files) || value.files.length > 100000) throw Error("mobile_artifact_manifest_invalid");
  const { id, ...unsigned } = value;
  if (hash(JSON.stringify(unsigned)) !== id || JSON.stringify(files(root)) !== JSON.stringify(value.files)) throw Error("mobile_artifact_changed");
  return value;
}

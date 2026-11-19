import { constants, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { desktopService } from "./boundary";
import { desktopExecutable } from "./executable";
import { leaseDesktopProfile, privateDesktopDirectory, readDesktopRecord, writeDesktopFile, writeDesktopRecord } from "./storage";
import type { Locale } from "../../i18n";

/** A native code/dependency file, independent of all private browser/service state. */
export interface NativeDesktopFile { path: string; sha256: string; bytes: number; mode: number }
/** Sealed local release. Chrome/Bun are explicit installed inputs and are never inside this package. */
export interface NativeDesktopManifest {
  contract: "s16-desktop-native-release/v1"; id: string; version: string; bunVersion: string; playwrightVersion: string;
  source: { commit: string | null; dirty: boolean; lockHash: string }; files: NativeDesktopFile[];
}
/** Private installation identity; no owner session, command, runtime flag or provider credential is a field. */
export interface DesktopInstallation { contract: "s16-desktop-installation/v1"; bun: string; browser: string; locale: Locale; service: string | null; bootstrapHash: string }
/** Atomic release pointer; a code rollback never rewinds a profile, receipt or service journal. */
export interface DesktopCurrent { contract: "s16-desktop-current/v1"; active: string; previous: string | null }
/** Finite local package/retention bounds, not private application quotas. */
export const nativeDesktopLimits = Object.freeze({ files: 4096, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, releases: 8 });
const hex = /^[a-f0-9]{64}$/, hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
const safePath = (path: string) => !isAbsolute(path) && path.split("/").every(part => !!part && part !== "." && part !== ".." && !/[\\\u0000-\u001f]/.test(part));
const sync = (path: string) => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
function syncTree(root: string): void { for (const name of readdirSync(root)) { const path = join(root, name); if (lstatSync(path).isDirectory()) syncTree(path); else sync(path); } sync(root); }

function inventory(directory: string): NativeDesktopFile[] {
  const root = realpathSync(directory), rootInfo = lstatSync(directory), files: NativeDesktopFile[] = []; let total = 0;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022) !== 0) throw new Error("desktop_release_directory_invalid");
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name), rel = relative(root, path), info = lstatSync(path);
      if (rel === "manifest.json") continue;
      if (!safePath(rel) || info.isSymbolicLink()) throw new Error("desktop_release_path_invalid");
      if (info.isDirectory()) { if ((info.mode & 0o022) !== 0) throw new Error("desktop_release_mode_invalid"); walk(path); }
      else if (info.isFile() && info.nlink === 1 && [0o644, 0o755].includes(info.mode & 0o7777)) {
        total += info.size;
        if (files.length >= nativeDesktopLimits.files || info.size > nativeDesktopLimits.fileBytes || total > nativeDesktopLimits.totalBytes) throw new Error("desktop_release_limit");
        files.push({ path: rel, sha256: hash(readFileSync(path)), bytes: info.size, mode: info.mode & 0o7777 });
      } else throw new Error("desktop_release_member_invalid");
    }
  };
  walk(root); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function core(value: Omit<NativeDesktopManifest, "id">): Omit<NativeDesktopManifest, "id"> {
  return { contract: value.contract, version: value.version, bunVersion: value.bunVersion, playwrightVersion: value.playwrightVersion,
    source: { commit: value.source.commit, dirty: value.source.dirty, lockHash: value.source.lockHash },
    files: value.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, mode: file.mode })) };
}

/** Seals a generated complete public code tree; called only by the native package producer. */
export function sealNativeDesktop(directory: string, metadata: Omit<NativeDesktopManifest, "contract" | "id" | "files">): NativeDesktopManifest {
  const base = core({ contract: "s16-desktop-native-release/v1", ...metadata, files: inventory(directory) });
  const manifest = { ...base, id: hash(JSON.stringify(base)) };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  return verifyNativeDesktop(directory);
}

/** Verifies exact schema, canonical unambiguous JSON, every file/mode/hash, required entry and dependency pin. */
export function verifyNativeDesktop(directory: string): NativeDesktopManifest {
  const file = join(directory, "manifest.json"), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o644 || info.size > 4 * 1024 * 1024) throw new Error("desktop_manifest_invalid");
  const text = readFileSync(file, "utf8"); let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("desktop_manifest_invalid"); }
  if (!exact(value, ["contract", "id", "version", "bunVersion", "playwrightVersion", "source", "files"]) || text !== JSON.stringify(value, null, 2) + "\n" || value.contract !== "s16-desktop-native-release/v1" || typeof value.id !== "string" || !hex.test(value.id) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) || value.bunVersion !== "1.4.2" || value.playwrightVersion !== "1.64.1") throw new Error("desktop_manifest_invalid");
  if (!exact(value.source, ["commit", "dirty", "lockHash"]) || value.source.commit !== null && (typeof value.source.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.source.commit)) || typeof value.source.dirty !== "boolean" || typeof value.source.lockHash !== "string" || !hex.test(value.source.lockHash) || !Array.isArray(value.files) || value.files.length > nativeDesktopLimits.files) throw new Error("desktop_manifest_invalid");
  for (const file of value.files) if (!exact(file, ["path", "sha256", "bytes", "mode"]) || typeof file.path !== "string" || !safePath(file.path) || typeof file.sha256 !== "string" || !hex.test(file.sha256) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || ![0o644, 0o755].includes(Number(file.mode))) throw new Error("desktop_manifest_invalid");
  const manifest = value as unknown as NativeDesktopManifest;
  if (hash(JSON.stringify(core(manifest))) !== manifest.id || JSON.stringify(inventory(directory)) !== JSON.stringify(manifest.files)) throw new Error("desktop_release_hash_invalid");
  for (const path of ["main.js", "bootstrap.js", "icon.png", "icon.icns", "LICENSE", "NOTICE", "node_modules/playwright-core/package.json", "node_modules/playwright-core/LICENSE", "node_modules/playwright-core/NOTICE", "node_modules/playwright-core/ThirdPartyNotices.txt"]) if (!manifest.files.some(file => file.path === path)) throw new Error("desktop_release_incomplete");
  const dependency = JSON.parse(readFileSync(join(directory, "node_modules/playwright-core/package.json"), "utf8")) as { version?: string };
  if (dependency.version !== manifest.playwrightVersion) throw new Error("desktop_dependency_mismatch");
  return manifest;
}

/** Reads the private installed configuration with exact identity/field validation. */
export function desktopInstallation(root: string): DesktopInstallation {
  const value = readDesktopRecord(join(privateDesktopDirectory(root), "installation.json"));
  if (!exact(value, ["contract", "bun", "browser", "locale", "service", "bootstrapHash"]) || value.contract !== "s16-desktop-installation/v1" || typeof value.bun !== "string" || !isAbsolute(value.bun) || typeof value.browser !== "string" || !isAbsolute(value.browser) || !["en", "th"].includes(String(value.locale)) || typeof value.bootstrapHash !== "string" || !hex.test(value.bootstrapHash) || value.service !== null && (typeof value.service !== "string" || desktopService(value.service) !== value.service)) throw new Error("desktop_installation_invalid");
  return value as unknown as DesktopInstallation;
}

/** Reads the atomic code pointer. An absent pointer is an incomplete first install, never inferred activation. */
export function desktopCurrent(root: string): DesktopCurrent | null {
  const path = join(root, "current.json"); if (!existsSync(path)) return null;
  const value = readDesktopRecord(path);
  if (!exact(value, ["contract", "active", "previous"]) || value.contract !== "s16-desktop-current/v1" || typeof value.active !== "string" || !hex.test(value.active) || value.previous !== null && (typeof value.previous !== "string" || !hex.test(value.previous)) || value.active === value.previous) throw new Error("desktop_current_invalid");
  return value as unknown as DesktopCurrent;
}

/** Verifies the stable bootstrap and immutable active release before any dynamic import or browser launch. */
export function activeNativeDesktop(root: string): { directory: string; manifest: NativeDesktopManifest; installation: DesktopInstallation } {
  const installation = desktopInstallation(root), current = desktopCurrent(root);
  if (!current) throw new Error("desktop_install_incomplete");
  const bootstrap = join(root, "bootstrap.js"), info = lstatSync(bootstrap);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || hash(readFileSync(bootstrap)) !== installation.bootstrapHash) throw new Error("desktop_bootstrap_invalid");
  const directory = join(root, "releases", current.active), manifest = verifyNativeDesktop(directory);
  if (manifest.id !== current.active || manifest.files.find(file => file.path === "bootstrap.js")?.sha256 !== installation.bootstrapHash) throw new Error("desktop_release_identity_invalid");
  return { directory, manifest, installation };
}

/** Installation/update crash boundaries for controlled evidence; no callback is accepted from a renderer or CLI. */
export type DesktopInstallCheckpoint = (phase: "staged" | "renamed" | "committed") => void;

/**
 * Stages/revalidates one explicitly selected local release before atomically changing the code pointer. First install
 * requires exact local runtime inputs. Updates retain configuration, profiles and the preceding complete release.
 */
export function installNativeDesktop(options: { artifact: string; root: string; runtime?: { bun: string; browser: string; locale: Locale; service?: string } }, checkpoint?: DesktopInstallCheckpoint): DesktopCurrent {
  const manifest = verifyNativeDesktop(options.artifact), root = privateDesktopDirectory(resolve(options.root));
  const unlock = leaseDesktopProfile(root, "installation");
  try {
  const bootstrapHash = manifest.files.find(file => file.path === "bootstrap.js")!.sha256;
  let installation: DesktopInstallation;
  if (existsSync(join(root, "installation.json"))) {
    installation = desktopInstallation(root);
    if (options.runtime && (desktopExecutable(options.runtime.bun) !== installation.bun || desktopExecutable(options.runtime.browser) !== installation.browser || options.runtime.locale !== installation.locale || options.runtime.service !== undefined && desktopService(options.runtime.service) !== installation.service)) throw new Error("desktop_configuration_changed");
  }
  else {
    if (readdirSync(root).some(name => name !== "installation.lock") || !options.runtime) throw new Error("desktop_installation_not_empty");
    installation = { contract: "s16-desktop-installation/v1", bun: desktopExecutable(options.runtime.bun), browser: desktopExecutable(options.runtime.browser), locale: options.runtime.locale, service: options.runtime.service ? desktopService(options.runtime.service) : null, bootstrapHash };
    if (!["en", "th"].includes(installation.locale)) throw new Error("desktop_installation_invalid");
    writeDesktopRecord(join(root, "installation.json"), installation);
  }
  if (installation.bootstrapHash !== bootstrapHash) throw new Error("desktop_bootstrap_migration_required");
  const releases = privateDesktopDirectory(join(root, "releases")), destination = join(releases, manifest.id);
  if (!existsSync(destination)) {
    if (readdirSync(releases).filter(name => hex.test(name)).length >= nativeDesktopLimits.releases) throw new Error("desktop_release_retention_limit");
    const stage = join(releases, ".staging-" + crypto.randomUUID()); mkdirSync(stage, { mode: 0o700 });
    try {
      cpSync(options.artifact, stage, { recursive: true, dereference: false });
      if (verifyNativeDesktop(stage).id !== manifest.id) throw new Error("desktop_release_copy_invalid");
      syncTree(stage); checkpoint?.("staged"); renameSync(stage, destination); sync(releases);
    } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
  }
  if (verifyNativeDesktop(destination).id !== manifest.id) throw new Error("desktop_release_copy_invalid");
  checkpoint?.("renamed");
  if (!existsSync(join(root, "bootstrap.js"))) writeDesktopFile(join(root, "bootstrap.js"), readFileSync(join(destination, "bootstrap.js")));
  const previous = desktopCurrent(root), current: DesktopCurrent = { contract: "s16-desktop-current/v1", active: manifest.id, previous: previous?.active === manifest.id ? previous.previous : previous?.active ?? null };
  writeDesktopRecord(join(root, "current.json"), current); checkpoint?.("committed");
  return current;
  } finally { unlock(); }
}

/** Explicit local code rollback, verified before pointer replacement. Private profiles and server state are untouched. */
export function rollbackNativeDesktop(root: string): DesktopCurrent {
  const unlock = leaseDesktopProfile(privateDesktopDirectory(root), "installation");
  try {
  const active = activeNativeDesktop(root), current = desktopCurrent(root)!;
  if (!current.previous) throw new Error("desktop_previous_missing");
  const previous = verifyNativeDesktop(join(root, "releases", current.previous));
  if (previous.id !== current.previous || previous.files.find(file => file.path === "bootstrap.js")?.sha256 !== active.installation.bootstrapHash) throw new Error("desktop_previous_invalid");
  const next: DesktopCurrent = { contract: "s16-desktop-current/v1", active: current.previous, previous: current.active }; writeDesktopRecord(join(root, "current.json"), next); return next;
  } finally { unlock(); }
}

/** Records the owner-selected service only after the credential-free connection context has been destroyed. */
export function selectDesktopService(root: string, service: string): void {
  const unlock = leaseDesktopProfile(privateDesktopDirectory(root), "installation");
  try { const installation = desktopInstallation(root); writeDesktopRecord(join(root, "installation.json"), { ...installation, service: desktopService(service) }); }
  finally { unlock(); }
}

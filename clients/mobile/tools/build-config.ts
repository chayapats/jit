import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

/** Public native build selection only. A Google Services client file is never a protected provider/service account. */
export function mobileBuildConfig(environment: Record<string, string | undefined>, snapshotDirectory?: string): { applicationId: string; buildNumber: number; googleServicesFile?: string } {
  const applicationId = environment.JIT_MOBILE_APPLICATION_ID ?? "io.jit.mobile", rawNumber = environment.JIT_MOBILE_BUILD_NUMBER ?? "1";
  if (applicationId.length > 200 || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,9}$/.test(applicationId) || /[\r\n]/.test(applicationId) || !/^[1-9][0-9]{0,9}$/.test(rawNumber) || /[\r\n]/.test(rawNumber) || Number(rawNumber) > 2100000000) throw Error("mobile_build_selection_invalid");
  const selected = { applicationId, buildNumber: Number(rawNumber) }, path = environment.JIT_MOBILE_GOOGLE_SERVICES;
  if (path === undefined) return selected;
  if (!isAbsolute(path) || path.includes("\0")) throw Error("mobile_google_client_config_invalid");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > 65536) throw Error();
    const buffer = Buffer.alloc(65537), count = readSync(fd, buffer, 0, buffer.length, 0); if (count > 65536 || count !== info.size) throw Error();
    const bytes = buffer.subarray(0, count), value = JSON.parse(bytes.toString("utf8"));
    const inspect = (raw: unknown, depth = 0): void => {
      if (depth > 16 || typeof raw === "string" && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw) || ["service_account", "external_account"].includes(raw))) throw Error();
      if (raw && typeof raw === "object") for (const [key, child] of Object.entries(raw)) { if (/credential|access.?token|id.?token|authorization|secret|password|private.?key|refresh.?token|service.?account|token_uri/i.test(key)) throw Error(); inspect(child, depth + 1); }
    };
    inspect(value);
    if (!value || Object.keys(value).some(key => !["project_info", "client", "configuration_version"].includes(key)) || typeof value.project_info?.project_id !== "string" || !Array.isArray(value.client) || !value.client.length || value.client.length > 32 || value.client.filter((client: Record<string, any>) => client.client_info?.android_client_info?.package_name === applicationId && typeof client.client_info?.mobilesdk_app_id === "string" && Array.isArray(client.api_key) && client.api_key.length > 0 && client.api_key.every((key: Record<string, unknown>) => typeof key.current_key === "string" && key.current_key.length === 39 && key.current_key.startsWith("AIza") && !/[^A-Za-z0-9_-]/.test(key.current_key))).length !== 1) throw Error();
    if (!snapshotDirectory || !isAbsolute(snapshotDirectory)) throw Error();
    mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    const target = join(snapshotDirectory, createHash("sha256").update(bytes).digest("hex") + ".json");
    let snapshot: number | undefined;
    try { snapshot = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(snapshot, bytes); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      snapshot = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW); const current = fstatSync(snapshot);
      if (!current.isFile() || current.nlink !== 1 || current.size !== bytes.length || !readFileSync(snapshot).equals(bytes)) throw Error();
    } finally { if (snapshot !== undefined) closeSync(snapshot); }
    return { ...selected, googleServicesFile: target };
  } catch { throw Error("mobile_google_client_config_invalid"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

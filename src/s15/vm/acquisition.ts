import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { vmPublicAddress } from "./proxy";
import { vmFail, vmHash, vmInteger } from "./validation";

/** Exact public artifact request approved by the protected policy; no private bytes, redirects or credentials are sent. */
export interface VmArtifactRequest { url: string; sha256: string; maxBytes: number }
/** Protected I/O seams for deterministic deadline/DNS tests; no guest-provided resolver or timer is accepted. */
export interface VmArtifactOptions {
  /** Protected original-claim fence before DNS and immediately before the actual HTTPS request. */
  beforeRequest?: () => void;
  resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  deadline?: (milliseconds: number, expire: () => void) => () => void;
  request?: typeof request;
}
/** Protected bounded single-GET download with DNS pinned after public-address verification and normal TLS verification. */
export async function fetchVmArtifact(input: VmArtifactRequest, signal?: AbortSignal, options: VmArtifactOptions = {}): Promise<Uint8Array> {
  input = { url: input.url, sha256: input.sha256, maxBytes: input.maxBytes };
  let url: URL; try { url = new URL(input.url); } catch { vmFail("vm_acquisition_invalid", 400); }
  vmInteger(input.maxBytes, 8_388_608);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" || input.url.length > 8192 || !/^[a-f0-9]{64}$/.test(input.sha256)) vmFail("vm_acquisition_invalid", 400);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController(); let expired = false;
  const abortError = () => expired ? new Error("vm_acquisition_timeout") : new DOMException("Aborted", "AbortError");
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  const stopped = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(abortError()), { once: true }));
  const clearDeadline = (options.deadline ?? ((ms, expire) => { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); }))(30000, () => { expired = true; controller.abort(); });
  try {
    if (signal?.aborted) abort();
    options.beforeRequest?.();
    const addresses = await Promise.race([(options.resolve ?? (host => lookup(host, { all: true })))(url.hostname), stopped]);
    if (controller.signal.aborted) throw abortError();
    if (!addresses.length || addresses.some(a => !vmPublicAddress(a.address))) vmFail("vm_destination_denied", 403);
    return await Promise.race([new Promise<Uint8Array>((resolve, reject) => {
    const address = addresses[0]!, chunks: Uint8Array[] = []; let total = 0;
    options.beforeRequest?.();
    const req = (options.request ?? request)(url, { method: "GET", agent: false, headers: { "Accept-Encoding": "identity", "User-Agent": "Jit-artifact/1" },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family), signal: controller.signal }, response => {
      if (response.statusCode !== 200 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); req.destroy(); reject(new Error("vm_acquisition_failed")); return; }
      response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > input.maxBytes) { response.destroy(); req.destroy(); reject(new Error("vm_output_limit")); } else chunks.push(chunk); });
      response.on("error", () => reject(new Error("vm_acquisition_failed")));
      response.on("end", () => { const bytes = Buffer.concat(chunks); if (vmHash(bytes) !== input.sha256) reject(new Error("vm_artifact_hash_mismatch")); else resolve(bytes); });
    });
    req.on("error", () => reject(controller.signal.aborted ? abortError() : new Error("vm_acquisition_failed"))); req.end();
    }), stopped]);
  } finally { clearDeadline(); signal?.removeEventListener("abort", abort); }
}

import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { vmPublicAddress } from "./proxy";
import { vmFail, vmHash, vmInteger } from "./validation";

/** Exact public artifact request approved by the protected policy; no private bytes, redirects or credentials are sent. */
export interface VmArtifactRequest { url: string; sha256: string; maxBytes: number }
/** Protected bounded single-GET download with DNS pinned after public-address verification and normal TLS verification. */
export async function fetchVmArtifact(input: VmArtifactRequest, signal?: AbortSignal): Promise<Uint8Array> {
  let url: URL; try { url = new URL(input.url); } catch { vmFail("vm_acquisition_invalid", 400); }
  vmInteger(input.maxBytes, 8_388_608);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" || input.url.length > 8192 || !/^[a-f0-9]{64}$/.test(input.sha256)) vmFail("vm_acquisition_invalid", 400);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !vmPublicAddress(a.address))) vmFail("vm_destination_denied", 403);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const address = addresses[0]!, chunks: Uint8Array[] = []; let total = 0;
    const req = request(url, { method: "GET", agent: false, headers: { "Accept-Encoding": "identity", "User-Agent": "Jit-artifact/1" },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family), ...(signal ? { signal } : {}) }, response => {
      if (response.statusCode !== 200 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); req.destroy(); reject(new Error("vm_acquisition_failed")); return; }
      response.on("data", (chunk: Buffer) => { total += chunk.length; if (total > input.maxBytes) { response.destroy(); req.destroy(); reject(new Error("vm_output_limit")); } else chunks.push(chunk); });
      response.on("error", () => reject(new Error("vm_acquisition_failed")));
      response.on("end", () => { const bytes = Buffer.concat(chunks); if (vmHash(bytes) !== input.sha256) reject(new Error("vm_artifact_hash_mismatch")); else resolve(bytes); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("vm_acquisition_timeout")); }, 30000);
    req.on("error", () => reject(new Error("vm_acquisition_failed"))); req.on("close", () => clearTimeout(timer)); req.end();
  });
}

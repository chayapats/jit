import { AppError } from "../errors";

/** Resolves explicit self-hosted HTTPS reverse-proxy or same-device loopback service binding without exposing a public HTTP listener. */
export function personalServiceBinding(origin: string): { hostname: string; port: number; proxy: boolean } {
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || url.protocol === "http:" && loopback) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new AppError("s14_https_or_loopback_origin_required");
  return url.protocol === "https:" ? { hostname: "127.0.0.1", port: 3001, proxy: true }
    : { hostname: url.hostname === "[::1]" ? "::1" : url.hostname, port: Number(url.port || 80), proxy: false };
}

/** Reconstructs the configured HTTPS URL only at the trusted loopback proxy boundary, requiring its exact external Host. */
export function personalProxyRequest(request: Request, origin: string): Request {
  const configured = new URL(origin);
  if (request.headers.get("host") !== configured.host) throw new AppError("host_rejected", 403);
  const incoming = new URL(request.url);
  return new Request(new URL(incoming.pathname + incoming.search, configured), request);
}

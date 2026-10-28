import type { Application } from "../application";
import { AppError } from "../errors";
import { FixedWindowRate, browserRequest, readCappedBody } from "../security/inbound";
import { webhookLimits, webhookRouteId, type WebhookLimits } from "./webhooks";

export interface WebhookHandlerOptions {
  limits?: WebhookLimits;
  /** Clock of the rate windows; the dedupe window uses the Application clock. */
  now?: () => number;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });

/**
 * app.webhook_triggers/v1 request pipeline for `POST /hooks/pr/<routeId>` on the Web listener (behind the VPN; the
 * Web handler's `Host` check runs first). Each check stops the request before the next one, and none writes state:
 *
 * 1. method `POST` → else 405; a browser request (`Origin` or `Sec-Fetch-Site`) → 403 `origin_rejected`;
 * 2. an unknown or deleted route id → 404 `not_found` (unknown ids open no rate window);
 * 3. a body over 32 KiB → 413 `request_too_large`;
 * 4. over the per-route rate → 429 `rate_limited` with `Retry-After`;
 * 5. {@link Application.acceptWebhook}: signature → 401, delivery id → 400, paused or revoked monitor → 409,
 *    duplicate delivery id → 409; otherwise the poll is moved earlier → 202 `{ outcome: "poll_scheduled" }`.
 *
 * The body is only hashed for the signature. It is never parsed, logged, stored or echoed.
 */
export function createWebhookHandler(app: Application, options: WebhookHandlerOptions = {}): (request: Request, routeId: string) => Promise<Response> {
  const limits = options.limits ?? webhookLimits;
  const rate = new FixedWindowRate(limits, options.now ?? Date.now);
  return async (request, routeId) => {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    if (browserRequest(request)) return json({ error: "origin_rejected" }, 403);
    try {
      if (!webhookRouteId.test(routeId) || !app.webhookRouteActive(routeId)) return json({ error: "not_found" }, 404);
      const body = await readCappedBody(request, limits.bodyBytes);
      if (body === null) return json({ error: "request_too_large" }, 413);
      const admitted = rate.admit(routeId);
      if (!admitted.ok) return json({ error: "rate_limited" }, 429, { "Retry-After": String(admitted.retryAfterSeconds) });
      const deliveryId = request.headers.get("x-github-delivery") ?? request.headers.get("x-jit-delivery") ?? "";
      app.acceptWebhook({ routeId, deliveryId, signature: request.headers.get("x-hub-signature-256"), body });
      return json({ outcome: "poll_scheduled" }, 202);
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.code }, error.status);
      return json({ error: "request_failed" }, 500);
    }
  };
}

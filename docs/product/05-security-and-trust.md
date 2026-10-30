# Jit Security and Trust

Target: [S14](../specs/S14-bot-first-local-assistant.md). Current runtime retains its legacy behavior until replacement tickets land. Security invariants below are requirements, not claims of tested implementation.

## Principals and authority

The installation owner configures capabilities, work/routine grants, sharing, connections and exact external actions. Bots, model output, sources, memory, repository files, email, attachments and webhook payloads cannot expand authority.

Authenticate each command and derive actor identity server-side. A typed explicit work.start can authorize internal work immediately within configured limits; task.accept and message.post cannot become execution grants because a model classified their text. Addressing a Bot is routing only.

Every admission/tool/effect/publication rechecks current owner/Bot/grant/resource/share/attempt generations. Revocation fences future access/results, not a claim to erase information already seen.

## Execution and session boundaries

Separate Bot computers, volumes/private memory and protected browser profiles by enforceable boundaries. No host home, runtime/control socket, service state/database/backup or provider/channel/vault credential enters a workspace shell/MCP container.

Website login material remains only in the protected Bot-private browser component. Login through takeover does not authorize sharing its profile or reading its tokens. Screenshot masking alone does not establish credential secrecy.

One input lease controls a browser/desktop. Owner takeover refuses agent input; handing it back does not release a pending effect. No host-shell or alternate tool path may bypass the gateway.

Unrestricted internet shell/arbitrary browser code and claims of complete effect mediation are incompatible. Enforce egress/broker paths and keep unsupported actions unavailable. Unknown MCP/action classifications ask or refuse; readOnlyHint and model-declared intent are not security proofs.

## External services and secrets

Local execution still sends relevant input to selected inference, public queries/URLs to Parallel and data to enabled delivery/connectors. No default telemetry. Do not forward full private context or credentials to research services.

Parallel anonymous/free is explicit; authenticated billing is an owner decision. Rate limit/failure never silently changes provider/model/account/billing. Document vendor copies/retention as outside local deletion guarantees.

Connections are write-only and scoped to trusted service brokers. Never prompt/log/export secret values. Do not import credentials from another CLI or make Jit own provider renewal protocols.

## Effects and recovery

Exact-action approvals bind destination/content/revision/hash/expiry and are used once. A crash after dispatch can be unknown even when the local receipt exists. Use trusted read-back/idempotency where supported; otherwise wait for owner resolution, never blind retry.

System-owned handlers classify replay safety. Resume only with current unchanged scope/input/config/route and remaining budget after native discovery/reconciliation. Unknown usage remains unknown; uncertain reservations are not refunded. Cancelling a call does not prove it stopped.

## Memory, evidence and artifacts

Filter access before relevance. Shared facts require owner approval/authorization; extraction cannot promote private memory. Keep fact/inference/source conflicts and provenance explicit.

Validate citation-to-evidence binding and artifact ID/path/type/size/hash. Render sanitized untrusted content, not raw executable HTML. Correct/forget/delete propagates to descendants, contexts, artifacts, caches and restore ledger. Reports/artifacts/browser frames are private, no-store and absent from PWA data cache.

## Verification and residual risk

Fixtures prove command/fence/state logic with scripted models, fake clocks and protocol barriers. Actual Linux container/network/profile enforcement, logged-in site behavior, provider renewal/quotas, device rendering and accessibility need separately labelled opt-in evidence.

A compromised host/kernel/administrator, provider-held copies, previously disclosed knowledge and arbitrary website semantics remain residuals. Do not describe a container, approval UI or read-only tool as complete protection.

import { hostCapabilities } from "schway/host";
import { DeviceSignIns, type SignInOptions, type SignInReceipt, type SignInView } from "../device-sign-in";
import { AppError } from "../errors";
import { noRouteModels, recommendedModel } from "../team/route-options";
import type { S14Application } from "./application";
import type { Envelope, OwnerActor, Route } from "./types";
import { canonical, digest, exact, identity, integer } from "./validation";

/** Web-only device commands reserve one durable receipt before touching provider protocols. */
export type S14SignInCommand = Envelope<"setup.sign_in" | "setup.sign_in.cancel", { provider: "codex" | "grok"; flowId: string | null }>;
/** Web result carries approval only once; its durable projection excludes approval data and native handles. */
export interface S14SignInReceipt extends SignInReceipt { kind: S14SignInCommand["kind"]; requestId: string; provider: "codex" | "grok"; signIn: SignInView & { /** Owner-only cancellation target; never approval data. */ currentFlowId?: string } }

/** Derives exact recommended routes from the supported public host without probing or changing billing. */
export function supportedS14Routes(): Route[] {
  const host = hostCapabilities();
  if (host.authContract !== "schway.host.auth-routes/v1" || host.deviceSignInContract !== "schway.host.device-sign-in/v1") throw new AppError("unsupported_schway_auth");
  return host.authRoutes.map(provider => ({ id: provider, provider, model: recommendedModel(provider, noRouteModels) }));
}

/** Owns process-local device protocols; HTTP alone calls execute after session, Host, Origin and CSRF validation. */
export class S14SignIns {
  readonly flows: DeviceSignIns;
  constructor(readonly app: S14Application, options?: SignInOptions) { this.flows = new DeviceSignIns(options); }
  /** Reads native local readiness without inference; configuration never proves a working subscription. */
  async providers(actor: OwnerActor) {
    this.app.store.read(tx => this.app.requireOwner(tx, actor));
    const models = { ...noRouteModels };
    for (const route of this.app.policy.routes) models[route.provider] = route.model;
    const readiness = await this.flows.readiness(models);
    this.app.store.read(tx => this.app.requireOwner(tx, actor));
    return this.app.policy.routes.map(route => ({ ...route, readiness: readiness[route.provider] }));
  }
  /** Reads receipt-owned safe status; a restart cancels pending flows without reconstructing approval data. */
  status(actor: OwnerActor, provider: "codex" | "grok", flowId: string): S14SignInReceipt["signIn"] {
    identity(flowId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const row = tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", flowId);
      const receipt = row ? JSON.parse(row.result_json) as S14SignInReceipt : null;
      if (!receipt || receipt.kind !== "setup.sign_in" || receipt.provider !== provider) throw new AppError("not_found", 404);
      return ["starting", "pending"].includes(receipt.signIn.state) ? this.flows.read(provider, flowId) : receipt.signIn;
    });
  }
  /** Reserves, audits and replays a Web command once, fencing every credential write with the live initiating session. */
  async execute(actor: OwnerActor, c: S14SignInCommand): Promise<S14SignInReceipt> {
    exact(c, ["kind", "requestId", "expectedRevision", "payload"]);
    identity(c.requestId);
    integer(c.expectedRevision);
    exact(c.payload, ["provider", "flowId"]);
    if (!["setup.sign_in", "setup.sign_in.cancel"].includes(c.kind) || !supportedS14Routes().some(r => r.provider === c.payload.provider)) throw new AppError("invalid_sign_in");
    if (c.kind === "setup.sign_in" ? c.payload.flowId !== null : typeof c.payload.flowId !== "string") throw new AppError("invalid_sign_in");
    const hash = digest(canonical(c));
    const previous = this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor);
      if (tx.get("SELECT request_id FROM computer_inputs WHERE request_id=?", c.requestId)) throw new AppError("request_id_conflict", 409);
      const row = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash,result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", c.requestId);
      if (row) {
        if (row.payload_hash !== hash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(row.result_json) as S14SignInReceipt;
      }
      const installation = tx.get<{ revision: number }>("SELECT revision FROM installation")!;
      if (installation.revision !== c.expectedRevision) throw new AppError("stale_revision", 409);
      if (c.kind === "setup.sign_in.cancel") this.status(actor, c.payload.provider, c.payload.flowId!);
      const receipt: S14SignInReceipt = { kind: c.kind, requestId: c.requestId, provider: c.payload.provider,
        signIn: { id: c.payload.flowId ?? c.requestId, state: "starting", expiresAt: null } };
      tx.run("INSERT INTO command_receipts VALUES ('owner',?,?,?,?)", c.requestId, hash, canonical(receipt), this.app.now());
      tx.run("INSERT INTO audit(kind,request_id,committed_at) VALUES (?,?,?)", c.kind, c.requestId, this.app.now());
      tx.run("UPDATE installation SET revision=revision+1");
      this.app.options.beforeCommit?.();
      return null;
    });
    if (previous) return { ...previous, signIn: this.status(actor, c.payload.provider, previous.signIn.id) };
    const changed = (signIn: S14SignInReceipt["signIn"]) => this.app.store.transaction(tx => {
      const row = tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE request_id=?", c.requestId)!;
      const receipt = JSON.parse(row.result_json) as S14SignInReceipt;
      if (!["starting", "pending"].includes(receipt.signIn.state) && ["starting", "pending"].includes(signIn.state)) return;
      receipt.signIn = signIn;
      tx.run("UPDATE command_receipts SET result_json=? WHERE request_id=?", canonical(receipt), c.requestId);
    });
    const result = c.kind === "setup.sign_in.cancel"
      ? { signIn: this.flows.cancel(c.payload.provider, c.payload.flowId!) }
      : await this.flows.start(c.payload.provider, c.requestId, () => this.app.store.read(tx => this.app.requireOwner(tx, actor)), changed, () => {});
    if (result.signIn.state === "busy") {
      this.app.store.read(tx => this.app.requireOwner(tx, actor));
      const current = this.flows.current(c.payload.provider);
      if (current) (result.signIn as S14SignInReceipt["signIn"]).currentFlowId = current.id;
    }
    changed(result.signIn);
    return { kind: c.kind, requestId: c.requestId, provider: c.payload.provider, ...result };
  }
  /** Cancels and awaits native credential cleanup before the application store closes. */
  close(): Promise<void> { return this.flows.close(); }
}

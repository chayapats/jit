import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHost } from "schway/host";
import { AppError } from "../errors";
import { S14Application, type S14Options } from "./application";
import { S14Store } from "./store";
import { nativeIntentPaths } from "./native-recovery";
import { S14Maintenance } from "./ops";
import { opsAtomic, opsDirectory } from "./ops-files";
import { schwayOpsNative } from "./ops-native";
import { opsHash } from "./ops-image";
import { s14CredentialLifecycle } from "./lifecycle";
import type { OpsCommand } from "./ops-types";

/** Runs the explicit Linux x64/arm64 local-storage drill without any provider, network, paid call or existing installation. */
export async function runS14OpsRoundTrip(): Promise<void> {
  if (process.env.JIT_S14_OPS_ROUNDTRIP !== "1" || process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new AppError("s14_ops_linux_roundtrip_opt_in_required");
  const parent = resolve(".local/evidence");
  opsDirectory(parent);
  const root = mkdtempSync(join(parent, `s14-ops-${process.arch}-`));
  const path = join(root, "application.sqlite"), nativeRoot = join(root, "native");
  const options: S14Options = {
    policy: { routes: [{ id: "fixture", provider: "codex", model: "local-storage-fixture" }], tools: [], resources: [] },
    chat: { async reply() { throw new AppError("roundtrip_no_inference"); } },
  };
  let store = new S14Store(path), app = new S14Application(store, options);
  let maintenance: S14Maintenance | undefined;
  const password = randomBytes(24).toString("hex");
  const id = () => crypto.randomUUID().replaceAll("-", "");
  try {
    await app.provisionOwner(password);
    const token = await app.login(password);
    let actor = app.authenticate(token).actor;
    const setup = app.execute(actor, { kind: "setup", requestId: id(), expectedRevision: 0, payload: { ownerName: "Local durability fixture", language: "en", routeId: "fixture", capabilities: { tools: [], resources: [] } } });
    const conversationId = setup.conversation!.id;
    const work = app.execute(actor, { kind: "work.start", requestId: id(), expectedRevision: app.conversation(actor, conversationId).conversation.revision, payload: { conversationId, task: null, title: "Local evidence", purpose: "Record storage evidence", completionRule: "Inspect round trip", bots: [{ id: "jit", revision: 1 }], tools: [], scopes: [], limits: { attempts: 2, steps: 2, calls: 4, outputBytes: 32768, wallMs: 60000, concurrency: 1, reads: 0 }, expiresAt: Date.now() + 60000 } });
    const attempt = app.authority.admit(work.work!.id, id(), { botId: "jit", tools: [], scopes: [], input: "Local bytes only", calls: 2, outputBytes: 16384 });
    app.authority.commit(attempt.id, { state: "ready", text: "Local report", report: { title: "Round-trip evidence", claims: [{ id: "fixture", text: "Local fixture inference", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["No live source or provider verification"], artifactIds: [] } });
    const report = app.reports.list(actor, work.work!.id)[0]!;
    if (report.state !== "available") throw new AppError("s14_ops_drill_report_missing");
    const artifacts = report.artifacts.map(file => ({ id: file.id, hash: opsHash(app.artifacts.download(actor, file.id).bytes) }));
    const claim = app.execute(actor, { kind: "memory.remember", requestId: id(), expectedRevision: app.conversation(actor, conversationId).conversation.revision, payload: { conversationId, text: "Withdraw this fixture after backup" } }).claim!;
    const packet = store.transaction(tx => app.memory.assemble(tx, { botId: "jit", conversationId, purpose: "Withdrawn native scope", sources: [store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id=?", claim.id)!.record_json).source)] }));
    const intent = app.recovery.intent(null, packet.id, options.policy.routes[0]!);
    const host = await createHost({ ...nativeIntentPaths(nativeRoot, intent), context: { policy: "strict", systemPrompt: "Local storage fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } });
    const session = await host.createSession();
    app.recovery.correlate(intent.id, session.reference);
    await session.retire(); await session.close(); await host.close(); app.recovery.retired(intent.id);
    store.close();
    maintenance = new S14Maintenance(path, options, schwayOpsNative(nativeRoot));
    actor = maintenance.app.authenticate(token).actor;
    const command = (kind: OpsCommand["kind"], payload: object): OpsCommand => ({ kind, requestId: id(), expectedRevision: maintenance!.control.revision, payload } as OpsCommand);
    const backup = await maintenance.execute(actor, command("backup.create", {}));
    maintenance.close(); maintenance = undefined;
    store = new S14Store(path); app = new S14Application(store, options); actor = app.authenticate(token).actor;
    app.execute(actor, { kind: "memory.delete", requestId: id(), expectedRevision: claim.revision, payload: { claim } });
    store.close();
    maintenance = new S14Maintenance(path, options, schwayOpsNative(nativeRoot)); actor = maintenance.app.authenticate(token).actor;
    const stage = await maintenance.execute(actor, command("restore.prepare", { backupId: backup.backupId }));
    if (stage.state !== "validated") throw new AppError("s14_ops_drill_validation_failed");
    await maintenance.execute(actor, command("restore.activate", { stageId: stage.stage!.id, actionHash: stage.stage!.actionHash }));
    actor = maintenance.app.authenticate(await maintenance.app.login(password)).actor;
    if (!maintenance.app.authority.view(actor, work.work!.id).authority?.revoked) throw new AppError("s14_ops_drill_authority_resurrected");
    const deleted = maintenance.store.read(tx => !tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id=?", claim.id)!.record_json.includes("Withdraw this fixture"));
    const nativeDeleted = maintenance.app.recovery.view(actor).native.find(i => i.id === intent.id)?.state === "deleted";
    // This earlier report did not receive the subsequently created withdrawn source.
    const artifactResults = artifacts.map(file => {
      try { return { id: file.id, outcome: opsHash(maintenance!.app.artifacts.download(actor, file.id).bytes) === file.hash ? "preserved" : "mismatch" }; }
      catch { return { id: file.id, outcome: "withdrawn_by_lineage" }; }
    });
    if (!deleted || !nativeDeleted || artifactResults.some(file => file.outcome !== "preserved")) throw new AppError("s14_ops_drill_reconciliation_failed");
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    const evidence = { contract: "app.restore-activation/v1", platform: process.platform, architecture: process.arch, revision, state: "complete", applicationDeletion: deleted, nativeDeletion: nativeDeleted, artifacts: artifactResults, workerReplay: "none", credentialExport: "excluded", liveProviderCalls: 0, powerLossEvidence: "pending", uiAcceptance: "pending" };
    opsAtomic(join(root, "roundtrip-evidence.json"), evidence);
    console.log(JSON.stringify(evidence));
  } finally {
    maintenance?.close(); store.close(); await s14CredentialLifecycle().close();
  }
}

if (import.meta.main) {
  try { await runS14OpsRoundTrip(); }
  catch (error) { console.error(JSON.stringify({ error: error instanceof AppError ? error.code : "s14_ops_roundtrip_failed" })); process.exitCode = 1; }
}

import type { SearchProvider, ToolDefinition, ToolExecutionResult } from "schway/host";
import { hostCapabilities } from "schway/host";
import { AppError } from "../errors";
import { ConnectionVault, normalizeSecret } from "../exec/connections";
import { buildOutboundCorpus, findVerbatimSpan } from "../security/outbound-guard";
import { registerSecretFingerprint } from "../security/secret-fingerprints";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import { record, save } from "./application";
import type { Attempt, Work } from "./authority-types";
import type { MemoryPacket, MemorySource } from "./memory-types";
import { ParallelFailure, ParallelMcp, publicOutbound, type ParallelTimer, type ParallelTransport } from "./parallel-protocol";
import type { ExternalEvidence, ParallelCommand, ParallelConnection, ParallelReceipt, ParallelSetting, WebOutcome, WebRead } from "./parallel-types";
import type { OwnerActor } from "./types";
import { canonical, exact, identity, integer } from "./validation";

/** Trusted optional service dependencies; no tool input can replace the transport, vault, timer or limits. */
export interface ParallelWebOptions { transport?: ParallelTransport; vault?: ConnectionVault; timer?: ParallelTimer; deadlineMs?: number; responseBytes?: number }
const id = () => crypto.randomUUID().replaceAll("-", "");
const frame = (value: unknown) => `<untrusted_data>\n${JSON.stringify(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</untrusted_data>`;
const defaultTimer: ParallelTimer = (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); };

/** Service-owned Parallel gateway; authority, outbound policy and actual evidence are checked before publication. */
export class ParallelWeb {
  constructor(readonly app: S14Application, readonly options: ParallelWebOptions = {}) {
    integer(options.deadlineMs ?? 15000, 1, 15000);
    integer(options.responseBytes ?? 262144, 1024, 262144);
    this.app.store.read(tx => {
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM parallel_connections")) {
        const connection = JSON.parse(row.record_json) as ParallelConnection;
        if (connection.state === "set" && options.vault) {
          try { registerSecretFingerprint(options.vault.read(connection.id)); } catch { /* Missing/unsafe keys remain unavailable, never anonymous fallback. */ }
        }
      }
    });
  }

  /** Reads configured mode and optional key metadata offline; configuration never claims live readiness. */
  settings(actor: OwnerActor): { setting: ParallelSetting; connections: ParallelConnection[]; readiness: "configured_unverified"; keyState: "not_required" | "present" | "missing" | "unsafe" } {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const setting = record<ParallelSetting>(tx, "parallel_settings", "parallel");
      return { setting, connections: tx.all<{ record_json: string }>("SELECT record_json FROM parallel_connections ORDER BY rowid").map(r => JSON.parse(r.record_json)), readiness: "configured_unverified",
        keyState: setting.mode === "anonymous" ? "not_required" : setting.connectionId && this.options.vault ? this.options.vault.inspect(setting.connectionId) : "missing" };
    });
  }

  /** Applies exact owner settings/key commands without persisting, returning or hashing a credential value. */
  apply(tx: AppTransaction, command: ParallelCommand): ParallelReceipt {
    const receipt: ParallelReceipt = { kind: command.kind, requestId: command.requestId };
    if (command.kind === "web.parallel.key.set") {
      exact(command.payload, ["secret"]);
      if (command.expectedRevision !== 0) throw new AppError("stale_revision", 409);
      if (!this.options.vault) throw new AppError("parallel_vault_unavailable", 503);
      const secret = normalizeSecret(command.payload.secret);
      if (/\s|[\u0000-\u001f\u007f]/.test(secret)) throw new AppError("invalid_connection_secret");
      registerSecretFingerprint(secret);
      const connection: ParallelConnection = { id: crypto.randomUUID(), revision: 1, state: "set" };
      this.options.vault.write(connection.id, secret);
      tx.run("INSERT INTO parallel_connections VALUES (?,?)", connection.id, canonical(connection));
      return { ...receipt, connection };
    }
    if (command.kind === "web.parallel.key.remove") {
      exact(command.payload, ["connectionId"]); identity(command.payload.connectionId);
      const connection = record<ParallelConnection>(tx, "parallel_connections", command.payload.connectionId);
      if (connection.revision !== command.expectedRevision || connection.state !== "set") throw new AppError("stale_revision", 409);
      if (!this.options.vault) throw new AppError("parallel_vault_unavailable", 503);
      this.options.vault.remove(connection.id);
      connection.state = "removed"; connection.revision++;
      save(tx, "parallel_connections", connection);
      return { ...receipt, connection };
    }
    if (command.kind !== "web.parallel.configure") throw new AppError("unknown_command");
    const p = command.payload;
    exact(p, ["mode", "connectionId", "billingAcknowledged"]);
    const setting = record<ParallelSetting>(tx, "parallel_settings", "parallel");
    if (setting.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    if (p.mode !== "anonymous" && p.mode !== "authenticated") throw new AppError("invalid_parallel_mode");
    if (p.mode === "anonymous") {
      if (p.connectionId !== null || p.billingAcknowledged !== false) throw new AppError("invalid_parallel_anonymous");
    } else {
      identity(p.connectionId);
      const connection = record<ParallelConnection>(tx, "parallel_connections", p.connectionId);
      if (p.billingAcknowledged !== true) throw new AppError("parallel_billing_acknowledgement_required", 403);
      if (connection.state !== "set" || !this.options.vault || this.options.vault.inspect(connection.id) !== "present") throw new AppError("parallel_key_unavailable", 503);
    }
    Object.assign(setting, p); setting.revision++;
    save(tx, "parallel_settings", setting);
    return { ...receipt, setting };
  }

  private check(tx: AppTransaction, attemptId: string, tool: string, setting?: ParallelSetting): Attempt {
    const attempt = this.app.authority.guard(tx, attemptId, tool);
    if (setting && record<ParallelSetting>(tx, "parallel_settings", "parallel").revision !== setting.revision) throw new ParallelFailure("authority_changed");
    if (setting?.mode === "authenticated") {
      const connection = record<ParallelConnection>(tx, "parallel_connections", setting.connectionId!);
      if (connection.state !== "set") throw new ParallelFailure("key_unavailable");
    }
    return attempt;
  }

  private guardOutbound(tx: AppTransaction, attempt: Attempt, subject: string, isUrl: boolean): void {
    publicOutbound(subject, isUrl);
    const packet = this.app.memory.attemptPacket(tx, attempt.id);
    const entries = tx.all<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE bot_id=?", attempt.snapshot.bot.id)
      .map(row => JSON.parse(row.record_json) as MemorySource).filter(s => s.attribution !== "external" && s.text !== null).map(s => ({ text: s.text! }));
    entries.push(
      { text: attempt.snapshot.input },
      { text: attempt.snapshot.bot.responsibility },
      { text: JSON.stringify(attempt.snapshot.bot) },
      { text: JSON.stringify(packet) },
      ...packet.claims.flatMap(claim => [{ text: claim.text }, { text: claim.quote }]),
      ...packet.decisions.map(decision => ({ text: decision.text })),
    );
    if (entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0) > 2097152 || findVerbatimSpan(buildOutboundCorpus(entries), subject)) throw new ParallelFailure("private_context");
  }

  /** Performs one grant-budgeted read; every preflight/protocol/late-result failure becomes an inspectable safe outcome. */
  async read(attemptId: string, tool: "web_search" | "web_fetch", input: unknown, signal = new AbortController().signal): Promise<WebRead> {
    if (tool !== "web_search" && tool !== "web_fetch") throw new AppError("tool_outside_grant", 403);
    canonical(input);
    const attempt = this.app.store.read(tx => this.check(tx, attemptId, tool));
    const setting = this.app.store.read(tx => record<ParallelSetting>(tx, "parallel_settings", "parallel"));
    const row: WebRead = { id: id(), attemptId, workId: attempt.workId, botId: attempt.snapshot.bot.id, tool, subject: "[refused input]", dispatched: false, requestedAt: this.app.now(), finishedAt: null,
      outcome: "running", mode: setting.mode, settingRevision: setting.revision, evidence: [], missing: [], failures: [], usage: null, omittedResults: 0, remoteRequests: 0, reason: null };
    // Reserve before accepting an input; refusals spend a call and cannot be retried outside the finite grant.
    this.app.authority.reserveTool(attemptId, tool);
    this.app.store.transaction(tx => tx.run("INSERT INTO web_reads VALUES (?,?,?)", row.id, attempt.id, canonical(row)));
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) abort.abort();
    const clear = (this.options.timer ?? defaultTimer)(() => { timedOut = true; abort.abort(); }, Math.min(this.options.deadlineMs ?? 15000, Math.max(1, attempt.snapshot.grant.expiresAt - this.app.now())));
    let client: ParallelMcp | null = null;
    try {
      const p = input as Record<string, unknown>;
      exact(p, tool === "web_search" ? ["query"] : ["url", "fullContent"]);
      const subject = p[tool === "web_search" ? "query" : "url"];
      if (typeof subject !== "string" || !subject.trim() || !subject.isWellFormed() || Buffer.byteLength(subject) > 8192 || /[\u0000-\u001f\u007f]/.test(subject) || tool === "web_fetch" && typeof p.fullContent !== "boolean") throw new ParallelFailure("blocked");
      if (abort.signal.aborted) throw new ParallelFailure(timedOut ? "deadline" : "cancelled");
      this.app.store.read(tx => this.guardOutbound(tx, attempt, subject, tool === "web_fetch"));
      row.subject = subject;
      let secret: string | null = null;
      if (setting.mode === "authenticated") {
        this.app.store.read(tx => this.check(tx, attemptId, tool, setting));
        if (!this.options.vault || !setting.connectionId || this.options.vault.inspect(setting.connectionId) !== "present") throw new ParallelFailure("key_unavailable");
        secret = this.options.vault.read(setting.connectionId);
        registerSecretFingerprint(secret);
        // Fingerprints are active before any text can leave using this credential.
        this.app.store.read(tx => this.guardOutbound(tx, attempt, subject, tool === "web_fetch"));
      }
      const work = this.app.store.read(tx => record<Work>(tx, "work_items", attempt.workId));
      const sessionId = this.app.store.read(tx => tx.get<{ vendor_id: string }>("SELECT vendor_id FROM parallel_sessions WHERE conversation_id=?", work.conversationId)?.vendor_id ?? null);
      client = new ParallelMcp({ mode: setting.mode, secret, sessionId, model: attempt.snapshot.route.model,
        ...(this.options.transport ? { transport: this.options.transport } : {}), maxBytes: this.options.responseBytes ?? 262144,
        beforeRequest: method => {
          if (abort.signal.aborted) throw new ParallelFailure(timedOut ? "deadline" : "cancelled");
          this.app.store.transaction(tx => {
            this.check(tx, attemptId, tool, setting);
            this.guardOutbound(tx, attempt, subject, tool === "web_fetch");
            row.remoteRequests = client!.requests + 1;
            if (method === "tools/call") row.dispatched = true;
            save(tx, "web_reads", row);
          });
        } });
      let result;
      if (tool === "web_search") {
        const provider: SearchProvider = client;
        await provider.search(subject, { limit: 5, signal: abort.signal });
        result = client.last!;
      } else result = await client.call(tool, { url: subject, fullContent: p.fullContent as boolean }, abort.signal);
      if (abort.signal.aborted) throw new ParallelFailure(timedOut ? "deadline" : "cancelled");
      row.usage = result.usage;
      row.omittedResults = result.omittedResults;
      row.missing = result.missing;
      row.failures = result.failures;
      row.evidence = result.evidence.map(e => ({ ...e, id: id(), revision: 1, generation: 1, workId: attempt.workId, attemptId, botId: attempt.snapshot.bot.id,
        tool, provider: "parallel", mode: setting.mode, retrievedAt: this.app.now() }));
      row.outcome = result.partial ? "partial" : "success";
      if (tool === "web_fetch" && !row.evidence.length && row.failures.some(f => f.status === 403 || f.status === 451)) row.outcome = "blocked";
      row.finishedAt = this.app.now(); row.remoteRequests = client.requests;
      if (Buffer.byteLength(frame(row)) > Math.min(32768, attempt.snapshot.outputBytes)) throw new ParallelFailure("oversize");
      this.app.store.transaction(tx => {
        this.check(tx, attemptId, tool, setting);
        const packet = this.app.memory.attemptPacket(tx, attemptId);
        if (packet.sources.length + row.evidence.length > 64) throw new ParallelFailure("oversize");
        const derived = [...packet.sources, ...packet.claims.map(c => c.source), ...packet.decisions.map(d => d.source)];
        for (const evidence of row.evidence) {
          tx.run("INSERT INTO external_evidence VALUES (?,?,?)", evidence.id, attemptId, canonical(evidence));
          this.app.memory.source(tx, { id: evidence.id, botId: attempt.snapshot.bot.id, conversationId: work.conversationId, attribution: "external", text: evidence.content || "(no returned content)", derived });
          packet.sources.push({ id: evidence.id, revision: 1, generation: 1 });
        }
        packet.bytes = Buffer.byteLength(canonical(packet));
        save(tx, "memory_contexts", packet);
        if (result.sessionId !== null && setting.mode === "anonymous") {
          const previous = tx.get<{ vendor_id: string }>("SELECT vendor_id FROM parallel_sessions WHERE conversation_id=?", work.conversationId);
          if (previous && previous.vendor_id !== result.sessionId) throw new ParallelFailure("schema_changed");
          tx.run("INSERT OR IGNORE INTO parallel_sessions VALUES (?,?)", work.conversationId, result.sessionId);
        }
        save(tx, "web_reads", row);
      });
      return row;
    } catch (error) {
      row.outcome = timedOut ? "deadline" : signal.aborted ? "cancelled" : error instanceof ParallelFailure ? error.outcome : error instanceof AppError && ["grant_revoked", "grant_expired", "attempt_fenced", "computer_attempt_fenced", "memory_context_stale", "scope_revoked_or_stale", "bot_authority_changed", "owner_authority_changed"].includes(error.code) ? "authority_changed" : "service_error";
      row.evidence = [];
      if (row.outcome === "private_context" || row.outcome === "credential_refused") row.subject = "[outbound blocked]";
      row.reason = `parallel_${row.outcome}`;
      row.finishedAt = this.app.now(); row.remoteRequests = client?.requests ?? 0;
      this.app.store.transaction(tx => {
        const packet = tx.get<{ record_json: string }>("SELECT record_json FROM memory_contexts WHERE json_extract(record_json,'$.attemptId')=?", attemptId);
        if (packet && (JSON.parse(packet.record_json) as MemoryPacket).state === "retired") {
          row.subject = "[withdrawn context]"; row.missing = []; row.failures = [];
        }
        save(tx, "web_reads", row);
      });
      return row;
    } finally { clear(); signal.removeEventListener("abort", cancel); }
  }

  /** Builds exactly the owner's allowed two trusted application tools, without importing vendor tool declarations. */
  definitions(attempt: Attempt): ToolDefinition[] {
    if (hostCapabilities().webToolsContract !== "schway.host.web-tools/v1") throw new AppError("install_supported_schway_web_tools", 503);
    const tools = [
      {
        name: "web_search" as const,
        description: "Search public evidence through the selected Parallel mode. Queries leave this machine; failures never change identity or provider.",
        properties: { query: { type: "string", minLength: 1, maxLength: 8192 } },
        required: ["query"],
      },
      {
        name: "web_fetch" as const,
        description: "Read one public URL through Parallel. Set fullContent explicitly; excerpts and unknown freshness remain labelled. Parallel performs remote retrieval; Jit does not validate its DNS.",
        properties: { url: { type: "string", minLength: 1, maxLength: 8192 }, fullContent: { type: "boolean" } },
        required: ["url", "fullContent"],
      },
    ];
    return tools.filter(tool => attempt.snapshot.tools.includes(tool.name)).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false },
      effect: "read-only",
      execution: "exclusive",
      execute: async (input, context) => this.toolResult(await this.read(attempt.id, tool.name, input, context.signal)),
    }));
  }

  private toolResult(read: WebRead): ToolExecutionResult {
    return { content: frame(read), isError: read.outcome !== "success" && read.outcome !== "partial", details: { readId: read.id, outcome: read.outcome, evidence: read.evidence.map(e => ({ id: e.id, revision: e.revision, coverage: e.coverage })) } };
  }

  /** Reads bounded actual requests and evidence for one work item without performing any new retrieval. */
  inspect(actor: OwnerActor, workId: string): { reads: WebRead[]; evidence: ExternalEvidence[] } {
    identity(workId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor); record<Work>(tx, "work_items", workId);
      const reads = tx.all<{ record_json: string }>("SELECT record_json FROM web_reads WHERE json_extract(record_json,'$.workId')=? ORDER BY rowid DESC LIMIT 256", workId).map(r => JSON.parse(r.record_json) as WebRead).reverse();
      const evidence = tx.all<{ record_json: string }>("SELECT record_json FROM external_evidence WHERE json_extract(record_json,'$.workId')=? ORDER BY rowid DESC LIMIT 1280", workId).map(r => JSON.parse(r.record_json) as ExternalEvidence).reverse();
      return { reads, evidence };
    });
  }

  /** Validates a citation against this exact attempt's committed, still-live evidence revision. */
  citation(tx: AppTransaction, attemptId: string, evidenceId: string, revision: number): ExternalEvidence {
    identity(evidenceId); integer(revision, 1);
    const evidence = record<ExternalEvidence>(tx, "external_evidence", evidenceId);
    const attempt = record<Attempt>(tx, "work_attempts", attemptId);
    if (evidence.attemptId !== attemptId || evidence.revision !== revision || !this.app.memory.attemptCurrent(tx, attempt.id) || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='source' AND id=?", evidenceId)) throw new AppError("evidence_unavailable", 404);
    return evidence;
  }

  /** Reconciles withdrawn evidence/audit copies before owner reads or restored workers can replay them. */
  reconcile(tx: AppTransaction): void {
    const withdrawn = tx.all<{ id: string; mode: string }>("SELECT id,mode FROM lifecycle.withdrawals WHERE kind='source'");
    const unavailable = new Set(withdrawn.map(s => s.id));
    for (const key of unavailable) {
      tx.run("DELETE FROM external_evidence WHERE id=?", key);
    }
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM web_reads")) {
      const read = JSON.parse(row.record_json) as WebRead;
      const packet = tx.get<{ record_json: string }>("SELECT record_json FROM memory_contexts WHERE json_extract(record_json,'$.attemptId')=?", read.attemptId);
      if (packet && (JSON.parse(packet.record_json) as MemoryPacket).state === "retired" || read.evidence.some(e => unavailable.has(e.id))) {
        read.evidence = []; read.subject = "[withdrawn context]"; read.missing = []; read.failures = []; read.outcome = "authority_changed"; read.reason = "memory_context_stale";
        save(tx, "web_reads", read);
      }
    }
  }

  /** Marks interrupted reads honestly at exclusive boot; no query, credential or vendor fallback is retried. */
  recover(): void {
    this.app.store.transaction(tx => {
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM web_reads WHERE json_extract(record_json,'$.outcome')='running'")) {
        const read = JSON.parse(row.record_json) as WebRead;
        read.outcome = "service_error"; read.reason = "interrupted_no_auto_retry"; read.finishedAt = this.app.now();
        save(tx, "web_reads", read);
      }
    });
  }
}

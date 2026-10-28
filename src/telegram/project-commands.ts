import type { DeliverySender } from "../delivery/sender";
import { TelegramControlOutbox } from "./control-outbox";
import { AppError } from "../errors";
import type { Application, OwnerActor } from "../application";
import type { AppConfig } from "../config";
import type { JobQueue } from "../jobs/queue";
import { TransactionStore, type AppTransaction } from "../store";
import type { TaskCommand } from "../tasks";
import type { TeamCommand } from "../team/types";
import { classifyUpdate } from "./protocol";
import { readBinding } from "./binding";
import { createCallbackRef, decodeCallbackData, readCallbackRef, refreshCallbackRef, type TelegramCallbackRef } from "./callbacks";
import { mutateProjectContext, readProjectContext, type TelegramProjectContext } from "./context";
import { ensureTelegramProjectSchema } from "./schema";
import { tr } from "../i18n";
import type { TelegramInboxEvent, TelegramUpdate } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function boundedReply(text: string, maximum: number): string {
  let result = "";
  for (const char of text) { if (Buffer.byteLength(result + char) > Math.min(4096, maximum)) break; result += char; }
  return result;
}

export interface TelegramProjectCommandsOptions {
  app: Application;
  sessionToken: string;
  config: AppConfig;
  now?: () => number;
  jobs?: JobQueue;
  controlSender?: DeliverySender;
}

export interface TelegramCommandOutcome {
  kind: "reply" | "noop" | "reject";
  projectId?: string;
  text?: string;
  dedupeKey?: string;
  reason?: string;
}

interface MessageCommandRecord {
  kind: string;
  requestId: string;
  projectId: string;
  taskId?: string;
  proposalId?: string;
}

/** telegram.project_commands/v1 — maps authorized inbox events to Application commands and outbox replies. */
export class TelegramProjectCommands {
  #app: Application;
  #token: string;
  #config: AppConfig;
  #now: () => number;
  #jobs: JobQueue | undefined;
  #control: TelegramControlOutbox;
  #controlSender: DeliverySender | undefined;

  constructor(readonly store: TransactionStore, options: TelegramProjectCommandsOptions) {
    this.#app = options.app;
    this.#token = options.sessionToken;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#jobs = options.jobs;
    this.#control = new TelegramControlOutbox(store, this.#now);
    this.#controlSender = options.controlSender;
  }

  /** Processes one authorized inbox event; never mutates state without Application.execute. */
  handle(event: TelegramInboxEvent, raw: TelegramUpdate): TelegramCommandOutcome {
    const binding = this.store.read(tx => readBinding(tx));
    const persisted = this.store.read(tx => tx.get<{ raw_json: string; binding_revision: number; classification: string }>("SELECT raw_json, binding_revision, classification FROM telegram_inbox WHERE sequence = ?", event.sequence));
    if (!persisted || persisted.raw_json !== JSON.stringify(raw) || persisted.classification !== "authorized" || event.classification !== "authorized" || event.bindingRevision !== persisted.binding_revision || event.updateId !== raw.update_id) return { kind: "reject", reason: "telegram_event_unverified" };
    const verified = classifyUpdate(raw, binding, this.#now());
    if (verified.classification !== "authorized" || event.bindingRevision !== binding.revision || verified.telegramUserId !== event.telegramUserId || verified.telegramChatId !== event.telegramChatId || verified.textContent !== event.textContent) return { kind: "reject", reason: "telegram_binding_changed" };
    this.#telegramActor();
    if (binding.state !== "bound") return { kind: "reject", reason: "telegram_binding_not_bound" };
    if (event.contentKind === "callback_query") return this.#callback(event, binding.revision);
    const text = event.textContent?.trim();
    if (!text) return { kind: "noop" };
    if (raw.edited_message) return this.#editedMessage(event, raw);
    if (text.startsWith("/bind ")) return this.#bind(event, text, binding.revision);
    if (text === "/projects") return this.#projects(event);
    if (text === "/tasks") return this.#tasks(event, binding.revision);
    if (text.startsWith("/follow ")) return this.#follow(event, text.slice(8).trim(), binding.revision);
    if (text.startsWith("/accept ")) return this.#callback({ ...event, textContent: text.slice(8).trim() }, binding.revision);
    if (text.startsWith("/task edit ")) return this.#taskEditText(event, text.slice(11), binding.revision);
    if (text === "/halt" || text.startsWith("/halt ")) return this.#halt(event, text.slice(5).trim(), binding.revision);
    return { kind: "noop" };
  }

  #telegramActor(): OwnerActor {
    return this.#app.issueAdapterActor(this.#token, "telegram");
  }


  #bind(event: TelegramInboxEvent, text: string, bindingRevision: number): TelegramCommandOutcome {
    const parts = text.split(/\s+/);
    const projectId = parts[1], topicId = parts[2];
    const expected = parts[3] != null ? Number(parts[3]) : null;
    if (!projectId || !topicId || !UUID.test(projectId) || !UUID.test(topicId)) {
      return { kind: "reply", text: "ใช้: /bind <projectId> <topicId> [contextRevision]" };
    }
    try {
      const ctx = this.store.transaction(tx => mutateProjectContext(tx, event.telegramChatId!, bindingRevision,
        expected, projectId, topicId, this.#now()));
      const project = this.#app.project(this.#telegramActor(), projectId);
      return { kind: "reply", projectId, text: `ผูกแล้ว: ${project.name} / topic ${ctx.topicId} (revision ${ctx.revision})` };
    } catch (error) {
      return this.#errorOutcome(error, projectId);
    }
  }

  #projects(event: TelegramInboxEvent): TelegramCommandOutcome {
    const items = this.#app.workspace(this.#telegramActor()).projects;
    if (!items.length) return { kind: "reply", text: "ยังไม่มีโครงการ — สร้างบน Web ก่อน" };
    const lines = items.map(p => `• ${p.name}\n  ${p.id}`);
    return { kind: "reply", text: `เลือก projectId แล้ว /bind:\n${lines.join("\n")}` };
  }

  #tasks(event: TelegramInboxEvent, bindingRevision: number): TelegramCommandOutcome {
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) {
      return { kind: "reply", text: "ยังไม่ได้ผูก project/topic — ใช้ /projects แล้ว /bind <projectId> <topicId>" };
    }
    const model = this.#app.tasks(this.#telegramActor(), ctx.projectId);
    const proposed = model.proposed.filter(t => t.topicId === ctx.topicId);
    if (!proposed.length) {
      return { kind: "reply", projectId: ctx.projectId, text: `ไม่มีข้อเสนองานค้างใน topic นี้\n/project ${ctx.projectId}\n/topic ${ctx.topicId}` };
    }
    const lines: string[] = [`โครงการ ${model.project.name} — ข้อเสนอ (${proposed.length}):\nproject ${ctx.projectId}\ntopic ${ctx.topicId}`];
    for (const task of proposed.slice(0, 3)) {
      const open = this.#app.task(this.#telegramActor(), ctx.projectId, task.id);
      const proposal = open.proposals.at(-1)!;
      const { data } = this.store.transaction(tx => createCallbackRef(tx, {
        telegramChatId: event.telegramChatId!, bindingRevision, projectId: ctx.projectId, topicId: ctx.topicId,
        contextRevision: ctx.revision, action: "task.accept", taskId: task.id, proposalId: proposal.id, expectedRevision: open.task.revision,
        requestId: `tg-cb-accept-${proposal.id}`,
      }, this.#now()));
      lines.push(`• ${task.title}\n  task ${task.id}\n  proposal ${proposal.id} rev ${open.task.revision}\n  /accept ${data}`);
    }
    return { kind: "reply", projectId: ctx.projectId, text: lines.join("\n\n") };
  }

  #follow(event: TelegramInboxEvent, purpose: string, bindingRevision: number): TelegramCommandOutcome {
    if (!purpose || purpose.length > 500) return { kind: "reply", text: "ใช้: /follow <คำถาม follow-up>" };
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) {
      return { kind: "reply", text: "ผูก project/topic ด้วย /bind ก่อนส่ง follow-up" };
    }
    const project = this.#app.project(this.#telegramActor(), ctx.projectId);
    const topic = this.#app.conversation(this.#telegramActor(), ctx.projectId, ctx.topicId).topic;
    if (!topic) return { kind: "reject", reason: "topic_not_found", projectId: ctx.projectId };
    const command: Extract<TeamCommand, { kind: "team.dispatch" }> = {
      kind: "team.dispatch", requestId: `tg-follow-${event.sequence}`, projectId: ctx.projectId,
      expectedRevision: project.revision,
      payload: {
        topicId: ctx.topicId, purpose, sources: [topic.source], include: [], exclude: [],
        limits: { ...this.#config.jobs.maximum },
      },
    };
    try {
      const receipt = this.#app.execute(this.#telegramActor(), command);
      const discussion = receipt.discussion!;
      return {
        kind: "reply", projectId: ctx.projectId,
        text: `Follow-up บันทึกแล้ว\nproject ${ctx.projectId}\ntopic ${ctx.topicId}\ndiscussion ${discussion.id} rev ${discussion.revision}\nดูรายละเอียด specialist บน Web`,
        dedupeKey: `tg:follow:${event.sequence}`,
      };
    } catch (error) {
      return this.#errorOutcome(error, ctx.projectId);
    }
  }

  /**
   * app.access_level/v1 kill switch from the bound owner chat: `/halt [reason]` issues `execution.halt` for the chat's
   * bound project with the `telegram` channel. Telegram can only narrow: no text command or callback widens a level or
   * resumes execution (the Application refuses any such command from this channel with `access_widen_requires_web`).
   */
  #halt(event: TelegramInboxEvent, reason: string, bindingRevision: number): TelegramCommandOutcome {
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) return { kind: "reply", text: tr("telegram.halt_needs_bind") };
    try {
      const access = this.#app.projectAccess(this.#telegramActor(), ctx.projectId);
      const receipt = this.#app.execute(this.#telegramActor(), {
        kind: "execution.halt", requestId: `tg-halt-${event.sequence}`, projectId: ctx.projectId, expectedRevision: access.haltRevision,
        payload: reason ? { reason } : {},
      });
      return {
        kind: "reply", projectId: ctx.projectId,
        text: tr("telegram.halt_done").replace("{revision}", String(receipt.access.haltRevision)),
        dedupeKey: `tg:halt:${event.sequence}`,
      };
    } catch (error) {
      return this.#errorOutcome(error, ctx.projectId);
    }
  }

  #taskEditText(event: TelegramInboxEvent, rest: string, bindingRevision: number): TelegramCommandOutcome {
    const match = rest.match(/^([0-9a-f-]{36})\s+(\d+)\s+\|\s(.+?)\s+\|\s([\s\S]+)$/i);
    if (!match) return { kind: "reply", text: "ใช้: /task edit <taskId> <revision> | <title> | <summary>" };
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) return { kind: "reply", text: "ผูก context ก่อนแก้ task" };
    const taskId = match[1]!;
    try {
      const open = this.#app.task(this.#telegramActor(), ctx.projectId, taskId);
      if (open.task.topicId !== ctx.topicId || open.task.state !== "proposed") return { kind: "reply", projectId: ctx.projectId, text: "task ไม่ใช่ข้อเสนอใน topic ปัจจุบัน — เปิด revision บน Web ก่อนแก้" };
      const command: Extract<TaskCommand, { kind: "task.edit" }> = {
        kind: "task.edit", requestId: `tg-edit-${event.sequence}`, projectId: ctx.projectId,
        expectedRevision: Number(match[2]),
        payload: { taskId, title: match[3]!.trim(), summary: match[4]!.trim() },
      };
      const receipt = this.#app.execute(this.#telegramActor(), command);
      this.#recordMessage(event, { kind: "task.edit", requestId: command.requestId, projectId: ctx.projectId, taskId, proposalId: receipt.proposal.id });
      return {
        kind: "reply", projectId: ctx.projectId,
        text: `แก้ข้อเสนอแล้ว\n task ${taskId}\n proposal ${receipt.proposal.id} rev ${receipt.task.revision}`,
        dedupeKey: `tg:edit:${event.sequence}`,
      };
    } catch (error) {
      return this.#errorOutcome(error, ctx.projectId);
    }
  }

  #callback(event: TelegramInboxEvent, bindingRevision: number): TelegramCommandOutcome {
    const refId = decodeCallbackData(event.textContent);
    if (!refId) return { kind: "reject", reason: "telegram_callback_invalid" };
    try {
      const ref = this.store.read(tx => readCallbackRef(tx, refId, this.#now()));
      const ctx = this.contextForChat(event.telegramChatId!);
      if (!ctx || ctx.bindingRevision !== bindingRevision || ctx.revision !== ref.contextRevision || ctx.projectId !== ref.projectId || ctx.topicId !== ref.topicId || ref.telegramChatId !== event.telegramChatId || ref.bindingRevision !== bindingRevision) {
        return { kind: "reply", text: "บริบทหรือ binding เปลี่ยนแล้ว — ใช้ /tasks ใน project/topic ปัจจุบันเพื่อรับ callback ใหม่" };
      }
      if (ref.action === "task.accept") return this.#acceptCallback(event, ref);
      return { kind: "reject", reason: "telegram_callback_unsupported" };
    } catch (error) {
      if (error instanceof AppError && error.code === "telegram_callback_expired") {
        return { kind: "reply", text: "Callback หมดอายุ — ใช้ /tasks เพื่อรับ proposal ปัจจุบัน" };
      }
      return this.#errorOutcome(error);
    }
  }

  #acceptCallback(event: TelegramInboxEvent, ref: TelegramCallbackRef): TelegramCommandOutcome {
    const open = this.#app.task(this.#telegramActor(), ref.projectId, ref.taskId);
    const command: Extract<TaskCommand, { kind: "task.accept" }> = {
      kind: "task.accept", requestId: ref.requestId, projectId: ref.projectId, expectedRevision: ref.expectedRevision,
      payload: { taskId: ref.taskId, proposalId: ref.proposalId },
    };
    try {
      const receipt = this.#app.execute(this.#telegramActor(), command);
      this.#recordMessage(event, { kind: "task.accept", requestId: ref.requestId, projectId: ref.projectId, taskId: ref.taskId, proposalId: ref.proposalId });
      return {
        kind: "reply", projectId: ref.projectId,
        text: `รับงานแล้ว ✓\nproject ${ref.projectId}\ntopic ${ref.topicId}\ntask ${ref.taskId}\nproposal ${receipt.proposal.id} rev ${receipt.task.revision}\nchannel telegram`,
        dedupeKey: `tg:accept:${ref.requestId}`,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "stale_revision") {
        const fresh = open.proposals.at(-1)!;
        if (open.task.state !== "proposed") return { kind: "reply", projectId: ref.projectId, text: `Proposal เปลี่ยนสถานะแล้ว: ${open.task.state} — เปิด task ${ref.taskId} บน Web` };
        const { data } = this.store.transaction(tx => refreshCallbackRef(tx, ref, open.task.revision, fresh.id, this.#now()));
        return { kind: "reply", projectId: ref.projectId, text: `Proposal เก่าแล้ว — ปัจจุบัน rev ${open.task.revision} proposal ${fresh.id}\n/accept ${data}` };
      }
      if (error instanceof AppError && error.code === "request_id_conflict") {
        const model = this.#app.task(this.#telegramActor(), ref.projectId, ref.taskId);
        return {
          kind: "reply", projectId: ref.projectId,
          text: `รับงานแล้วก่อนหน้านี้ (ไม่ซ้ำ obligation)\ntask ${ref.taskId} state ${model.task.state}`,
          dedupeKey: `tg:accept:${ref.requestId}`,
        };
      }
      return this.#errorOutcome(error, ref.projectId);
    }
  }

  #editedMessage(event: TelegramInboxEvent, raw: TelegramUpdate): TelegramCommandOutcome {
    const messageId = raw.edited_message?.message_id;
    if (messageId == null) return { kind: "noop" };
    const prior = this.store.read(tx => {
      ensureTelegramProjectSchema(tx);
      return tx.get<{ record_json: string }>("SELECT record_json FROM telegram_message_commands WHERE telegram_chat_id = ? AND message_id = ?",
        event.telegramChatId, messageId);
    });
    if (!prior) return { kind: "noop" };
    const record = JSON.parse(prior.record_json) as MessageCommandRecord;
    if (record.taskId) {
      const current = this.#app.task(this.#telegramActor(), record.projectId, record.taskId).task;
      return {
        kind: "reply", projectId: record.projectId,
        text: `ข้อความที่แก้ไม่เปลี่ยนคำสั่งหรือ accept ที่ commit แล้ว\ntask ${record.taskId} state ${current.state} revision ${current.revision} — ใช้คำสั่งใหม่หรือ Web`,
        dedupeKey: `tg:edit-conflict:${event.sequence}`,
      };
    }
    return { kind: "noop" };
  }

  #recordMessage(event: TelegramInboxEvent, record: MessageCommandRecord): void {
    if (event.messageId == null) return;
    this.store.transaction(tx => {
      ensureTelegramProjectSchema(tx);
      tx.run(`INSERT OR REPLACE INTO telegram_message_commands VALUES (?, ?, ?, ?)`,
        event.telegramChatId, event.messageId, JSON.stringify(record), this.#now());
    });
  }

  #errorOutcome(error: unknown, projectId?: string): TelegramCommandOutcome {
    if (error instanceof AppError && error.status < 500) {
      const detail = error.detail ? `\n${JSON.stringify(error.detail)}` : "";
      const text = `${error.code}${detail}`;
      if (projectId) {
        try { this.#app.project(this.#telegramActor(), projectId); return { kind: "reply", projectId, text }; } catch { /* Selection errors have no authorized project scope. */ }
      }
      return { kind: "reply", text };
    }
    throw error;
  }

  /** Commits a logical outbox reply for a processed inbox event. */
  commitReply(outcome: TelegramCommandOutcome, event: TelegramInboxEvent): void {
    if (outcome.kind !== "reply" || !outcome.text) return;
    const binding = this.store.read(tx => readBinding(tx));
    if (binding.state !== "bound" || binding.revision !== event.bindingRevision || binding.telegramChatId !== event.telegramChatId || binding.telegramUserId !== event.telegramUserId) throw new AppError("telegram_binding_changed", 409);
    this.#telegramActor();
    if (!outcome.projectId) { this.#control.commit(event.sequence, boundedReply(outcome.text, this.#config.messageBytes)); return; }
    const project = this.#app.project(this.#telegramActor(), outcome.projectId);
    const ctx = this.contextForChat(event.telegramChatId!);
    const context = `project ${outcome.projectId}${ctx?.projectId === outcome.projectId ? `\ntopic ${ctx.topicId}` : ""}`;
    const dedupeKey = outcome.dedupeKey ?? `tg:inbox:${event.sequence}`;
    this.#app.execute(this.#telegramActor(), {
      kind: "delivery.commit", requestId: `tg-reply-${event.sequence}`, projectId: outcome.projectId,
      expectedRevision: project.revision,
      payload: { kind: "report", text: boundedReply(`${context}\n${outcome.text}`, this.#config.messageBytes), dedupeKey },
    });
  }

  /** Starts admitted fixture work after the enclosing command transaction commits. */
  pump(): void { this.#jobs?.pump(); if (this.#controlSender) this.#control.pump(this.#controlSender); }

  /** Owner inspection for project selection/help reply status, including unknown delivery. */
  controlReplies(after = 0) { this.#telegramActor(); return this.#control.list(after); }

  /** Reads the current revisioned context without changing it. */
  contextForChat(telegramChatId: number): TelegramProjectContext | null {
    return this.store.read(tx => readProjectContext(tx, telegramChatId));
  }
}

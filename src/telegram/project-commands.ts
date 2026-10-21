import { AppError } from "../errors";
import type { Application, OwnerActor } from "../application";
import type { AppConfig } from "../config";
import type { JobQueue } from "../jobs/queue";
import { TransactionStore, type AppTransaction } from "../store";
import type { TaskCommand } from "../tasks";
import type { TeamCommand } from "../team/types";
import { readBinding } from "./binding";
import { createCallbackRef, decodeCallbackData, readCallbackRef, refreshCallbackRef, type TelegramCallbackRef } from "./callbacks";
import { listProjectChoices, mutateProjectContext, readProjectContext, type TelegramProjectContext } from "./context";
import { ensureTelegramProjectSchema } from "./schema";
import type { TelegramInboxEvent, TelegramUpdate } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rid = () => crypto.randomUUID();

export interface TelegramProjectCommandsOptions {
  app: Application;
  sessionToken: string;
  config: AppConfig;
  now?: () => number;
  jobs?: JobQueue;
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

  constructor(readonly store: TransactionStore, options: TelegramProjectCommandsOptions) {
    this.#app = options.app;
    this.#token = options.sessionToken;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#jobs = options.jobs;
  }

  /** Processes one authorized inbox event; never mutates state without Application.execute. */
  handle(event: TelegramInboxEvent, raw: TelegramUpdate): TelegramCommandOutcome {
    const binding = this.store.read(tx => readBinding(tx));
    if (binding.state !== "bound") return { kind: "reject", reason: "telegram_binding_not_bound" };
    if (event.contentKind === "callback_query") return this.#callback(event, binding.revision);
    const text = event.textContent?.trim();
    if (!text) return { kind: "noop" };
    if (raw.edited_message) return this.#editedMessage(event, raw);
    if (text.startsWith("/bind ")) return this.#bind(event, text, binding.revision);
    if (text === "/projects") return this.#projects(event);
    if (text === "/tasks") return this.#tasks(event, binding.revision);
    if (text.startsWith("/follow ")) return this.#follow(event, text.slice(8).trim(), binding.revision);
    if (text.startsWith("/task edit ")) return this.#taskEditText(event, text.slice(11), binding.revision);
    return { kind: "noop" };
  }

  #telegramActor(): OwnerActor {
    return this.#app.issueAdapterActor(this.#token, "telegram");
  }

  #webActor(): OwnerActor {
    return this.#app.authenticate(this.#token).actor;
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
      const project = this.#app.project(this.#webActor(), projectId);
      return { kind: "reply", projectId, text: `ผูกแล้ว: ${project.name} / topic ${ctx.topicId.slice(0, 8)}… (revision ${ctx.revision})` };
    } catch (error) {
      return this.#errorOutcome(error, projectId);
    }
  }

  #projects(event: TelegramInboxEvent): TelegramCommandOutcome {
    const items = this.store.read(tx => listProjectChoices(tx, this.#config.pageSize));
    if (!items.length) return { kind: "reply", text: "ยังไม่มีโครงการ — สร้างบน Web ก่อน" };
    const lines = items.map(p => `• ${p.name}\n  ${p.id}`);
    return { kind: "reply", text: `เลือก projectId แล้ว /bind:\n${lines.join("\n")}` };
  }

  #tasks(event: TelegramInboxEvent, bindingRevision: number): TelegramCommandOutcome {
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) {
      return { kind: "reply", text: "ยังไม่ได้ผูก project/topic — ใช้ /projects แล้ว /bind <projectId> <topicId>" };
    }
    const model = this.#app.tasks(this.#webActor(), ctx.projectId);
    const proposed = model.proposed.filter(t => t.topicId === ctx.topicId);
    if (!proposed.length) {
      return { kind: "reply", projectId: ctx.projectId, text: `ไม่มีข้อเสนองานค้างใน topic นี้\n/project ${ctx.projectId}\n/topic ${ctx.topicId}` };
    }
    const lines: string[] = [`โครงการ ${model.project.name} — ข้อเสนอ (${proposed.length}):`];
    for (const task of proposed.slice(0, 8)) {
      const open = this.#app.task(this.#webActor(), ctx.projectId, task.id);
      const proposal = open.proposals.at(-1)!;
      const { data } = this.store.transaction(tx => createCallbackRef(tx, {
        telegramChatId: event.telegramChatId!, bindingRevision, projectId: ctx.projectId, topicId: ctx.topicId,
        action: "task.accept", taskId: task.id, proposalId: proposal.id, expectedRevision: open.task.revision,
        requestId: `tg-cb-accept-${proposal.id}`,
      }, this.#now()));
      lines.push(`• ${task.title}\n  task ${task.id}\n  proposal ${proposal.id} rev ${open.task.revision}\n  callback: ${data}`);
    }
    return { kind: "reply", projectId: ctx.projectId, text: lines.join("\n\n") };
  }

  #follow(event: TelegramInboxEvent, purpose: string, bindingRevision: number): TelegramCommandOutcome {
    if (!purpose || purpose.length > 500) return { kind: "reply", text: "ใช้: /follow <คำถาม follow-up>" };
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) {
      return { kind: "reply", text: "ผูก project/topic ด้วย /bind ก่อนส่ง follow-up" };
    }
    const project = this.#app.project(this.#webActor(), ctx.projectId);
    const topic = this.#app.topics(this.#webActor(), ctx.projectId).items.find(t => t.id === ctx.topicId);
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
      const receipt = this.#app.execute(this.#webActor(), command);
      this.#jobs?.pump();
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

  #taskEditText(event: TelegramInboxEvent, rest: string, bindingRevision: number): TelegramCommandOutcome {
    const match = rest.match(/^([0-9a-f-]{36})\s+\|\s(.+?)\s+\|\s([\s\S]+)$/i);
    if (!match) return { kind: "reply", text: "ใช้: /task edit <taskId> | <title> | <summary>" };
    const ctx = this.store.read(tx => readProjectContext(tx, event.telegramChatId!));
    if (!ctx || ctx.bindingRevision !== bindingRevision) return { kind: "reply", text: "ผูก context ก่อนแก้ task" };
    const taskId = match[1]!;
    try {
      const open = this.#app.task(this.#telegramActor(), ctx.projectId, taskId);
      const command: Extract<TaskCommand, { kind: "task.edit" }> = {
        kind: "task.edit", requestId: `tg-edit-${event.sequence}`, projectId: ctx.projectId,
        expectedRevision: open.task.revision,
        payload: { taskId, title: match[2]!.trim(), summary: match[3]!.trim() },
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
      if (ref.telegramChatId !== event.telegramChatId || ref.bindingRevision !== bindingRevision) {
        return { kind: "reject", reason: "telegram_callback_stale_binding" };
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
    if (open.proposals.at(-1)!.id !== ref.proposalId || open.task.revision !== ref.expectedRevision) {
      const fresh = open.proposals.at(-1)!;
      const { data } = this.store.transaction(tx => refreshCallbackRef(tx, ref, open.task.revision, fresh.id, this.#now()));
      return {
        kind: "reply", projectId: ref.projectId,
        text: `Proposal เก่าแล้ว — ปัจจุบัน rev ${open.task.revision} proposal ${fresh.id}\ncallback: ${data}`,
      };
    }
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
    if (record.kind === "task.accept") {
      return {
        kind: "reply", projectId: record.projectId,
        text: `ข้อความที่แก้ไม่เปลี่ยนการ accept ที่ commit แล้ว\ntask ${record.taskId} ยัง accepted — ใช้ /task edit หรือ Web สำหรับ revision ใหม่`,
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
    if (error instanceof AppError) {
      const detail = error.detail ? `\n${JSON.stringify(error.detail)}` : "";
      const text = `${error.code}${detail}`;
      if (projectId) return { kind: "reply", projectId, text, dedupeKey: `tg:err:${error.code}:${rid()}` };
      return { kind: "reply", text };
    }
    return { kind: "reject", reason: "telegram_command_failed" };
  }

  /** Commits a logical outbox reply for a processed inbox event. */
  commitReply(outcome: TelegramCommandOutcome, event: TelegramInboxEvent): void {
    if (outcome.kind !== "reply" || !outcome.text || !outcome.projectId) return;
    const project = this.#app.project(this.#webActor(), outcome.projectId);
    const dedupeKey = outcome.dedupeKey ?? `tg:inbox:${event.sequence}`;
    this.#app.execute(this.#webActor(), {
      kind: "delivery.commit", requestId: `tg-reply-${event.sequence}`, projectId: outcome.projectId,
      expectedRevision: project.revision,
      payload: { kind: "report", text: outcome.text.slice(0, this.#config.messageBytes), dedupeKey },
    });
  }

  contextForChat(telegramChatId: number): TelegramProjectContext | null {
    return this.store.read(tx => readProjectContext(tx, telegramChatId));
  }
}

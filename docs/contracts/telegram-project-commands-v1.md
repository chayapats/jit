# Telegram project commands, v1

Owner: Jit #21 (TG02). Contract: `telegram.project_commands/v1`. Implementation: `src/telegram/project-commands.ts`, `src/telegram/context.ts`, `src/telegram/callbacks.ts`, `src/telegram/schema.ts`, `TelegramChannel.processProjectCommands`. Requires `telegram.owner_binding/v1`, `telegram.durable_inbox/v1`, `delivery.outbox/v1`, `app.task_commands/v1`, `app.team_dispatch/v1`, and `app.project_commands/v1`. FR-01/06/07/10/11/15/17, NFR-07/10/11. Read alongside [ADR 0018](../adr/0018-telegram-project-commands.md).

Inbound Telegram text and callbacks remain untrusted until this boundary maps them to shared Application commands with dedupe keys and expected revisions.

## Exact public surface

```ts
export function ensureTelegramProjectSchema(tx: AppTransaction): void;

export interface TelegramProjectContext {
  telegramChatId: number; revision: number; bindingRevision: number;
  projectId: string; topicId: string; updatedAt: number;
}
export function readProjectContext(tx, telegramChatId): TelegramProjectContext | null;
export function mutateProjectContext(tx, telegramChatId, bindingRevision, expectedRevision, projectId, topicId, now): TelegramProjectContext;
export function listProjectChoices(tx, limit): { id: string; name: string; revision: number }[];

export interface TelegramCallbackRef { /* bounded server ref; see callbacks.ts */ }
export function createCallbackRef(tx, input, now): { ref: TelegramCallbackRef; data: string };
export function decodeCallbackData(data: string | null | undefined): string | null;
export function readCallbackRef(tx, id, now): TelegramCallbackRef;

export interface TelegramProjectCommandsOptions {
  app: Application; sessionToken: string; config: AppConfig; now?: () => number; jobs?: JobQueue;
}
export class TelegramProjectCommands {
  constructor(store: TransactionStore, options: TelegramProjectCommandsOptions);
  handle(event: TelegramInboxEvent, raw: TelegramUpdate): TelegramCommandOutcome;
  commitReply(outcome: TelegramCommandOutcome, event: TelegramInboxEvent): void;
  contextForChat(telegramChatId: number): TelegramProjectContext | null;
}

TelegramChannel.processProjectCommands(commands: TelegramProjectCommands): TelegramInboxEvent[];
```

## Owner text commands (authorized private chat only)

| Command | Application effect |
| --- | --- |
| `/projects` | Read-only project list with stable UUIDs |
| `/bind <projectId> <topicId> [contextRevision]` | Revisioned chat→project/topic binding |
| `/tasks` | Lists proposed tasks in bound topic; emits accept callback refs |
| `/follow <purpose>` | `team.dispatch` on bound project/topic (Web actor, shared receipt) |
| `/task edit <taskId> \| <title> \| <summary>` | `task.edit` via telegram adapter actor |

Callback payloads are at most 64 bytes: `tg/1/<8-hex>` referencing `telegram_callback_refs`. Accept callbacks call `task.accept` with stable `requestId` `tg-cb-accept-<proposalId>`; replay returns the original receipt. Stale proposal revision returns refreshed callback data without mutating tasks.

Edited messages after a committed accept on the same `message_id` yield an explicit conflict reply; they do not change acceptance. Forwarded and unauthorized traffic remain TG01 classifications and never reach this boundary.

## Outbox replies

Successful handling commits `delivery.commit` with dedupe `tg:inbox:<sequence>` or action-specific keys. Replies include project/topic/task/proposal identifiers shared with Web read models. Thai/English Unicode text is stored bounded by `messageBytes`; angle brackets are not interpreted as markup in fixture delivery.

## Deterministic evidence

`tests/telegram.test.ts` covers bind/ambiguous project IDs, task accept via callback (Web read model match), duplicate callback, stale proposal revision, edited accepted message conflict, cross-project same title, Thai follow-up, outbox waiting under provider outage, and restart durability. No live bot token.

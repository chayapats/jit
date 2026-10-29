import { holdOutboundCall, markOutboundAction, runOutboundGuard } from "../security/run-outbound";
import type { ToolDefinition, ToolExecutionResult } from "schway/host";
import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import type { ApplicationRunRequest } from "../team/types";
import { computerIntents, createCard, type ComputerConfirmAction, type ComputerIntent, type ComputerReason } from "./approval-cards";
import type { BoxHandle } from "./box-runtime";
import type { BrowserService } from "./browser";
import type { EffectOutcome, EffectPerformer } from "./effect-executor";
import { cardToolResult } from "./effect-tools";
import { displayHeight, displayWidth, maximumKeys, maximumTypedChars, takeoverActive, validKeys, validPoint, validTypedText, type DesktopInput } from "./takeover";

/**
 * exec.computer/v1 (EXE16, ADR 0039 § Computer-use) — computer-use on the box's virtual desktop.
 *
 * - **Availability.** `computer_screenshot`, `computer_click(x, y, intent)`, `computer_type(text, intent)` and
 *   `computer_key(keys, intent)` exist only for a `full` grant in a box running the browser image; they run `xdotool`
 *   on display `:99` through the box runner. Computer-use is never offered below `full`.
 * - **Intent is untrusted.** The model declares `input`, `navigate`, `submit` or `confirm`. A declared `submit` or
 *   `confirm` adds a card; nothing the model declares removes one, because Jit classifies each action itself:
 *   - always a card, whatever the intent and settings: `computer_key` with `Return`, `KP_Enter`, `ISO_Enter` or
 *     `Linefeed` (alone or with modifiers, or `ctrl+m`/`ctrl+j`), and `computer_type` text containing `\n` or `\r`;
 *   - with the project setting `computer.confirmEveryAction` on (the default), every `computer_click` and every
 *     `computer_key` is a card. Plain `computer_type` text without a line break is not gated by the setting.
 * - **Setting.** `computer.settings.set` is Web only (`computer_setting_requires_web` for Telegram and the local API).
 * - **Takeover.** While the owner holds a takeover every computer call and every approved computer card fails
 *   `takeover_active`.
 */
export const computerContract = "exec.computer/v1";
export const computerToolNames = Object.freeze(["computer_screenshot", "computer_click", "computer_type", "computer_key"] as const);

/** The project's computer-use setting. Revision 0 (no row) is the default: confirm every action. */
export interface ComputerSettings { projectId: string; revision: number; confirmEveryAction: boolean; updatedAt: number | null }
export interface SetComputerSettingsCommand {
  kind: "computer.settings.set"; requestId: string; projectId: string; expectedRevision: number; payload: { confirmEveryAction: boolean };
}
export interface ComputerSettingsReceipt { computer: ComputerSettings }

export const isComputerCommand = (command: unknown): command is SetComputerSettingsCommand =>
  !!command && typeof command === "object" && (command as { kind?: unknown }).kind === "computer.settings.set";

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates the exact command shape (`invalid_computer_command`) and returns its receipt identity. */
export function computerCommandIdentity(command: SetComputerSettingsCommand): string {
  if (!isComputerCommand(command) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !exact(command.payload, ["confirmEveryAction"]) || typeof command.payload.confirmEveryAction !== "boolean") throw new AppError("invalid_computer_command");
  requireId(command.projectId);
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.confirmEveryAction]);
}

/** The project's setting; without a row it is on (ADR 0039: default on until the owner turns it off in Web). */
export function readComputerSettings(tx: AppTransaction, projectId: string): ComputerSettings {
  const row = tx.get<{ revision: number; confirm: number; createdAt: number }>(
    "SELECT revision, confirm_every_action AS confirm, created_at AS createdAt FROM computer_settings WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
  return { projectId, revision: row?.revision ?? 0, confirmEveryAction: row ? row.confirm === 1 : true, updatedAt: row?.createdAt ?? null };
}

/** Web only, whatever the direction (`computer_setting_requires_web`, 403); revisioned (`stale_revision`). */
export function writeComputerSettings(tx: AppTransaction, command: SetComputerSettingsCommand, channel: string, now: number): ComputerSettings {
  if (channel !== "web") throw new AppError("computer_setting_requires_web", 403);
  const current = readComputerSettings(tx, command.projectId);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  tx.run("INSERT INTO computer_settings (project_id, revision, confirm_every_action, channel, created_at) VALUES (?, ?, ?, 'web', ?)",
    command.projectId, current.revision + 1, command.payload.confirmEveryAction ? 1 : 0, now);
  return readComputerSettings(tx, command.projectId);
}

/** Key names that press Enter (compared case-insensitively), and the control chords terminals treat as Enter. */
const enterKeys = new Set(["return", "kp_enter", "iso_enter", "linefeed"]);
const enterChords = /^(ctrl|control|control_l|control_r)\+(m|j)$/i;
/** True when one key combination presses Enter. */
export function pressesEnter(key: string): boolean {
  return key.split("+").some(part => enterKeys.has(part.toLowerCase())) || enterChords.test(key);
}

/** One computer action as the model asked for it. */
export type ComputerAction = { operation: "click"; x: number; y: number } | { operation: "type"; text: string } | { operation: "key"; keys: string[] };

/**
 * Jit's classification of one action. The declared intent may add `declared_submit`/`declared_confirm`; the action
 * itself adds `enter_key` and `line_break` whatever the intent or setting; `confirm_every_action` gates every click and
 * key when the setting is on. An empty list runs the action directly.
 */
export function computerReasons(action: ComputerAction, intent: ComputerIntent, confirmEveryAction: boolean): ComputerReason[] {
  const reasons: ComputerReason[] = [];
  if (intent === "submit") reasons.push("declared_submit");
  if (intent === "confirm") reasons.push("declared_confirm");
  if (action.operation === "key" && action.keys.some(pressesEnter)) reasons.push("enter_key");
  if (action.operation === "type" && /[\r\n]/.test(action.text)) reasons.push("line_break");
  if (confirmEveryAction && (action.operation === "click" || action.operation === "key")) reasons.push("confirm_every_action");
  return reasons;
}

const toInput = (action: ComputerAction): DesktopInput => action.operation === "click" ? { kind: "click", x: action.x, y: action.y }
  : action.operation === "type" ? { kind: "type", text: action.text } : { kind: "key", keys: action.keys };

/** What {@link ComputerService.openRun} needs from the run. */
export interface ComputerRunInput { request: ApplicationRunRequest; handle: BoxHandle; current(tx: AppTransaction): boolean }

const fail = (content: string): ToolExecutionResult => ({ content, isError: true });
const codeOf = (error: unknown, fallback: string) => error instanceof AppError ? error.code : fallback;
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const intentSchema = { type: "string", enum: [...computerIntents], description: "What this action does: input, navigate, submit or confirm. Submit and confirm always wait for the owner's approval." };

export class ComputerService {
  readonly #store: TransactionStore;
  readonly #browser: BrowserService;
  readonly #now: () => number;

  constructor(store: TransactionStore, browser: BrowserService, options: { now?: () => number } = {}) {
    this.#store = store;
    this.#browser = browser;
    this.#now = options.now ?? Date.now;
  }

  /** The computer tools of one run: only for a `full` grant in a browser-image box. */
  openRun(input: ComputerRunInput): { definitions: ToolDefinition[]; release(): void } {
    const { request } = input, projectId = request.projectId, outbound = runOutboundGuard(this.#store, request);
    if (request.execution?.level !== "full" || input.handle.mode !== "full" || !input.handle.profile) return { definitions: [], release: () => {} };
    let desktop: { release(): void } | null = null, released = false;
    const origin = { projectId, topicId: request.topicId, runId: request.runId, jobId: request.fence.jobId, roleId: request.roleId };
    /** The display runs while this run uses it. */
    const hold = async () => {
      if (released) throw new AppError("browser_session_closed", 409);
      desktop ??= await this.#browser.holdDesktop(projectId, request.roleId);
    };
    const guarded = (body: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecutionResult>) =>
      async (args: unknown, ctx: { signal?: AbortSignal }): Promise<ToolExecutionResult> => {
        if (this.#store.read(tx => takeoverActive(tx, projectId))) return fail("takeover_active: the owner is controlling this desktop. Do not send input; wait for them to end the takeover.");
        try { await hold(); return await body((args && typeof args === "object" ? args : {}) as Record<string, unknown>, ctx.signal); }
        catch (error) { return fail(`Computer call failed: ${codeOf(error, "computer_error")}.`); }
      };
    /** Classifies, then either pauses the action behind a card or performs it now. */
    const act = async (action: ComputerAction, intent: unknown, signal?: AbortSignal): Promise<ToolExecutionResult> => {
      if (!computerIntents.includes(intent as ComputerIntent)) return fail("intent must be one of input, navigate, submit or confirm.");
      const settings = this.#store.read(tx => readComputerSettings(tx, projectId));
      const reasons = computerReasons(action, intent as ComputerIntent, settings.confirmEveryAction);
      if (reasons.length) {
        const pinned: ComputerConfirmAction = { kind: "computer_confirm", operation: action.operation,
          x: action.operation === "click" ? action.x : null, y: action.operation === "click" ? action.y : null,
          text: action.operation === "type" ? action.text : null, keys: action.operation === "key" ? [...action.keys] : null, intent: intent as ComputerIntent, reasons };
        try {
          const card = this.#store.transaction(tx => {
            if (!input.current(tx)) throw new AppError("execution_access_changed");
            return createCard(tx, origin, markOutboundAction(pinned, outbound(pinned.text)), this.#now(), { autoApprove: false });
          });
          // The card holds the desktop session it was made on; its approval acts only on that session.
          this.#browser.pinCard(projectId, card.id);
          return cardToolResult(card);
        } catch (error) { return fail(`Jit refused the computer action: ${codeOf(error, "invalid_effect_action")}.`); }
      }
      const match = action.operation === "type" ? outbound(action.text) : null;
      if (match && action.operation === "type") {
        const card = holdOutboundCall(this.#store, request, { tool: "computer_type", subject: action.text, level: "full", providerRevision: 0,
          release: { kind: "computer_confirm", operation: "type", x: null, y: null, text: action.text, keys: null, intent: intent as ComputerIntent, reasons: ["outbound_text"] } }, match, this.#now());
        if (card) { this.#browser.pinCard(projectId, card.id); return cardToolResult(card); }
        return fail("outbound_blocked: the first outbound call is already held for Web approval.");
      }
      await this.#browser.desktopInput(projectId, request.roleId, toInput(action), "agent", signal);
      return { content: JSON.stringify({ done: action.operation, intent }) };
    };
    const definitions: ToolDefinition[] = [
      {
        name: "computer_screenshot", execution: "exclusive", effect: "read-only",
        description: "Capture the box's virtual desktop (1280×800) for the owner's live view. Returns only a screenshot reference.",
        inputSchema: object({}, []),
        execute: guarded(async () => {
          const meta = await this.#browser.captureDesktop(projectId, request.roleId, "agent");
          return { content: JSON.stringify({ screenshot: meta.id, takenAt: new Date(meta.takenAt).toISOString() }) };
        }),
      },
      {
        name: "computer_click", execution: "exclusive", effect: "mutating",
        description: `Click at (x, y) on the box's virtual desktop (0 ≤ x < ${displayWidth}, 0 ≤ y < ${displayHeight}). The owner may require a card for every click.`,
        inputSchema: object({ x: { type: "integer", minimum: 0, maximum: displayWidth - 1 }, y: { type: "integer", minimum: 0, maximum: displayHeight - 1 }, intent: intentSchema }, ["x", "y", "intent"]),
        execute: guarded(async (args, signal) => {
          if (!validPoint(args.x, args.y)) return fail(`x and y must be integers on the ${displayWidth}×${displayHeight} display.`);
          return act({ operation: "click", x: args.x as number, y: args.y as number }, args.intent, signal);
        }),
      },
      {
        name: "computer_type", execution: "exclusive", effect: "mutating",
        description: `Type text on the box's virtual desktop (at most ${maximumTypedChars} characters). Text with a line break presses Enter and always waits for the owner's approval card.`,
        inputSchema: object({ text: { type: "string", maxLength: maximumTypedChars }, intent: intentSchema }, ["text", "intent"]),
        execute: guarded(async (args, signal) => {
          if (!validTypedText(args.text)) return fail(`text must be 1 to ${maximumTypedChars} characters.`);
          return act({ operation: "type", text: args.text }, args.intent, signal);
        }),
      },
      {
        name: "computer_key", execution: "exclusive", effect: "mutating",
        description: `Press keys on the box's virtual desktop: up to ${maximumKeys} xdotool key names or chords like ctrl+l. Return or Enter always waits for the owner's approval card.`,
        inputSchema: object({ keys: { type: "array", minItems: 1, maxItems: maximumKeys, items: { type: "string", pattern: "^[A-Za-z0-9_]{1,32}(\\+[A-Za-z0-9_]{1,32}){0,3}$" } }, intent: intentSchema }, ["keys", "intent"]),
        execute: guarded(async (args, signal) => {
          if (!validKeys(args.keys)) return fail("keys must be 1 to 16 xdotool key names or chords (hex keysyms are refused).");
          return act({ operation: "key", keys: args.keys }, args.intent, signal);
        }),
      },
    ];
    return { definitions, release: () => { if (released) return; released = true; desktop?.release(); } };
  }

  /**
   * The `computer_confirm` performer: sends the approved input once, on the desktop session the card was made on.
   * Nothing is sent when that session closed (`stale`: the screen may show something else now),
   * during a takeover or when the role no longer has `full`; a failure after the input was sent is `unknown`.
   */
  readonly perform: EffectPerformer = async (card, signal, allowed): Promise<EffectOutcome> => {
    const action = (card.action.kind === "outbound_release" ? card.action.release : card.action) as ComputerConfirmAction;
    try {
      if (this.#store.read(tx => takeoverActive(tx, card.projectId))) return { outcome: "failed", reason: "takeover_active", detail: {} };
      if (!this.#browser.cardSessionOpen(card.projectId, card.id)) return { outcome: "failed", reason: "stale", detail: {} };
      if (!allowed() || signal.aborted) return { outcome: "failed", reason: "access_changed", detail: {} };
      const input: ComputerAction = action.operation === "click" ? { operation: "click", x: action.x!, y: action.y! }
        : action.operation === "type" ? { operation: "type", text: action.text! } : { operation: "key", keys: action.keys! };
      await this.#browser.desktopInput(card.projectId, card.roleId, toInput(input), "agent", signal);
      return { outcome: "succeeded", reason: null, detail: { operation: action.operation } };
    } catch (error) {
      // The runner reports whether xdotool ran; a transport failure leaves the outcome unknown.
      const code = codeOf(error, "computer_error");
      return { outcome: ["screen_unavailable", "access_level_insufficient", "execution_halted", "takeover_active"].includes(code) ? "failed" : "unknown", reason: code, detail: {} };
    } finally {
      this.#browser.settleCard(card.projectId, card.id);
    }
  };
}

import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { assertExecutionAllowed } from "./access";

/**
 * app.takeover/v1 (EXE14, ADR 0039) — the owner controls the project box's browser and desktop.
 *
 * `takeover.start` and `takeover.end` are Web only (`takeover_requires_web`; Telegram, the local API and models are
 * refused) and revisioned by the project's takeover revision. While a takeover is active every agent browser and
 * computer tool call — and every approved browser or computer card — fails `takeover_active`. The owner's own input
 * (`takeover.click`, `takeover.type`, `takeover.key`) is Web only and needs the active takeover it names.
 */
export interface TakeoverView { projectId: string; revision: number; active: boolean; takeoverId: string | null; startedAt: number | null; updatedAt: number | null }

/** One owner input into the box's virtual display. Coordinates are display pixels (1280×800). */
export type DesktopInput = { kind: "click"; x: number; y: number } | { kind: "type"; text: string } | { kind: "key"; keys: string[] };

export type TakeoverCommand =
  | { kind: "takeover.start"; requestId: string; projectId: string; expectedRevision: number; payload: Record<string, never> }
  | { kind: "takeover.end"; requestId: string; projectId: string; expectedRevision: number; payload: { takeoverId: string } };
export type TakeoverInputCommand =
  | { kind: "takeover.click"; requestId: string; projectId: string; expectedRevision: number; payload: { takeoverId: string; x: number; y: number } }
  | { kind: "takeover.type"; requestId: string; projectId: string; expectedRevision: number; payload: { takeoverId: string; text: string } }
  | { kind: "takeover.key"; requestId: string; projectId: string; expectedRevision: number; payload: { takeoverId: string; key: string } };
export interface TakeoverReceipt { takeover: TakeoverView }
export interface TakeoverInputReceipt { takeover: TakeoverView; input: DesktopInput["kind"] }

/** The virtual display's size (ADR 0039: Xvfb :99 at 1280×800). */
export const displayWidth = 1280, displayHeight = 800;
/** Most characters of one typed text. */
export const maximumTypedChars = 2000;
/** One xdotool key combination: names joined by `+` (`ctrl+l`, `Return`, `shift+Tab`). */
const keyPattern = /^[A-Za-z0-9_]{1,32}(\+[A-Za-z0-9_]{1,32}){0,3}$/;
/** Most key combinations one key action sends. */
export const maximumKeys = 16;

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const kinds = new Set(["takeover.start", "takeover.end"]);
const inputKinds = new Set(["takeover.click", "takeover.type", "takeover.key"]);
export const isTakeoverCommand = (command: unknown): command is TakeoverCommand => !!command && typeof command === "object" && kinds.has((command as { kind?: unknown }).kind as string);
export const isTakeoverInputCommand = (command: unknown): command is TakeoverInputCommand => !!command && typeof command === "object" && inputKinds.has((command as { kind?: unknown }).kind as string);

/** Validates coordinates on the display (`invalid_desktop_input`). */
export function validPoint(x: unknown, y: unknown): boolean {
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) && (x as number) >= 0 && (x as number) < displayWidth && (y as number) >= 0 && (y as number) < displayHeight;
}
/** Validates one typed text: 1–2000 characters of well-formed text without NUL. */
export function validTypedText(text: unknown): text is string {
  return typeof text === "string" && text.length >= 1 && [...text].length <= maximumTypedChars && text.isWellFormed() && !text.includes("\u0000");
}
/** Validates key combinations (`Return`, `ctrl+a`); at most {@link maximumKeys}. */
export function validKeys(keys: unknown): keys is string[] {
  return Array.isArray(keys) && keys.length >= 1 && keys.length <= maximumKeys && keys.every(key => typeof key === "string" && keyPattern.test(key));
}

/** Validates the exact shape (`invalid_takeover_command`) and returns the receipt identity. */
export function takeoverCommandIdentity(command: TakeoverCommand | TakeoverInputCommand): string {
  const invalid = () => new AppError("invalid_takeover_command");
  if ((!isTakeoverCommand(command) && !isTakeoverInputCommand(command)) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw invalid();
  requireId(command.projectId);
  const p = command.payload as Record<string, unknown>;
  if (command.kind === "takeover.start") { if (!exact(p, [])) throw invalid(); }
  else if (command.kind === "takeover.end") { if (!exact(p, ["takeoverId"])) throw invalid(); requireId(p.takeoverId); }
  else if (command.kind === "takeover.click") { if (!exact(p, ["takeoverId", "x", "y"]) || !validPoint(p.x, p.y)) throw invalid(); requireId(p.takeoverId); }
  else if (command.kind === "takeover.type") { if (!exact(p, ["takeoverId", "text"]) || !validTypedText(p.text)) throw invalid(); requireId(p.takeoverId); }
  else { if (!exact(p, ["takeoverId", "key"]) || !validKeys([p.key])) throw invalid(); requireId(p.takeoverId); }
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, p]);
}

/** The project's takeover state (revision 0, inactive, before any). */
export function readTakeover(tx: AppTransaction, projectId: string): TakeoverView {
  const row = tx.get<{ revision: number; takeover_id: string; state: string; created_at: number }>(
    "SELECT revision, takeover_id, state, created_at FROM takeover_sessions WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
  if (!row) return { projectId, revision: 0, active: false, takeoverId: null, startedAt: null, updatedAt: null };
  const active = row.state === "active";
  return { projectId, revision: row.revision, active, takeoverId: active ? row.takeover_id : null, startedAt: active ? row.created_at : null, updatedAt: row.created_at };
}

/** True while the owner holds a takeover of the project: agent browser and computer input must fail `takeover_active`. */
export function takeoverActive(tx: AppTransaction, projectId: string): boolean {
  return readTakeover(tx, projectId).active;
}

/** Web only (`takeover_requires_web`, 403). */
export function requireTakeoverChannel(channel: string): void {
  if (channel !== "web") throw new AppError("takeover_requires_web", 403);
}

/**
 * Applies `takeover.start` or `takeover.end` in the caller's transaction. Start needs no active takeover
 * (`takeover_active`) and a project at `workspace` or above (there is no box below it); end needs the active one it
 * names (`takeover_not_active`). `expectedRevision` is the takeover revision.
 */
export function applyTakeoverCommand(tx: AppTransaction, command: TakeoverCommand, channel: string, now: number): TakeoverView {
  requireTakeoverChannel(channel);
  const current = readTakeover(tx, command.projectId);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (command.kind === "takeover.start") {
    if (current.active) throw new AppError("takeover_active", 409);
    assertExecutionAllowed(tx, command.projectId, null, "workspace");
    tx.run("INSERT INTO takeover_sessions (project_id, revision, takeover_id, state, channel, created_at) VALUES (?, ?, ?, 'active', 'web', ?)",
      command.projectId, current.revision + 1, crypto.randomUUID(), now);
  } else {
    if (!current.active || current.takeoverId !== command.payload.takeoverId) throw new AppError("takeover_not_active", 409);
    tx.run("INSERT INTO takeover_sessions (project_id, revision, takeover_id, state, channel, created_at) VALUES (?, ?, ?, 'ended', 'web', ?)",
      command.projectId, current.revision + 1, current.takeoverId, now);
  }
  return readTakeover(tx, command.projectId);
}

/** The desktop input of an owner input command, after checking the takeover it names is active (`takeover_not_active`). */
export function takeoverInput(tx: AppTransaction, command: TakeoverInputCommand, channel: string): DesktopInput {
  requireTakeoverChannel(channel);
  const current = readTakeover(tx, command.projectId);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (!current.active || current.takeoverId !== command.payload.takeoverId) throw new AppError("takeover_not_active", 409);
  if (command.kind === "takeover.click") return { kind: "click", x: command.payload.x, y: command.payload.y };
  if (command.kind === "takeover.type") return { kind: "type", text: command.payload.text };
  return { kind: "key", keys: [command.payload.key] };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/**
 * The exact `xdotool` command of one desktop input on display `:99` (run through the box runner). Inputs are
 * validated again here; a value that fails is `invalid_desktop_input`.
 */
export function xdotoolCommand(input: DesktopInput): string {
  const head = "DISPLAY=:99 xdotool";
  if (input.kind === "click") {
    if (!validPoint(input.x, input.y)) throw new AppError("invalid_desktop_input");
    return `${head} mousemove --sync ${input.x} ${input.y} click 1`;
  }
  if (input.kind === "type") {
    if (!validTypedText(input.text)) throw new AppError("invalid_desktop_input");
    return `${head} type --delay 12 -- ${quote(input.text)}`;
  }
  if (!validKeys(input.keys)) throw new AppError("invalid_desktop_input");
  return `${head} key --delay 12 -- ${input.keys.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Screenshot store (for the live view, EXE15)
// ---------------------------------------------------------------------------

/** Metadata of one stored screenshot: no URL, title or page text, so nothing typed into a page leaks through it. */
export interface ScreenshotMeta { id: string; projectId: string; takenAt: number; source: "agent" | "owner"; mime: "image/png"; bytes: number }

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Most bytes of one stored screenshot. */
export const screenshotBytes = 2_097_152;
/** Screenshots kept per project; the oldest is evicted first. */
export const screenshotRing = 20;

/**
 * The bounded in-memory screenshot ring per project. Images never reach SQLite, a backup or a log; a restart or a
 * box reset forgets them.
 */
export class ScreenshotStore {
  readonly #rings = new Map<string, { meta: ScreenshotMeta; data: Uint8Array }[]>();
  constructor(readonly limit = screenshotRing, readonly maxBytes = screenshotBytes) {}

  /** Stores one PNG (`screenshot_invalid` for anything else or over the byte bound) and evicts beyond the ring. */
  put(projectId: string, data: Uint8Array, source: ScreenshotMeta["source"], now: number): ScreenshotMeta {
    requireId(projectId);
    if (data.length < 8 || data.length > this.maxBytes || pngSignature.some((byte, index) => data[index] !== byte)) throw new AppError("screenshot_invalid", 422);
    const meta: ScreenshotMeta = { id: crypto.randomUUID(), projectId, takenAt: now, source, mime: "image/png", bytes: data.length };
    const ring = this.#rings.get(projectId) ?? [];
    ring.push({ meta, data: data.slice() });
    while (ring.length > this.limit) ring.shift();
    this.#rings.set(projectId, ring);
    return meta;
  }

  /** The project's screenshots, newest first. */
  list(projectId: string): ScreenshotMeta[] { return [...(this.#rings.get(projectId) ?? [])].reverse().map(item => ({ ...item.meta })); }

  /** One screenshot, or null when it was evicted or never existed. */
  get(projectId: string, id: string): { meta: ScreenshotMeta; data: Uint8Array } | null {
    const found = this.#rings.get(projectId)?.find(item => item.meta.id === id);
    return found ? { meta: { ...found.meta }, data: found.data.slice() } : null;
  }

  /** Forgets every screenshot of the project (box reset). */
  clear(projectId: string): void { this.#rings.delete(projectId); }
}

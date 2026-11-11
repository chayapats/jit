import type { QmpCommand } from "./qmp";
import { vmFail } from "./validation";

/** Fixed framebuffer of a desktop working VM (`s16-computer-screen/v1`). Owner coordinates are display pixels. */
export const vmScreenWidth = 1280, vmScreenHeight = 800;
/** Most characters of one typed text. */
export const vmScreenMaxText = 512;
/** Most keys of one key combination. */
export const vmScreenMaxKeys = 4;
/** Largest accepted PNG frame. A 1280×800 desktop is far smaller; anything larger is refused, never truncated. */
export const vmScreenMaxFrameBytes = 8 * 1_048_576;

/**
 * One owner input to the working VM's virtual display. Text is limited to characters a US keyboard types
 * (`screen_text_unsupported` otherwise); the value is sent once and never stored, logged or hashed.
 */
export type VmScreenInput =
  | { kind: "click"; x: number; y: number; button: "left" | "right" | "middle"; double: boolean }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; delta: number }
  | { kind: "key"; keys: string[] }
  | { kind: "text"; text: string };

/** Structural guard: a manager with a host-side screen (the local QEMU manager). */
export function isVmScreenManagement(manager: unknown): manager is { screen(): VmScreenDevice } {
  return !!manager && typeof (manager as { screen?: unknown }).screen === "function";
}
/** Host-side screen of one VM. Frames and input go through the controller-only QMP socket, never the guest network. */
export interface VmScreenDevice {
  /** Null when this VM can show a desktop now, else the stable reason (`vm_desktop_unavailable`, `vm_not_running`). */
  unavailable(): Promise<string | null>;
  /** One PNG frame of the current display. */
  capture(signal?: AbortSignal): Promise<Uint8Array>;
  /** Sends one input; resolves after QEMU accepted every event. */
  send(input: VmScreenInput): Promise<void>;
}

const named = Object.freeze(["ctrl", "shift", "alt", "meta", "ret", "esc", "tab", "backspace", "delete", "insert", "home", "end", "pgup", "pgdn",
  "up", "down", "left", "right", "spc", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"] as const);
/** Accepted key names: the named keys above plus one lowercase letter or digit. They are QEMU qcodes as is. */
export function vmScreenKey(key: unknown): key is string {
  return typeof key === "string" && ((named as readonly string[]).includes(key) || /^[a-z0-9]$/.test(key));
}
const plain: Record<string, string> = { " ": "spc", "\n": "ret", "\t": "tab", "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right",
  "\\": "backslash", ";": "semicolon", "'": "apostrophe", "`": "grave_accent", ",": "comma", ".": "dot", "/": "slash" };
const shifted: Record<string, string> = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "minus", "+": "equal", "{": "bracket_left", "}": "bracket_right", "|": "backslash", ":": "semicolon", "\"": "apostrophe", "~": "grave_accent",
  "<": "comma", ">": "dot", "?": "slash" };
/** The qcode and shift state for one character a US keyboard types, or null. */
export function vmScreenChar(char: string): { key: string; shift: boolean } | null {
  if (/^[a-z0-9]$/.test(char)) return { key: char, shift: false };
  if (/^[A-Z]$/.test(char)) return { key: char.toLowerCase(), shift: true };
  if (plain[char]) return { key: plain[char]!, shift: false };
  if (shifted[char]) return { key: shifted[char]!, shift: true };
  return null;
}

const point = (x: unknown, y: unknown) => Number.isSafeInteger(x) && Number.isSafeInteger(y) && (x as number) >= 0 && (x as number) < vmScreenWidth && (y as number) >= 0 && (y as number) < vmScreenHeight;
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
/** Validates one input's exact shape and bounds (`invalid_screen_input`, `screen_text_unsupported`). */
export function vmScreenInput(value: unknown): VmScreenInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) vmFail("invalid_screen_input");
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "click": if (exactKeys(v, ["kind", "x", "y", "button", "double"]) && point(v.x, v.y) && ["left", "right", "middle"].includes(v.button as string) && typeof v.double === "boolean") return v as VmScreenInput; break;
    case "move": if (exactKeys(v, ["kind", "x", "y"]) && point(v.x, v.y)) return v as VmScreenInput; break;
    case "scroll": if (exactKeys(v, ["kind", "x", "y", "delta"]) && point(v.x, v.y) && Number.isSafeInteger(v.delta) && v.delta !== 0 && Math.abs(v.delta as number) <= 10) return v as VmScreenInput; break;
    case "key": if (exactKeys(v, ["kind", "keys"]) && Array.isArray(v.keys) && v.keys.length >= 1 && v.keys.length <= vmScreenMaxKeys && v.keys.every(vmScreenKey) && new Set(v.keys).size === v.keys.length) return v as VmScreenInput; break;
    case "text": {
      if (!exactKeys(v, ["kind", "text"]) || typeof v.text !== "string" || !v.text.length || [...v.text].length > vmScreenMaxText || !v.text.isWellFormed()) break;
      if ([...v.text].some(char => !vmScreenChar(char))) vmFail("screen_text_unsupported", 422);
      return v as VmScreenInput;
    }
  }
  return vmFail("invalid_screen_input");
}

/** QEMU absolute axes run 0..32767 across the display. */
const axis = (value: number, size: number) => Math.round(value * 32767 / (size - 1));
const keyEvent = (key: string, down: boolean) => ({ type: "key", data: { down, key: { type: "qcode", data: key } } });
const button = (name: string, down: boolean) => ({ type: "btn", data: { down, button: name } });
const move = (x: number, y: number) => [{ type: "abs", data: { axis: "x", value: axis(x, vmScreenWidth) } }, { type: "abs", data: { axis: "y", value: axis(y, vmScreenHeight) } }];
const send = (events: unknown[]): QmpCommand => ({ execute: "input-send-event", arguments: { events } });

/**
 * The exact QMP commands for one validated input, in order. Each command is one press/release batch, so a
 * key is never left held between commands. No guest or model text is interpreted here; text is mapped to qcodes.
 */
export function vmScreenCommands(input: VmScreenInput): QmpCommand[] {
  switch (input.kind) {
    case "move": return [send(move(input.x, input.y))];
    case "click": {
      const once = [button(input.button, true), button(input.button, false)];
      return [send(move(input.x, input.y)), send(once), ...(input.double ? [send(once)] : [])];
    }
    case "scroll": {
      const name = input.delta < 0 ? "wheel-up" : "wheel-down";
      return [send(move(input.x, input.y)), ...Array.from({ length: Math.abs(input.delta) }, () => send([button(name, true), button(name, false)]))];
    }
    case "key": return [send([...input.keys.map(key => keyEvent(key, true)), ...[...input.keys].reverse().map(key => keyEvent(key, false))])];
    case "text": return [...input.text].map(char => {
      const mapped = vmScreenChar(char)!;
      return send(mapped.shift ? [keyEvent("shift", true), keyEvent(mapped.key, true), keyEvent(mapped.key, false), keyEvent("shift", false)] : [keyEvent(mapped.key, true), keyEvent(mapped.key, false)]);
    });
  }
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Accepts only a bounded PNG whose IHDR matches the fixed display size (`vm_screen_invalid`). */
export function vmScreenFrame(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 33 || bytes.length > vmScreenMaxFrameBytes || pngSignature.some((byte, index) => bytes[index] !== byte)) vmFail("vm_screen_invalid", 502);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR" || view.getUint32(16) !== vmScreenWidth || view.getUint32(20) !== vmScreenHeight) vmFail("vm_screen_invalid", 502);
  return bytes;
}

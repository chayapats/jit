import { describeElementFunction, selectOptionFunction } from "../../src/exec/browser";
import type { BoxStream } from "../../src/exec/box-runtime";

/** One element of a fixture page. `form` names the form it belongs to; `field` is its form field name. */
export interface FixtureElement { id: number; role: string; name: string; tag: string; type?: string; form?: string; field?: string; parent?: number; options?: string[] }
export interface FixturePage { url: string; title: string; elements: FixtureElement[] }

/** A PNG the fake browser "captures": the signature and a few bytes. */
export const fakePng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/**
 * A fake Chromium behind the jit.box.cdp-stream/v1 relay: NUL-framed CDP over a {@link BoxStream}, answering from
 * fixture pages. It records every input it receives as `actions` (`click e5`, `type e3 hello`, `key e3 Enter`,
 * `select e7 b`), so tests prove what reached the page and what did not.
 */
export class FakeCdp {
  readonly pages = new Map<string, FixturePage>();
  readonly actions: string[] = [];
  readonly streams: { closed: boolean; close(): void }[] = [];
  /** Methods that never answer (deadline tests). */
  readonly hang = new Set<string>();
  /** When set, the next answer is padded past 1 MiB (framing cap test). */
  oversizeNext = false;
  current: FixturePage = { url: "about:blank", title: "", elements: [] };
  #focused = 0;

  constructor(pages: FixturePage[] = []) { for (const page of pages) this.pages.set(page.url, page); }

  /** Streams still open. */
  open(): number { return this.streams.filter(stream => !stream.closed).length; }

  stream(): BoxStream {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { exit = resolve; });
    const state = { closed: false, close: () => {} };
    const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const emit = (message: Record<string, unknown>) => {
      if (state.closed) return;
      const bytes = new TextEncoder().encode(JSON.stringify(message));
      const framed = new Uint8Array(bytes.length + 1); framed.set(bytes);
      controller.enqueue(framed);
    };
    let buffer = "";
    const close = () => {
      if (state.closed) return;
      state.closed = true;
      try { controller.close(); } catch { /* Already closed. */ }
      exit(-1);
    };
    state.close = close;
    this.streams.push(state);
    return {
      write: bytes => {
        if (state.closed) throw new Error("closed");
        buffer += new TextDecoder().decode(bytes);
        for (let end = buffer.indexOf("\u0000"); end >= 0; end = buffer.indexOf("\u0000")) {
          const command = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
          buffer = buffer.slice(end + 1);
          if (this.hang.has(command.method)) continue;
          queueMicrotask(() => {
            const answer = this.#answer(command, emit);
            if (this.oversizeNext) { this.oversizeNext = false; emit({ id: command.id, result: { pad: "x".repeat(1_100_000) } }); return; }
            emit("error" in answer ? { id: command.id, error: answer.error } : { id: command.id, result: answer.result });
            if (command.method === "Page.navigate") emit({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: command.sessionId });
          });
        }
      },
      stdout, exited, close,
    };
  }

  #element(id: unknown): FixtureElement | undefined { return this.current.elements.find(element => element.id === id); }

  #describe(element: FixtureElement) {
    const type = element.type ?? "";
    const submits = (element.tag === "button" && (type === "submit" || (type === "" && !!element.form))) || (element.tag === "input" && (type === "submit" || type === "image"));
    const fields = element.form ? this.current.elements.filter(other => other.form === element.form && other.field).map(other => other.field!) : [];
    return { tag: element.tag, type, name: element.name, inForm: !!element.form, submits, password: type === "password", fields, url: this.current.url };
  }

  #answer(command: { method: string; params: Record<string, unknown> }, emit: (message: Record<string, unknown>) => void): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
    const p = command.params;
    switch (command.method) {
      case "Target.getTargets": return { result: { targetInfos: [{ targetId: "page-1", type: "page" }] } };
      case "Target.attachToTarget": return { result: { sessionId: "session-1" } };
      case "Target.getTargetInfo": return { result: { targetInfo: { targetId: "page-1", url: this.current.url, title: this.current.title } } };
      case "Page.enable": case "DOM.enable": case "Runtime.enable": case "DOM.scrollIntoViewIfNeeded": return { result: {} };
      case "Page.navigate": {
        const url = String(p.url);
        this.current = this.pages.get(url) ?? { url, title: "", elements: [] };
        return { result: { frameId: "frame-1" } };
      }
      case "Accessibility.getFullAXTree": {
        const top = this.current.elements.filter(element => element.parent === undefined).map(element => String(element.id));
        const nodes = [{ nodeId: "root", role: { value: "RootWebArea" }, name: { value: this.current.title }, childIds: top },
          ...this.current.elements.map(element => ({ nodeId: String(element.id), role: { value: element.role }, name: { value: element.name }, backendDOMNodeId: element.id,
            parentId: element.parent === undefined ? "root" : String(element.parent),
            childIds: this.current.elements.filter(child => child.parent === element.id).map(child => String(child.id)) }))];
        return { result: { nodes } };
      }
      case "DOM.resolveNode": return this.#element(p.backendNodeId) ? { result: { object: { objectId: `obj-${p.backendNodeId}` } } } : { error: { code: -32000, message: "No node" } };
      case "Runtime.callFunctionOn": {
        const element = this.#element(Number(String(p.objectId).slice(4)));
        if (!element) return { error: { code: -32000, message: "No object" } };
        if (p.functionDeclaration === describeElementFunction) return { result: { result: { type: "object", value: this.#describe(element) } } };
        if (p.functionDeclaration === selectOptionFunction) {
          const value = String((p.arguments as { value: unknown }[])[0]!.value);
          const ok = element.tag === "select" && (element.options ?? []).includes(value);
          if (ok) this.actions.push(`select e${element.id} ${value}`);
          return { result: { result: { type: "boolean", value: ok } } };
        }
        return { error: { code: -32000, message: "Unknown function" } };
      }
      case "DOM.getBoxModel": {
        const id = Number(p.backendNodeId), x = id * 10;
        return this.#element(id) ? { result: { model: { content: [x, 0, x + 10, 0, x + 10, 10, x, 10] } } } : { error: { code: -32000, message: "No node" } };
      }
      case "Input.dispatchMouseEvent":
        if (p.type === "mouseReleased") this.actions.push(`click e${Math.round((Number(p.x) - 5) / 10)}`);
        return { result: {} };
      case "DOM.focus": this.#focused = Number(p.backendNodeId); return { result: {} };
      case "Input.insertText": this.actions.push(`type e${this.#focused} ${String(p.text)}`); return { result: {} };
      case "Input.dispatchKeyEvent":
        if (p.type === "keyDown") this.actions.push(`key e${this.#focused} ${String(p.key)}`);
        return { result: {} };
      case "Page.captureScreenshot": return { result: { data: Buffer.from(fakePng).toString("base64") } };
      default:
        void emit;
        return { error: { code: -32601, message: `Unknown method ${command.method}` } };
    }
  }
}

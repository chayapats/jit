import { vmFail } from "./validation";

const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
});

/** Spaces SSH connection starts without holding a lock during guest execution or retrying a command. */
export class VmSshDialGate {
  readonly #entries = new Map<string, { next: number; pending: number }>();
  constructor(readonly clock = () => performance.now(), readonly pause = wait) {}
  /** Queue time consumes the original transport deadline; cancelled/expired entries never start. */
  async start<T>(key: string, timeoutMs: number, signal: AbortSignal | undefined, invoke: (remainingMs: number) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const began = this.clock();
    for (const [id, entry] of this.#entries) if (!entry.pending && entry.next <= began) this.#entries.delete(id);
    if (!this.#entries.has(key) && this.#entries.size >= 128) vmFail("vm_limit_exhausted");
    const entry = this.#entries.get(key) ?? { next: began, pending: 0 };
    if (entry.pending >= 32) vmFail("vm_limit_exhausted");
    const due = Math.max(began, entry.next);
    if (due - began >= timeoutMs) vmFail("vm_transport_timeout");
    entry.next = due + 100; entry.pending++; this.#entries.set(key, entry);
    try {
      if (due > began) await this.pause(due - began, signal);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const remaining = Math.floor(timeoutMs - (this.clock() - began));
      if (remaining <= 0) vmFail("vm_transport_timeout");
      return await invoke(remaining);
    } finally { entry.pending--; }
  }
}

/** Shared only by protected SSH transports; execution itself remains concurrent. */
export const vmSshDialGate = new VmSshDialGate();

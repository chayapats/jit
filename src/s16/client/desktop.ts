/** Non-private delivery state; no application facts or authority are obtained from the worker. */
export interface DesktopStatus { state: "unsupported" | "preparing" | "ready" | "update" | "unavailable"; release: string | null }

/** Read-only worker handshake. A mutable Cache Storage entry cannot establish that the current worker is ready. */
export async function desktopWorkerStatus(worker: ServiceWorker): Promise<{ id: string; ready: boolean } | null> {
  const channel = new MessageChannel();
  return new Promise(resolve => {
    const finish = (value: { id: string; ready: boolean } | null) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value); };
    const timer = setTimeout(() => finish(null), 3000);
    channel.port1.onmessage = event => {
      const value = event.data;
      finish(value?.contract === "s16-desktop-status/v1" && typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) && typeof value.ready === "boolean" ? { id: value.id, ready: value.ready } : null);
    };
    try { worker.postMessage({ type: "jit-desktop-status" }, [channel.port2]); } catch { finish(null); }
  });
}

/**
 * Registers the existing exact-origin worker without prompting any native permission. Updates wait for existing
 * windows to close; this observer cannot skipWaiting, reload, send work, read credentials or approve an action.
 */
export function observeDesktop(changed: (state: DesktopStatus) => void): () => void {
  let closed = false, generation = 0;
  const cleanup: (() => void)[] = [], publish = (state: DesktopStatus) => { if (!closed) changed(state); };
  if (!globalThis.isSecureContext || !navigator.serviceWorker) { publish({ state: "unsupported", release: null }); return () => { closed = true; }; }
  const listen = (target: EventTarget, type: string, listener: EventListener) => { target.addEventListener(type, listener); cleanup.push(() => target.removeEventListener(type, listener)); };
  let registration: ServiceWorkerRegistration | null = null;
  const read = async () => {
    if (closed || !registration) return; const turn = ++generation;
    const active = registration.active, result = active ? await desktopWorkerStatus(active) : null;
    if (closed || turn !== generation) return;
    publish({ state: registration.waiting ? "update" : result?.ready ? "ready" : registration.installing ? "preparing" : "unavailable", release: result?.id ?? null });
  };
  const watchInstalling = () => { const worker = registration?.installing; if (worker) listen(worker, "statechange", () => { void read(); }); void read(); };
  publish({ state: "preparing", release: null });
  void navigator.serviceWorker.register("/s16/sw.js", { scope: "/s16/", type: "classic", updateViaCache: "none" }).then(value => {
    if (closed) return; registration = value;
    listen(value, "updatefound", watchInstalling); listen(navigator.serviceWorker, "controllerchange", () => { void read(); }); watchInstalling();
  }).catch(() => publish({ state: "unavailable", release: null }));
  return () => { closed = true; generation++; for (const remove of cleanup) remove(); };
}

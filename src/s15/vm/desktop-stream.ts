import { homedir } from "node:os";
import { AppError } from "../../errors";
import type { BoxStream } from "../../exec/box-runtime";
import { vmSshArgs, vmQuote } from "./host";
import type { VmEndpoint } from "./types";

export const desktopHandshakeMs = 10_000;
export type DesktopStreamSpawn = (argv: string[]) => BoxStream;
/** Dedicated pipes, never VmSshTransport.control/invoke or the bounded one-shot host runner. */
const spawnStream: DesktopStreamSpawn = argv => {
  const proc = Bun.spawn(argv, { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: homedir(), LANG: "C" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { void Promise.resolve(proc.stdin.end()).catch(() => {}); } catch { /* already exited */ } proc.kill("SIGKILL"); };
  // Discard, do not accumulate or mix SSH/sudo diagnostics into the protocol.
  void (async () => { try { for await (const _ of proc.stderr) { /* drain */ } } catch { /* killed */ } })();
  return { write(bytes) { if (closed) throw new AppError("cdp_closed", 502); proc.stdin.write(bytes); void Promise.resolve(proc.stdin.flush()).catch(close); },
    stdout: proc.stdout, exited: proc.exited, close };
};

/** Consume exactly the non-CDP handshake, preserving bytes coalesced after its NUL. */
export async function vmDesktopCdpStream(endpoint: VmEndpoint, options: { signal?: AbortSignal; spawn?: DesktopStreamSpawn; handshakeMs?: number } = {}): Promise<BoxStream> {
  if (options.signal?.aborted) throw new AppError("cancelled", 409);
  const stream = (options.spawn ?? spawnStream)([...vmSshArgs(endpoint), ["sudo", "-n", "-u", "jit-desktop", "/usr/local/lib/jit-desktop/cdp-attach"].map(vmQuote).join(" ")]);
  const iterator = stream.stdout[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { stream.close(); rejectAbort(new AppError("cancelled", 409)); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const handshake = async () => {
      let bytes = Buffer.alloc(0);
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new AppError("computer_browser_unavailable", 503);
        bytes = Buffer.concat([bytes, next.value]);
        const end = bytes.indexOf(0);
        if (end < 0 && bytes.length <= 64) continue;
        if (end < 0 || end > 64) throw new AppError("computer_browser_unavailable", 503);
        const frame = bytes.subarray(0, end).toString();
        if (frame === '{"jit":"busy"}') throw new AppError("computer_browser_busy", 409);
        if (frame !== '{"jit":"attached"}') throw new AppError("computer_browser_unavailable", 503);
        const tail = bytes.subarray(end + 1);
        return { ...stream, stdout: (async function* () { if (tail.length) yield tail; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; } })() };
      }
    };
    return await Promise.race([handshake(), cancelled, new Promise<never>((_, reject) => { timer = setTimeout(() => { stream.close(); reject(new AppError("computer_browser_unavailable", 503)); }, options.handshakeMs ?? desktopHandshakeMs); })]);
  } catch (error) { stream.close(); throw error; }
  finally { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

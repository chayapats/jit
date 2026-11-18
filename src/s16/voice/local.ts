import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../../errors';
import { captureWavInfo } from './wav';

/** Operator-supplied trusted artifact. A hash pin is not a sandbox or a dependency-tree attestation. */
export interface VoiceArtifact { path: string; sha256: string }
/** Explicit local-only route: no URL, provider credential, shell command, custom flags or fallback. */
export interface LocalVoiceConfig {
  transcription: { executable: VoiceArtifact; model: VoiceArtifact; language: string };
  synthesis: { kind: 'espeak' | 'say'; executable: VoiceArtifact; voice: string };
  timeoutMs: number;
}
/** Host-only final checks and durable process-start accounting; never supplied by a client/model. */
export interface VoiceProcessContext { signal: AbortSignal; guard(): void; started(): void }
/** Finite local adapter. Raw audio/text stays in memory/private scratch; errors contain safe codes only. */
export interface LocalVoiceEngine {
  available(): Promise<boolean>;
  transcribe(wav: Uint8Array, context: VoiceProcessContext): Promise<string>;
  synthesize(text: string, context: VoiceProcessContext): Promise<{ wav: Uint8Array; durationMs: number }>;
  close(): Promise<void>;
}
/** Local synthesis/output bounds, independent of owner-configured quota. */
export const localSpeechLimits = Object.freeze({ textCharacters: 2000, textBytes: 8192, transcriptBytes: 16384, audioBytes: 4 * 1024 * 1024, durationMs: 60000 });
const reject = (code: string): never => { throw new AppError(code, 503); };
const record = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === keys.sort().join();
const artifact = (value: unknown): value is VoiceArtifact => record(value, ['path', 'sha256']) && typeof value.path === 'string' && isAbsolute(value.path) && resolve(value.path) === value.path && !/[\x00-\x1f\x7f]/.test(value.path) && value.path.length < 2048 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);

/** Dependency-free configuration shape validation; actual regular-file hashes are checked before every process. */
export function validateLocalVoiceConfig(value: unknown): asserts value is LocalVoiceConfig {
  if (!record(value, ['transcription', 'synthesis', 'timeoutMs']) || !record(value.transcription, ['executable', 'model', 'language']) || !record(value.synthesis, ['kind', 'executable', 'voice'])
    || !artifact(value.transcription.executable) || !artifact(value.transcription.model) || !artifact(value.synthesis.executable)
    || typeof value.transcription.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$|^auto$/.test(value.transcription.language)
    || !['espeak', 'say'].includes(value.synthesis.kind as string) || typeof value.synthesis.voice !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(value.synthesis.voice)
    || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 120000) throw new AppError('invalid_voice_config');
}

async function verifyArtifact(value: VoiceArtifact, executable: boolean, signal: AbortSignal): Promise<void> {
  if (await realpath(value.path) !== value.path) reject('voice_artifact_changed');
  const handle = await open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > (executable ? 256 * 1024 * 1024 : 1024 * 1024 * 1024) || stat.mode & 0o022 || executable && !(stat.mode & 0o111)) reject('voice_artifact_changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let total = 0;
    for (;;) { signal.throwIfAborted(); const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; total += read.bytesRead; if (total > stat.size) reject('voice_artifact_changed'); hash.update(buffer.subarray(0, read.bytesRead)); }
    if (total !== stat.size || hash.digest('hex') !== value.sha256) reject('voice_artifact_changed');
  } finally { await handle.close(); }
}

/** Validate bounded PCM WAV output, allowing the ordinary padded RIFF chunks emitted by local synthesizers. */
export function speechWavInfo(bytes: Uint8Array): { durationMs: number } {
  const invalid = () => reject('voice_audio_invalid');
  if (bytes.length < 46 || bytes.length > localSpeechLimits.audioBytes) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) !== bytes.length - 8) return invalid();
  let at = 12, format: { rate: number; alignment: number } | undefined, size: number | undefined, chunks = 0;
  while (at < bytes.length) {
    if (++chunks > 32 || at + 8 > bytes.length) return invalid();
    const kind = tag(at), length = view.getUint32(at + 4, true), start = at + 8, end = start + length;
    if (end > bytes.length) return invalid();
    if (kind === 'fmt ') {
      if (format || length !== 16 && length !== 18 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 || view.getUint16(start + 14, true) !== 16) return invalid();
      const rate = view.getUint32(start + 4, true), alignment = view.getUint16(start + 12, true);
      if (rate < 8000 || rate > 48000 || alignment !== 2 || view.getUint32(start + 8, true) !== rate * alignment || length === 18 && view.getUint16(start + 16, true) !== 0) return invalid();
      format = { rate, alignment };
    } else if (kind === 'data') { if (size !== undefined || !length || length % 2) return invalid(); size = length; }
    else if (!['JUNK', 'LIST', 'fact'].includes(kind)) return invalid();
    at = end + length % 2;
  }
  if (at !== bytes.length || !format || !size) return invalid();
  const durationMs = size / format.alignment / format.rate * 1000;
  if (durationMs > localSpeechLimits.durationMs) reject('voice_audio_limit');
  return { durationMs };
}

/** Open an opt-in protected-host adapter; no process/model download or speech starts while checking availability. */
export async function openLocalVoice(configured: LocalVoiceConfig, scratchPath: string): Promise<LocalVoiceEngine> {
  validateLocalVoiceConfig(configured); const config = structuredClone(configured);
  if (!isAbsolute(scratchPath) || resolve(scratchPath) !== scratchPath) throw new AppError('invalid_voice_config');
  await mkdir(scratchPath, { recursive: true, mode: 0o700 });
  if (await realpath(scratchPath) !== scratchPath || (await lstat(scratchPath)).mode & 0o077) throw new AppError('invalid_voice_config');
  const shutdown = new AbortController(), jobs = new Set<Promise<unknown>>(); let closed = false;
  const verify = async (signal: AbortSignal) => { if (config.synthesis.kind === 'say' && process.platform !== 'darwin') reject('voice_engine_unavailable'); await verifyArtifact(config.transcription.executable, true, signal); await verifyArtifact(config.transcription.model, false, signal); await verifyArtifact(config.synthesis.executable, true, signal); };
  const job = <T>(context: VoiceProcessContext, body: (directory: string, context: VoiceProcessContext) => Promise<T>): Promise<T> => {
    const signal = AbortSignal.any([context.signal, shutdown.signal]), check = () => { if (closed || signal.aborted) reject('voice_cancelled'); context.guard(); };
    const running = (async () => {
      let directory: string | undefined;
      try { check(); await verify(signal); check(); directory = await mkdtemp(join(scratchPath, 'localvoice-')); await chmod(directory, 0o700); check(); return await body(directory, { ...context, signal, guard: check }); }
      catch (error) { if (signal.aborted) return reject('voice_cancelled'); if (error instanceof AppError) throw error; return reject('voice_engine_unavailable'); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    })();
    jobs.add(running); void running.then(() => jobs.delete(running), () => jobs.delete(running)); return running;
  };
  const execute = async (argv: string[], directory: string, output: string, bytes: number, context: VoiceProcessContext) => {
    context.guard();
    const worker = Bun.spawn([process.execPath, new URL('./local-worker.ts', import.meta.url).pathname, '--local-voice-worker'], { cwd: directory, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: directory } });
    const stop = () => { try { worker.stdin.end(); } catch { /* The worker may have exited already. */ } };
    context.signal.addEventListener('abort', stop, { once: true });
    try {
      context.guard(); context.started(); context.guard();
      worker.stdin.write(JSON.stringify({ argv, cwd: directory, timeoutMs: config.timeoutMs, output, bytes }) + '\n');
      const [code, raw] = await Promise.all([worker.exited, new Response(worker.stdout).text()]);
      context.guard();
      const state = code === 0 && raw.length < 256 ? (JSON.parse(raw) as { state?: string }).state : 'failed';
      if (state !== 'completed') reject(state === 'timeout' ? 'voice_process_timeout' : state === 'limit' ? 'voice_audio_limit' : state === 'cancelled' ? 'voice_cancelled' : 'voice_engine_unavailable');
    } finally { context.signal.removeEventListener('abort', stop); stop(); await worker.exited; }
  };
  const boundedFile = async (path: string, max: number) => { const stat = await lstat(path); if (!stat.isFile() || stat.size < 1 || stat.size > max) reject('voice_audio_limit'); const bytes = await readFile(path); if (bytes.length !== stat.size || bytes.length > max) reject('voice_audio_limit'); return bytes; };
  return {
    async available() { if (closed) return false; try { await verify(shutdown.signal); return !closed; } catch { return false; } },
    transcribe(input, context) {
      const wav = input.slice(); captureWavInfo(wav);
      return job(context, async (directory, current) => {
        const source = join(directory, 'input.wav'), prefix = join(directory, 'transcript'), output = prefix + '.json';
        await writeFile(source, wav, { mode: 0o600 }); current.guard();
        await execute([config.transcription.executable.path, '--model', config.transcription.model.path, '--file', source, '--language', config.transcription.language, '--no-gpu', '--threads', '2', '--processors', '1', '--output-json', '--output-file', prefix, '--no-prints', '--no-timestamps'], directory, output, 131072, current);
        const parsed = JSON.parse((await boundedFile(output, 131072)).toString('utf8')) as { transcription?: { text?: unknown }[] };
        const rows = parsed.transcription;
        if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !row || typeof row.text !== 'string')) return reject('voice_transcript_invalid');
        const text = rows.map(row => row.text).join('').trim();
        if (!text || !text.isWellFormed() || Buffer.byteLength(text) > localSpeechLimits.transcriptBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) reject('voice_transcript_invalid');
        current.guard(); return text;
      });
    },
    synthesize(text, context) {
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > localSpeechLimits.textCharacters || Buffer.byteLength(text) > localSpeechLimits.textBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new AppError('voice_text_limit');
      return job(context, async (directory, current) => {
        const input = join(directory, 'reply.txt'), output = join(directory, 'speech.wav'); await writeFile(input, text, { mode: 0o600 }); current.guard();
        const argv = config.synthesis.kind === 'say' ? ['-v', config.synthesis.voice, '-r', '165', '--file-format=WAVE', '--data-format=LEI16@16000', '--channels=1', '-f', input, '-o', output] : ['-v', config.synthesis.voice, '-s', '165', '-f', input, '-w', output];
        await execute([config.synthesis.executable.path, ...argv], directory, output, localSpeechLimits.audioBytes, current);
        const wav = await boundedFile(output, localSpeechLimits.audioBytes), info = speechWavInfo(wav); current.guard(); return { wav: Uint8Array.from(wav), ...info };
      });
    },
    async close() { if (!closed) { closed = true; shutdown.abort(); } await Promise.allSettled([...jobs]); },
  };
}

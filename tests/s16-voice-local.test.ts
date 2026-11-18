import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openLocalVoice, speechWavInfo, validateLocalVoiceConfig, type LocalVoiceConfig, type LocalVoiceEngine } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';
import { AppError } from '../src/errors';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const wav = () => encodeCaptureWav(new Float32Array(1600));
const context = (signal = new AbortController().signal) => ({ signal, guard() {}, started() {} });

function waitFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => { if (existsSync(path)) { clearTimeout(timer); watcher.close(); resolve(); } });
    const timer = setTimeout(() => { watcher.close(); reject(Error('fixture_barrier_timeout')); }, 5000);
    if (existsSync(path)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
}

async function fixture(mode = 'normal', timeoutMs = 5000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-voice-local-'))), scratch = join(root, 'scratch'), executable = join(root, 'speech-fixture'), model = join(root, 'model with spaces.bin'), marker = join(root, 'started.json'), release = join(root, 'release');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const source = `#!${process.execPath}
import {existsSync,readFileSync,watch,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1];
const mode=${JSON.stringify(mode)}, marker=${JSON.stringify(marker)}, release=${JSON.stringify(release)};
writeFileSync(marker,JSON.stringify({pid:process.pid,cwd:process.cwd(),args,privateEnv:process.env.JIT_VOICE_PRIVATE_SENTINEL??null,model:args.includes('--model')?readFileSync(option('--model'),'utf8'):null}),{mode:0o600});
if(mode==='wait') await new Promise(()=>{});
if(mode==='gate'&&!existsSync(release))await new Promise(resolve=>{const watcher=watch(${JSON.stringify(root)},()=>{if(existsSync(release)){watcher.close();resolve();}});if(existsSync(release)){watcher.close();resolve();}});
if(mode==='fail'){process.stderr.write('private diagnostic must never escape');process.exit(1);}
if(args.includes('--output-json')) writeFileSync(option('--output-file')+'.json',JSON.stringify({transcription:[{text:' Approve this '},{text:'draft only. '}]}),{mode:0o600});
else writeFileSync(option('-w'),Buffer.from('52494646240c000057415645666d74201000000001000100803e0000007d00000200100064617461000c0000'+'00'.repeat(3072),'hex'),{mode:0o600});
`;
  writeFileSync(executable, source, { mode: 0o700 }); writeFileSync(model, 'public test model fixture', { mode: 0o600 });
  const config: LocalVoiceConfig = { transcription: { executable: { path: executable, sha256: hash(source) }, model: { path: model, sha256: hash('public test model fixture') }, language: 'auto' }, synthesis: { kind: 'espeak', executable: { path: executable, sha256: hash(source) }, voice: 'en' }, timeoutMs };
  const engine = await openLocalVoice(config, scratch); cleanups.push(() => engine.close());
  return { root, scratch, config, engine, marker, model, release };
}

test('actual fixed local CLI receives bounded private files, a clean environment and no command from its transcript', async () => {
  const f = await fixture(); process.env.JIT_VOICE_PRIVATE_SENTINEL = 'must_not_be_inherited';
  try {
    expect(await f.engine.available()).toBe(true); expect(existsSync(f.marker)).toBe(false);
    let started = 0;
    expect(await f.engine.transcribe(wav(), { ...context(), started() { started++; } })).toBe('Approve this draft only.');
    const actual = JSON.parse(readFileSync(f.marker, 'utf8'));
    expect(actual.privateEnv).toBeNull(); expect(actual.model).toBe('public test model fixture'); expect(actual.args).toContain('--no-gpu'); expect(actual.args).toContain('--threads'); expect(started).toBe(1);
    const speech = await f.engine.synthesize('A currently guarded reply.', context()); expect(speech.durationMs).toBe(96); expect(speechWavInfo(speech.wav).durationMs).toBe(96);
    expect(readdirSync(f.scratch)).toEqual([]);
  } finally { delete process.env.JIT_VOICE_PRIVATE_SENTINEL; }
});

test('malformed capture, changed pins and guard revocation refuse before local speech starts', async () => {
  const f = await fixture(); let started = 0;
  expect(() => f.engine.transcribe(new Uint8Array(), context())).toThrow('voice_audio_invalid');
  await expect(f.engine.transcribe(wav(), { ...context(), guard() { throw Error('revoked'); }, started() { started++; } })).rejects.toThrow('voice_engine_unavailable');
  expect(started).toBe(0); expect(existsSync(f.marker)).toBe(false);
  writeFileSync(f.model, 'changed model', { mode: 0o600 }); expect(await f.engine.available()).toBe(false);
  await expect(f.engine.transcribe(wav(), context())).rejects.toThrow('voice_artifact_changed'); expect(existsSync(f.marker)).toBe(false);
  expect(readdirSync(f.scratch)).toEqual([]);
});

test('cancel and close join the actual hung CLI before deleting its input or returning capacity', async () => {
  for (const action of ['cancel', 'close']) {
    const f = await fixture('wait'), abort = new AbortController(), operation = f.engine.transcribe(wav(), context(abort.signal));
    const result = operation.catch(error => error); await waitFile(f.marker); const pid = JSON.parse(readFileSync(f.marker, 'utf8')).pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    if (action === 'cancel') abort.abort(); else await f.engine.close();
    expect((await result).message).toBe('voice_cancelled'); expect(() => process.kill(pid, 0)).toThrow(); expect(readdirSync(f.scratch)).toEqual([]);
  }
});

test('the independent supervisor enforces its deadline and only returns safe failure codes', async () => {
  const f = await fixture('wait', 1000), pending = f.engine.transcribe(wav(), context()).catch(error => error);
  await waitFile(f.marker); const pid = JSON.parse(readFileSync(f.marker, 'utf8')).pid;
  expect((await pending).message).toBe('voice_process_timeout'); expect(() => process.kill(pid, 0)).toThrow(); expect(readdirSync(f.scratch)).toEqual([]);
  const failed = await fixture('fail'); await expect(failed.engine.transcribe(wav(), context())).rejects.toThrow('voice_engine_unavailable');
});

test('a current owner guard is reacquired after actual speech processing and its safe authentication refusal survives', async () => {
  const f = await fixture('gate'); let revoked = false;
  const operation = f.engine.transcribe(wav(), { ...context(), guard() { if (revoked) throw new AppError('authentication_required', 401); } }).catch(error => error);
  await waitFile(f.marker); revoked = true; writeFileSync(f.release, 'release', { mode: 0o600 });
  expect(await operation).toMatchObject({ code: 'authentication_required', status: 401 }); expect(readdirSync(f.scratch)).toEqual([]);
});

test('SIGKILL of the owning controller closes its liveness pipe and the surviving supervisor joins the CLI', async () => {
  const f = await fixture('wait'); await f.engine.close();
  const parent = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/s16-voice-parent.ts')], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, JIT_LOCAL_VOICE_FIXTURE: '1' } });
  parent.stdin.write(JSON.stringify({ config: f.config, scratch: f.scratch })); parent.stdin.end();
  try {
    await waitFile(f.marker); const marker = JSON.parse(readFileSync(f.marker, 'utf8')), settled = join(marker.cwd, 'settled.json');
    parent.kill('SIGKILL'); await parent.exited; await waitFile(settled);
    expect(JSON.parse(readFileSync(settled, 'utf8'))).toMatchObject({ state: 'cancelled', child: marker.pid }); expect(() => process.kill(marker.pid, 0)).toThrow();
  } finally { parent.kill(); await parent.exited; }
});

test('voice configuration has no remote endpoint, arbitrary flags or silently selected route', () => {
  expect(() => validateLocalVoiceConfig({ url: 'https://example.com' })).toThrow('invalid_voice_config');
  expect(() => speechWavInfo(new Uint8Array())).toThrow('voice_audio_invalid');
});

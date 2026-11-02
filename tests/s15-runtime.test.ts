import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { selectRuntime } from '../src/runtime-selection';

test('explicit fresh CLI init opens all protected journals without installing an owner, policy or changing an old installation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'jit-s15-init-'));
  try {
    const config = join(parent, 'config.json'), directory = join(parent, 'installation'), old = join(parent, 'existing.sqlite'); writeFileSync(old, 'preserved old installation');
    writeFileSync(config, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', config], { cwd: process.cwd(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ error, exit }).toEqual({ error: '', exit: 0 }); expect(JSON.parse(out)).toMatchObject({ state: 's15_initialized', policy: 'not_installed' });
    const manifest = JSON.parse(readFileSync(join(directory, 'runtime/composition.json'), 'utf8')); expect(manifest.stores).toContain('memory.sqlite'); expect(manifest.stores).toContain('team.sqlite'); expect(manifest.stores).toContain('disclosure.sqlite');
    const retry = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', config], { stdout: 'ignore', stderr: 'ignore' }); expect(await retry.exited).not.toBe(0); expect(readFileSync(old, 'utf8')).toBe('preserved old installation');
    expect(() => selectRuntime(['credential', '--s15', '--config', config, '--key', 'github', '--secret-stdin'])).not.toThrow();
    expect(() => selectRuntime(['credential', '--s15', '--config', config, '--key', '../../other', '--secret-stdin'])).toThrow();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

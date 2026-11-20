import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FirecrackerProcessLease, firecrackerProcessStartTicks, type FirecrackerProcessFixture, type FirecrackerProcessIdentity } from '../src/s15/vm/firecracker/process';

const identity = (): FirecrackerProcessIdentity => ({ pid: 521, startTicks: '12345', hostBootId: '12345678-1234-1234-1234-123456789abc' });
function fixture() {
  type Process = { exited: boolean; killed: number };
  const original: Process = { exited: false, killed: 0 }, replacement: Process = { exited: false, killed: 0 };
  const descriptors = new Map<number, Process>(), opened: number[] = [], closed: number[] = [];
  let ticks = identity().startTicks, boot = identity().hostBootId, current = original, sequence = 30;
  const port: FirecrackerProcessFixture = {
    basis: 'protocol_fixture', bootId: () => boot, startTicks: () => ticks,
    open(pid) { opened.push(pid); const fd = sequence++; descriptors.set(fd, current); return fd; },
    exited(fd) { const process = descriptors.get(fd); if (!process) throw Error('bad descriptor'); return process.exited; },
    kill(fd) { const process = descriptors.get(fd); if (!process || process.exited) throw Error('already exited'); process.killed++; process.exited = true; },
    close(fd) { descriptors.delete(fd); closed.push(fd); },
  };
  return { port, original, replacement, descriptors, opened, closed,
    reuse() { current = replacement; ticks = '67890'; },
    ticks(value: string) { ticks = value; }, boot(value: string) { boot = value; } };
}

test('descriptor selection survives numeric PID reuse and cannot target its replacement', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port); f.reuse(); let guards = 0;
  try {
    expect(await lease.stop({ guard() { guards++; } })).toEqual({ observation: 'process_exited', basis: 'protocol_fixture' });
    expect(guards).toBe(2); expect(f.original.killed).toBe(1); expect(f.replacement.killed).toBe(0); expect(lease.exited()).toBe(true);
    await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_stop_already_started', outcome: 'unknown' });
    expect(f.original.killed).toBe(1);
  } finally { lease.close(); }
  expect(f.closed).toEqual([30]); expect(f.descriptors.size).toBe(0);
});

test('host boot/start mismatch rejects before any pidfd acquisition or signal', async () => {
  for (const change of ['boot', 'ticks'] as const) {
    const f = fixture(); if (change === 'boot') f.boot('other'); else f.ticks('other');
    await expect(FirecrackerProcessLease.open(identity(), f.port)).rejects.toMatchObject({ code: 'vm_firecracker_process_unavailable', outcome: 'not_sent' });
    expect(f.opened).toEqual([]); expect(f.original.killed).toBe(0);
  }
});

test.each(['reuse', 'exit', 'boot'] as const)('identity %s during acquisition closes the original descriptor and admits no lease', async change => {
  const f = fixture(), open = f.port.open;
  f.port.open = pid => { const fd = open(pid); if (change === 'reuse') f.reuse(); else if (change === 'boot') f.boot('other'); else f.original.exited = true; return fd; };
  await expect(FirecrackerProcessLease.open(identity(), f.port)).rejects.toMatchObject({ code: 'vm_firecracker_process_unavailable' });
  expect(f.closed).toEqual([30]); expect(f.descriptors.size).toBe(0); expect(f.original.killed).toBe(0); expect(f.replacement.killed).toBe(0);
});

test('acquisition and stop copy mutable host selections and fixture methods before awaiting', async () => {
  const f = fixture(), selected = identity(), leasePromise = FirecrackerProcessLease.open(selected, f.port);
  selected.pid = 999; selected.startTicks = '999'; f.port.kill = () => { throw Error('replacement method'); }; Object.defineProperty(f.port, 'basis', { value: 'host_process' });
  const lease = await leasePromise;
  try { expect(await lease.stop({ guard() {} })).toEqual({ observation: 'process_exited', basis: 'protocol_fixture' }); expect(f.opened).toEqual([521]); expect(f.original.killed).toBe(1); }
  finally { lease.close(); }
});

test('pre-abort/current-authority refusal dispatches no signal', async () => {
  for (const preAbort of [false, true]) {
    const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port), abort = new AbortController(); if (preAbort) abort.abort();
    let guards = 0;
    try { await expect(lease.stop({ signal: abort.signal, guard() { guards++; throw Error('authority withdrawn'); } })).rejects.toMatchObject({ outcome: 'not_sent' }); expect(f.original.killed).toBe(0); expect(guards).toBe(preAbort ? 0 : 1); expect(lease.exited()).toBe(false); }
    finally { lease.close(); }
  }
});

test('a blocked preparation guard times out and cannot signal after its late completion', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port), guard = Promise.withResolvers<void>();
  try {
    await expect(lease.stop({ timeoutMs: 10, guard: () => guard.promise })).rejects.toMatchObject({ code: 'vm_firecracker_stop_unconfirmed', outcome: 'not_sent' });
    guard.resolve(); await Promise.resolve(); await Promise.resolve(); expect(f.original.killed).toBe(0); expect(lease.exited()).toBe(false);
  } finally { guard.resolve(); lease.close(); }
});

test('publication revocation after actual exit retains unknown, without a replacement signal', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port); let guards = 0;
  try {
    await expect(lease.stop({ guard() { if (++guards === 2) throw Error('revoked'); } })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.original.killed).toBe(1); expect(lease.exited()).toBe(true);
    await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_stop_already_started', outcome: 'unknown' });
    expect(f.original.killed).toBe(1);
  } finally { lease.close(); }
});

test('abort after dispatch stays unknown and read-back uses the original retained pidfd', async () => {
  const f = fixture(), abort = new AbortController(); let fdObserved: number | null = null;
  f.port.kill = fd => { fdObserved = fd; f.original.killed++; abort.abort(); };
  const lease = await FirecrackerProcessLease.open(identity(), f.port);
  try {
    await expect(lease.stop({ guard() {}, signal: abort.signal })).rejects.toMatchObject({ code: 'aborted', outcome: 'unknown' });
    expect(Number(fdObserved)).toBe(30); expect(f.descriptors.size).toBe(1); expect(lease.exited()).toBe(false);
    f.reuse(); f.original.exited = true; expect(lease.exited()).toBe(true); expect(f.replacement.killed).toBe(0);
  } finally { lease.close(); }
});

test('a signal failure or unconfirmed exit cannot publish a stop or retry a kill', async () => {
  for (const throws of [true, false]) {
    const f = fixture(); f.port.kill = () => { f.original.killed++; if (throws) throw Error('private native failure'); };
    const lease = await FirecrackerProcessLease.open(identity(), f.port);
    try {
      await expect(lease.stop({ guard() {}, timeoutMs: 10 })).rejects.toMatchObject({ code: 'vm_firecracker_stop_unconfirmed', outcome: 'unknown' });
      await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ outcome: 'unknown' }); expect(f.original.killed).toBe(1); expect(f.descriptors.size).toBe(1);
    } finally { lease.close(); }
  }
});

test('closing is idempotent observation cleanup; it neither kills nor certifies an alive process', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port); lease.close(); lease.close();
  expect(f.closed).toEqual([30]); expect(f.original.killed).toBe(0); expect(f.original.exited).toBe(false);
  expect(() => lease.exited()).toThrow('vm_firecracker_process_closed');
  await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_process_closed', outcome: 'not_sent' });
});

test('a concurrent stop cannot close or steal the in-flight exact observation', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = lease.stop({ guard() { entered.resolve(); return release.promise; } });
  await entered.promise;
  await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_stop_already_started', outcome: 'not_sent' });
  expect(() => lease.close()).toThrow('vm_firecracker_process_busy'); expect(f.closed).toEqual([]);
  release.resolve(); expect(await original).toMatchObject({ observation: 'process_exited' }); lease.close(); expect(f.original.killed).toBe(1);
});

test('already-exited read-back publishes no stronger receipt and sends no signal', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port); f.original.exited = true;
  try { const result = await lease.stop({ guard() {} }); expect(result).toEqual({ observation: 'process_exited', basis: 'protocol_fixture' }); expect(result).not.toHaveProperty('execution'); expect(result).not.toHaveProperty('vm_stopped'); expect(f.original.killed).toBe(0); }
  finally { lease.close(); }
});

test('already-exited read-back still requires the final current-authority guard', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port); f.original.exited = true; let guards = 0;
  try { await expect(lease.stop({ guard() { if (++guards === 2) throw Error('revoked before publication'); } })).rejects.toMatchObject({ outcome: 'not_sent' }); expect(guards).toBe(2); expect(f.original.killed).toBe(0); }
  finally { lease.close(); }
});

test('invalid stop options do not retain a busy lease or dispatch a signal', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port);
  try {
    for (const timeoutMs of [0, 10001, 1.5, NaN]) await expect(lease.stop({ guard() {}, timeoutMs })).rejects.toMatchObject({ code: 'vm_firecracker_process_invalid', outcome: 'not_sent' });
    await expect(lease.stop({ guard() {}, signal: {} as AbortSignal })).rejects.toMatchObject({ code: 'vm_firecracker_process_invalid', outcome: 'not_sent' });
    expect(f.original.killed).toBe(0); expect(await lease.stop({ guard() {} })).toMatchObject({ observation: 'process_exited' });
  } finally { lease.close(); }
});

test('a late final guard times out as unknown and never issues a replacement signal', async () => {
  const f = fixture(), lease = await FirecrackerProcessLease.open(identity(), f.port), release = Promise.withResolvers<void>(); let guards = 0;
  try {
    await expect(lease.stop({ timeoutMs: 10, guard() { if (++guards === 2) return release.promise; } })).rejects.toMatchObject({ code: 'vm_firecracker_stop_unconfirmed', outcome: 'unknown' });
    release.resolve(); await Promise.resolve(); await Promise.resolve(); expect(f.original.killed).toBe(1); expect(lease.exited()).toBe(true);
    await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_stop_already_started', outcome: 'unknown' });
  } finally { release.resolve(); lease.close(); }
});

test('invalid selections and untrusted basis labels perform no acquisition', async () => {
  const f = fixture();
  for (const patch of [{ pid: 0 }, { pid: 1 }, { pid: 1.5 }, { pid: 0x80000000 }, { startTicks: '0' }, { startTicks: '../1' }, { startTicks: '1'.repeat(21) }, { hostBootId: 'guest-id' }]) await expect(FirecrackerProcessLease.open({ ...identity(), ...patch }, f.port)).rejects.toMatchObject({ code: 'vm_firecracker_process_invalid' });
  await expect(FirecrackerProcessLease.open(identity(), { ...f.port, basis: 'host_process' } as unknown as FirecrackerProcessFixture)).rejects.toMatchObject({ code: 'vm_firecracker_process_invalid' }); expect(f.opened).toEqual([]);
});

test('kernel comm parsing retains field 22 with spaces, newlines and parentheses inside the name', () => {
  for (const name of ['firecracker', 'weird ) ( name', 'line\nbreak']) {
    const stat = `521 (${name}) S ${Array(18).fill('0').join(' ')} 12345 99\n`;
    expect(firecrackerProcessStartTicks(stat, 521)).toBe('12345');
  }
  for (const stat of ['999 (firecracker) S 12345', '521 (firecracker) S 12345', `521 (firecracker) S ${Array(18).fill('0').join(' ')} nope`, '521 (x) '+ 'a'.repeat(65536)]) expect(() => firecrackerProcessStartTicks(stat, 521)).toThrow('vm_firecracker_process_unavailable');
});

test.skipIf(process.platform === 'linux')('non-Linux production cannot be advertised as host pidfd evidence', async () => {
  await expect(FirecrackerProcessLease.open(identity())).rejects.toMatchObject({ code: 'vm_firecracker_process_unavailable', outcome: 'not_sent' });
});

test.skipIf(process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))('native Linux pidfd targets only its owned child and observes actual thread-group exit', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  let lease: FirecrackerProcessLease | null = null;
  try {
    const selected = { pid: child.pid, hostBootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTicks: firecrackerProcessStartTicks(readFileSync(`/proc/${child.pid}/stat`, 'utf8'), child.pid) };
    lease = await FirecrackerProcessLease.open(selected); expect(lease.basis).toBe('host_process'); expect(lease.exited()).toBe(false);
    expect(await lease.stop({ guard() {} })).toEqual({ observation: 'process_exited', basis: 'host_process' }); await child.exited; expect(lease.exited()).toBe(true);
  } finally { lease?.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await child.exited; }
});

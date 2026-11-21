import { spawnRunner, type CommandRunner } from '../../src/ops/supervisor';

/** Actual copied helper processes; UID transition is an explicit disposable fixture port, not Linux enforcement. */
export function s16ReleaseFixtureRunner(root: string, env: Record<string, string>): CommandRunner {
  return async (argv, settings) => {
    if (JSON.stringify(argv.slice(0, 6)) !== JSON.stringify(['/usr/sbin/runuser', '-u', 'jit-fixture', '--', '/usr/bin/env', '-i'])) throw Error('fixture_unexpected_identity_command');
    const bun = argv[9]!, entry = argv[10]!, policy = JSON.stringify({ root, uid: process.getuid!() });
    if (entry.endsWith('/s16-guarded-selection.ts')) return spawnRunner([bun, '-e', `import{openS16GuardedSelection}from${JSON.stringify(entry)};const command=await Bun.stdin.json(),cap=openS16GuardedSelection(command.input,{pathPolicy:${policy}});try{let result;if(command.method==='prepare')result=await cap.prepare();else if(command.method==='inspect')result=cap.inspect(command.plan);else if(command.method==='arm'){await cap.arm(command.plan,command.readers);result={state:'armed'};}else if(command.method==='abort')result=await cap.abortBeforeSelection(command.plan,command.reader);else result=await cap.complete(command.plan);await cap.close();console.log(JSON.stringify(result));}catch(error){try{await cap.close();}catch{}console.error(error);process.exitCode=1;}`], { ...settings, env });
    if (entry.endsWith('/s16-package-probe.ts')) {
      const args = argv.slice(11); return spawnRunner([bun, '-e', `import{openS16PackageReaderProbe}from${JSON.stringify(entry)};const cap=await openS16PackageReaderProbe({targetDirectory:${JSON.stringify(args[1])},packageSha256:${JSON.stringify(args[3])},configPath:${JSON.stringify(args[5])},configurationSha256:${JSON.stringify(args[7])}},{pathPolicy:${policy}});try{const result=await cap.observe();cap.close();console.log(JSON.stringify(result));}finally{cap.close();}`], { ...settings, env });
    }
    if (!entry.endsWith('/src/s16/operations-cli.ts')) throw Error('fixture_unexpected_program');
    return spawnRunner([bun, ...argv.slice(10)], { ...settings, env });
  };
}

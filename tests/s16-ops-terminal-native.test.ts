import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { spawnRunner } from '../src/ops/supervisor';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';

let parent: string, artifact: string, packageHash: string;
const env = { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin') };
beforeAll(async () => {
  const receipt = process.env.JIT_S16_TERMINAL_NATIVE_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  if (receipt) opsDirectory(dirname(receipt));
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-terminal-native-'))); artifact = join(parent, 'artifact');
  buildPackage({ srcDir: process.cwd(), outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
  await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
  packageHash = validateArtifact(artifact, { runtime: true }).manifest!.contentHash;
}, 120000);
afterAll(() => {
  try {
    if (!parent) return; const checked = validateArtifact(artifact, { runtime: true }), dependencies = readDependencyRecord(artifact);
    expect(checked.ok && checked.manifest?.contentHash === packageHash && !!dependencies).toBe(true);
    const receipt = process.env.JIT_S16_TERMINAL_NATIVE_RECEIPT;
    if (receipt) {
      const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-terminal-native-artifact-evidence/v1', basis: 'actual_copied_operator_with_public_native_and_explicit_model_protocol_fixture', sourceCommit: source.stdout.toString().trim(), sourceState: source.exitCode === 0 && status.exitCode === 0 && !status.stdout.length ? 'clean' : 'unverified',
        packageHash, lockHash: checked.manifest!.lockHash, dependencyHash: dependencies!.dependencyHash, dependencyFiles: dependencies!.dependencyFiles,
        platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified', driverSha256: new Bun.CryptoHasher('sha256').update(readFileSync(import.meta.path)).digest('hex'),
        artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required', serviceClientLifecycle: 'not_exercised', linuxAdoption: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised' }));
    }
  } finally { if (parent) rmSync(parent, { recursive: true, force: true }); }
});
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: artifact, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error }; } finally { clearTimeout(timer); }
}
// Real public native sessions; the MODEL correlation is an explicit protocol fixture,
// not evidence that an owning service dispatched model work or a VM operation.
const seed = `const nativeDirectory=join(config.directory,'runtime/native-model/native_fixture');mkdirSync(nativeDirectory,{recursive:true,mode:0o700});for(const part of ['workspace','home','sessions'])mkdirSync(join(nativeDirectory,part),{mode:0o700});
const nativeOptions={workspaceRoot:join(nativeDirectory,'workspace'),homeDirectory:join(nativeDirectory,'home'),sessionDirectory:join(nativeDirectory,'sessions'),context:{policy:'strict',systemPrompt:'Terminal verification fixture.',sections:[]},tools:{policy:'exact',definitions:[],hostedLookup:'off'},limits:{maxTurns:1,maxConcurrentTools:1,maxAttempts:1,contextWindow:32768,maxInputChars:1024,deadlineMs:1000}};
const host=await createHost(nativeOptions);let reference;try{const session=await host.createSession();reference={...session.reference};await session.submit({text:'Public synthetic input.'},{provider:'codex-subscription',id:'fixture',async *stream(){yield{type:'message_complete',message:{type:'assistant',id:crypto.randomUUID(),content:[{type:'text',text:'Retained synthetic result.'}]}};}});await session.close();const retired=await host.createSession();await retired.retire();await retired.close();}finally{await host.close();}
const model=new DurableJournal(join(config.directory,'runtime/model.sqlite'),config.installationId,false,0x4a4d5135);try{model.tx(()=>model.put('native_fixture',{contract:'s15-model-selection/v1',id:'native_fixture',state:'reconcile_only',session:reference}));}finally{model.close();}`;

async function scenario(native: boolean, body: string, preflight = '') {
  const root = realpathSync(mkdtempSync(join(parent, 'state-'))), configPath = join(root, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify({ ...s15StageConfig(join(root, 'installation'), 'http://localhost:3041'), files: true }), { mode: 0o600 });
    const initialized = await run(['src/main.ts', 'init', '--s15', '--config', configPath]); expect({ exit: initialized.exit, error: initialized.error }).toEqual({ exit: 0, error: '' });
    const script = `import{join}from'node:path';import{existsSync,mkdirSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync}from'node:fs';import{createHost}from'schway/host';import{DurableJournal}from'./src/s15/durable-journal';import{readS15RuntimeConfig}from'./src/s15/runtime-config';import{openS16ControlMaintenance}from'./src/s16/operations/control-maintenance';import{adoptS16Operations}from'./src/s16/operations/adoption';import{readS16OperationsFence}from'./src/s16/operations/operations-state';import{openS16InstallationLease}from'./src/s16/operations/installation-lease';
const config=readS15RuntimeConfig(${JSON.stringify(configPath)}),hash=value=>new Bun.CryptoHasher('sha256').update(value).digest('hex'),check=(ok,label)=>{if(!ok)throw Error(label);};
${native ? seed : ''}
adoptS16Operations(config,'adopt_original');let ctx=openS16ControlMaintenance(config);const backup=ctx.pointCapture('backup_original');let point;try{point=await backup.capture();}finally{await backup.close();ctx.close();}
ctx=openS16ControlMaintenance(config);let journal=ctx.operations(),original=journal.read().requests.find(row=>row.requestId==='backup_original'),action=original.actions.find(row=>row.kind==='capture_native'),stage=join(config.directory,'operations/native-staging',original.id,action.id),plan=JSON.parse(readFileSync(join(stage,'plan.json'),'utf8')),options={attempt:plan.attempt,maxBytes:plan.maxBytes,verifyCurrent:true,ownedStaging:true};
${preflight}
// Generic upgrade admission proves fence preservation only; no selector or upgrade is implemented here.
journal.begin({requestId:'upgrade_pending',kind:'upgrade',hash:'${'b'.repeat(64)}',pointId:point.pointId},journal.read().revision);
const controlPath=join(config.directory,'operations/control.json'),fencePath=join(config.directory,'owner/owner.sqlite.ops/fence.json'),beforeControl=readFileSync(controlPath),beforeFence=readFileSync(fencePath),snapshot=()=>{const cut=ctx.currentLedgerCut();try{return ctx.sources.map(source=>hash(cut.serialize(source.name)));}finally{cut.close();}},beforeSql=snapshot();
const preserved=()=>{check(readFileSync(controlPath).equals(beforeControl),'control_changed');check(readFileSync(fencePath).equals(beforeFence),'fence_changed');check(JSON.stringify(snapshot())===JSON.stringify(beforeSql),'current_sql_changed');},verify=async(override={})=>{const cap=ctx.nativeSet('backup_original',{...options,...override});try{return await cap.capture();}finally{await cap.close();}};
try{${body}preserved();console.log(JSON.stringify({preserved:true,roots:plan.roots.length,actionId:action.id}));}finally{ctx.close();}`;
    const result = await run(['-e', script]); expect({ exit: result.exit, error: result.error }).toEqual({ exit: 0, error: '' });
    const observed = JSON.parse(result.out); expect(observed.preserved).toBe(true); expect(observed.roots).toBe(native ? 1 : 0); expect(observed.actionId).toMatch(/^native_set_/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const native of [false, true]) test('completed retained backup deeply rechecks ' + (native ? 'actual public native sessions' : 'explicit empty native state') + ' without changing another gate', async () => {
  await scenario(native, `const paths=['plan.json','receipt.json','scratch.json','data/manifest.json',...plan.roots.map(root=>'data/'+root.id+'.json')],bytes=paths.map(name=>readFileSync(join(stage,name)));const first=await verify(),second=await verify();check(first.actionId===action.id&&first.manifestSha256===action.observedSha256&&JSON.stringify(first)===JSON.stringify(second),'original_capture_lost');check(paths.every((name,i)=>readFileSync(join(stage,name)).equals(bytes[i])),'retained_component_changed');check(readdirSync(join(stage,'quarantine')).length===0,'scratch_not_disposed');`);
}, 30000);

test('completed verification requires both explicit options and the original attempt/budget', async () => {
  await scenario(false, `for(const override of [{verifyCurrent:undefined},{ownedStaging:undefined},{attempt:'different'},{maxBytes:plan.maxBytes-1}]){let refused=false;try{await verify(override);}catch{refused=true;}check(refused,'terminal_capture_admitted');preserved();}`);
});

test.each(['plan.json', 'receipt.json', 'data/manifest.json', 'scratch.json', 'quarantine', 'data'])('missing original %s refuses without recreation or metadata changes', async name => {
  await scenario(false, `const missing=join(stage,${JSON.stringify(name)});rmSync(missing,{recursive:true});let refused=false;try{await verify();}catch{refused=true;}check(refused,'missing_evidence_accepted');check(!existsSync(missing),'missing_evidence_recreated');`);
});

test('missing populated member refuses without recapture', async () => {
  await scenario(true, `const missing=join(stage,'data',plan.roots[0].id+'.json');unlinkSync(missing);let refused=false;try{await verify();}catch{refused=true;}check(refused&&!existsSync(missing),'member_recreated');`);
}, 30000);

test.each(['receipt.json', 'data/manifest.json', 'scratch.json'])('changed original %s refuses without replacing its bytes', async name => {
  await scenario(false, `const path=join(stage,${JSON.stringify(name)});writeFileSync(path,'{}',{mode:0o600});let refused=false;try{await verify();}catch{refused=true;}check(refused&&readFileSync(path,'utf8')==='{}','changed_evidence_replaced');`);
});

test('later current native identity refuses without rewinding it or rewriting the completed receipt', async () => {
  await scenario(true, `const current=await createHost(nativeOptions);let added;try{added=await current.createSession();await added.close();}finally{await current.close();}const before=readFileSync(join(stage,'receipt.json'));let code;try{await verify();}catch(error){code=error.code;}check(code==='s16_ops_native_changed','changed_native_accepted');check(readFileSync(join(stage,'receipt.json')).equals(before),'receipt_replaced');const readback=await createHost(nativeOptions);try{check((await readback.listSessions()).sessions.some(row=>row.reference.id===added.reference.id),'current_identity_rewound');}finally{await readback.close();}`);
}, 30000);

test('retired staging cannot be regenerated for a completed backup', async () => {
  await scenario(false, `const absent=join(stage,'data');check(!existsSync(absent),'retirement_failed');let refused=false;try{await verify();}catch{refused=true;}check(refused&&!existsSync(absent),'retired_staging_recreated');`, `ctx.retireStaging('retire_original',{sourceRequestId:'backup_original'});`);
});

test('removing the original retained point withdraws terminal verification without changing another gate', async () => {
  await scenario(false, `let refused=false;try{await verify();}catch(error){refused=error.code==='s16_ops_phase_invalid';}check(refused,'removed_point_accepted');`, `ctx.removePoint('cleanup_original',{pointId:point.pointId});`);
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { desktopCdpAttach, desktopCdpRelay } from "../src/s15/vm/desktop-programs";
import { qemuDesktopProvisioning, qemuDesktopReadyKey, qemuDesktopBrowser } from "../src/s15/vm/qemu";
import { vmDesktopCdpStream } from "../src/s15/vm/desktop-stream";
import { CdpClient } from "../src/exec/cdp-stream";
import { vmQuote, vmSshArgs } from "../src/s15/vm/host";
import type { VmEndpoint } from "../src/s15/vm/types";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i=0;i<200;i++) { if(check())return; await pause(); } throw new Error("fixture timeout"); }
function directory() { const path = mkdtempSync(join(tmpdir(),"jit-cdp-")); chmodSync(path,0o700); cleanup.push(() => rmSync(path,{recursive:true,force:true})); return path; }
function frames(socket: ReturnType<typeof connect>, label: string) {
  let buffer = Buffer.alloc(0); const waiting: ((s: string) => void)[] = [], ready: string[] = [];
  socket.on("data", b => { buffer = Buffer.concat([buffer,typeof b === "string" ? Buffer.from(b) : b]); for (let at=buffer.indexOf(0);at>=0;at=buffer.indexOf(0)) { const frame=buffer.subarray(0,at).toString();buffer=buffer.subarray(at+1); const resolve=waiting.shift(); if(resolve)resolve(frame);else ready.push(frame); } });
  return () => ready.length ? Promise.resolve(ready.shift()!) : Promise.race([new Promise<string>(resolve => waiting.push(resolve)), new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("frame timeout: "+label)),2000))]);
}
async function relayFixture() {
  const dir = directory(), stub = join(dir,"stub"), pid = join(dir,"pid"), lock = join(dir,"profile.lock");
  // This is a stub echo process using fd3/fd4, never a browser. A held flock models the single profile owner.
  writeFileSync(stub, `#!/usr/bin/python3\nimport fcntl,json,os,time\nf=open(${JSON.stringify(lock)},'w');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nopen(${JSON.stringify(pid)},'w').write(str(os.getpid()))\nb=b''\nwhile True:\n d=os.read(3,65536)\n if not d:break\n b+=d\n while b'\\0' in b:\n  m,b=b.split(b'\\0',1);m=json.loads(m)\n  if m['method']=='quit':os._exit(0)\n  if m['method']=='late':time.sleep(0.05)\n  r=json.dumps({'id':m['id'],'result':{'echo':m['params']}}).encode()+b'\\0'\n  for x in r:os.write(4,bytes([x]))\n`); chmodSync(stub,0o700);
  const program = join(dir,"relay");
  writeFileSync(program,desktopCdpRelay.replace("D='/run/jit-desktop'",`D=${JSON.stringify(dir)}`).replace("pwd.getpwnam('jit-desktop').pw_uid","os.geteuid()")); chmodSync(program,0o700);
  const start = () => { const proc = Bun.spawn([program,stub],{stdin:"ignore",stdout:"pipe",stderr:"pipe"}); cleanup.push(async () => { proc.kill("SIGTERM");await proc.exited; }); return proc; };
  const proc = start(); await until(()=>existsSync(join(dir,"cdp.sock")) && existsSync(pid));
  let number=0; const open = () => { const socket=connect(join(dir,"cdp.sock")); socket.on("error",()=>{}); cleanup.push(()=>{socket.destroy();}); return {socket,next:frames(socket, String(++number))}; };
  return { dir, pid, proc, open, start };
}

describe("fixed desktop programs (real subprocesses, stub child)", () => {
  test("attach is a live binary pipe, not a buffered Python stdout", async () => {
    const dir=directory(), path=join(dir,"echo.sock"), server=createServer(socket=>socket.on("data",b=>socket.write(b)));
    await new Promise<void>(resolve=>server.listen(path,resolve)); cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    const attach=join(dir,"attach");writeFileSync(attach,desktopCdpAttach.replace("'/run/jit-desktop/cdp.sock'",JSON.stringify(path)));chmodSync(attach,0o700);
    const proc=Bun.spawn([attach],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});cleanup.push(async()=>{proc.kill();await proc.exited;});
    let exited=false;void proc.exited.then(()=>{exited=true;});
    const bytes=Buffer.from([0,13,10,3,4,65,0,255]);proc.stdin.write(bytes);proc.stdin.flush();
    const reader=proc.stdout.getReader();let out=Buffer.alloc(0);
    const timer=setTimeout(()=>proc.kill(),2000);
    try { while(out.length<bytes.length){const n=await reader.read();if(n.done)break;out=Buffer.concat([out,n.value]);} expect(out.equals(bytes)).toBe(true);expect(exited).toBe(false); } finally {clearTimeout(timer);reader.releaseLock();proc.stdin.end();await proc.exited;}
  });
  test("handshake arrives while both programs run, second client busy; disconnect preserves child and tabs", async () => {
    const f=await relayFixture(), a=f.open();expect(await a.next()).toBe('{"jit":"attached"}');
    a.socket.write('{"id":1,"method":"echo","params":{"value":"one"}}\0');expect(JSON.parse(await a.next())).toEqual({id:1,result:{echo:{value:"one"}}});
    const busyProgram=desktopCdpAttach.replace("'/run/jit-desktop/cdp.sock'",JSON.stringify(join(f.dir,"cdp.sock")));
    const busy=Bun.spawn(["python3","-I","-u","-c",busyProgram],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});cleanup.push(async()=>{busy.kill();await busy.exited;});
    expect(await new Response(busy.stdout).text()).toBe('{"jit":"busy"}\0');expect(await busy.exited).toBe(0);
    const pid=Number(readFileSync(f.pid,"utf8"));a.socket.destroy();await pause();expect(()=>process.kill(pid,0)).not.toThrow();
    const c=f.open();expect(await c.next()).toBe('{"jit":"attached"}');c.socket.write('{"id":1,"method":"echo","params":{"value":"two"}}\0');expect(JSON.parse(await c.next())).toEqual({id:1,result:{echo:{value:"two"}}});
    f.proc.kill("SIGTERM");await f.proc.exited;expect(()=>process.kill(pid,0)).toThrow();expect(existsSync(join(f.dir,"cdp.sock"))).toBe(false);
    const next=f.start();await until(()=>existsSync(join(f.dir,"cdp.sock")));const d=f.open();expect(await d.next()).toBe('{"jit":"attached"}');d.socket.write('{"id":2,"method":"echo","params":{}}\0');expect(JSON.parse(await d.next()).id).toBe(2);next.kill("SIGTERM");await next.exited;
  });
  test("a detached client's late reply cannot resolve a new client's reused CDP id", async()=>{
    const f=await relayFixture(),a=f.open();await a.next();a.socket.write('{"id":1,"method":"late","params":{"old":true}}\0');await pause(10);a.socket.end();expect(await a.next()).toBe('{"jit":"settled"}');
    const b=f.open();expect(await b.next()).toBe('{"jit":"attached"}');b.socket.write('{"id":1,"method":"echo","params":{"new":true}}\0');expect(JSON.parse(await b.next())).toEqual({id:1,result:{echo:{new:true}}});
  });
  test("child exit closes relay and next start releases the profile lock",async()=>{
    const f=await relayFixture(),a=f.open();await a.next();a.socket.write('{"id":1,"method":"quit","params":{}}\0');expect(await f.proc.exited).toBe(0);
    const next=f.start();await until(()=>existsSync(join(f.dir,"cdp.sock")));const b=f.open();expect(await b.next()).toBe('{"jit":"attached"}');next.kill("SIGTERM");await next.exited;
  });
  test("bare Chrome ready marker upgrades session programs without downloading the existing Chrome pin", () => {
    const dir = directory(), root = join(dir,"opt"), chrome = join(root,`chrome-${qemuDesktopBrowser.version}`), lib=join(dir,"lib");
    mkdirSync(chrome,{recursive:true});writeFileSync(join(chrome,"chrome"),"existing pin");writeFileSync(join(root,"ready-v1"),qemuDesktopBrowser.version+"\n");
    const log=join(dir,"commands");
    const mock=`\nfrom types import SimpleNamespace\ndef fake_run(argv,**kw):\n with open(${JSON.stringify(log)},'a') as f:f.write(json.dumps(argv)+'\\n')\n if argv[0] in ('curl','apt-get'):raise RuntimeError('must not download/reinstall existing Chrome')\n return SimpleNamespace(returncode=0)\nsubprocess.run=fake_run\npwd.getpwnam=lambda _:SimpleNamespace(pw_uid=os.getuid())\ntime.sleep=lambda _:None\nstat.S_ISSOCK=lambda _:True\n`;
    const code=qemuDesktopProvisioning.replace("\na=json.loads",mock+"\na=json.loads")
      .replaceAll("/opt/jit-desktop",root).replaceAll("/usr/local/lib/jit-desktop",lib).replaceAll("/etc/",dir+"/etc/").replaceAll("/run/jit-desktop",dir+"/run");
    mkdirSync(join(dir,"run"),{recursive:true});writeFileSync(join(dir,"run/cdp.sock"),"readiness stat seam");
    const result=spawnSync("python3",["-I","-c",code],{input:JSON.stringify({proxy:"http://fixture:p@192.168.5.100:3128",url:qemuDesktopBrowser.x86_64.url,sha256:qemuDesktopBrowser.x86_64.sha256,version:qemuDesktopBrowser.version}),encoding:"utf8"});
    expect(result.status).toBe(0);expect(result.stderr).toBe("");expect(result.stdout.trim()).toBe("jit-desktop-ready-v1");
    expect(readFileSync(join(root,"ready-v1"),"utf8").trim()).toBe(qemuDesktopReadyKey);
    expect(readFileSync(join(chrome,"chrome"),"utf8")).toBe("existing pin");expect(readFileSync(join(lib,"cdp-relay"),"utf8")).toContain("--remote-debugging-pipe");expect(existsSync(join(lib,"cdp-attach"))).toBe(true);
    expect(readFileSync(log,"utf8")).not.toMatch(/curl|apt-get/);expect(readFileSync(log,"utf8")).toContain('"restart", "jit-desktop.service"');
  });
  test("real relay handshake passes through attach without either program exiting",async()=>{
    const f=await relayFixture(), attach=join(f.dir,"attach");writeFileSync(attach,desktopCdpAttach.replace("'/run/jit-desktop/cdp.sock'",JSON.stringify(join(f.dir,"cdp.sock"))));chmodSync(attach,0o700);
    const p=Bun.spawn([attach],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});cleanup.push(async()=>{p.kill();await p.exited;});let exited=false;void p.exited.then(()=>{exited=true;});
    const reader=p.stdout.getReader(),timer=setTimeout(()=>p.kill(),2000);let b=Buffer.alloc(0);
    try {while(b.indexOf(0)<0){const n=await reader.read();if(n.done)break;b=Buffer.concat([b,n.value]);}expect(b.toString()).toBe('{"jit":"attached"}\0');expect(exited).toBe(false);expect(existsSync(f.pid)).toBe(true);}finally{clearTimeout(timer);reader.releaseLock();p.stdin.end();await p.exited;}
  });
  test("unsafe relay directory refuses before starting a child; installer creates it as root and revisions include programs",async()=>{
    const dir=directory();chmodSync(dir,0o755);const program=join(dir,"relay");writeFileSync(program,desktopCdpRelay.replace("D='/run/jit-desktop'",`D=${JSON.stringify(dir)}`).replace("pwd.getpwnam('jit-desktop').pw_uid","os.geteuid()"));
    expect(await Bun.spawn(["python3","-I",program,"/not-a-program"],{stdout:"ignore",stderr:"ignore"}).exited).toBe(1);
    expect(qemuDesktopProvisioning).toContain("ExecStartPre=+/usr/bin/install -d -m 0700 -o jit-desktop -g jit-desktop /run/jit-desktop");
    expect(qemuDesktopProvisioning).toContain("put(L+'/cdp-relay',RELAY,0o755);put(L+'/cdp-attach',ATTACH,0o755)");
    expect(qemuDesktopProvisioning).toContain("/cdp-relay @B@/chrome");expect(qemuDesktopProvisioning).toContain("</dev/null");
    expect(qemuDesktopReadyKey).toBe(`${qemuDesktopBrowser.version}+session.cdp-2`);
    expect(desktopCdpRelay).not.toContain("remote-debugging-port");expect(desktopCdpRelay).toContain("--remote-debugging-pipe");
    expect(qemuDesktopProvisioning.indexOf("if not os.path.isfile(B+'/chrome'):")).toBeLessThan(qemuDesktopProvisioning.indexOf("'curl'"));
  });
});

// Live evidence belongs to #431. Explicitly opt in with a protected endpoint JSON (key *paths*, never key bytes).
const liveEndpoint = process.env.JIT_DESKTOP_SSH_ENDPOINT;
describe.skipIf(!liveEndpoint)("real guest ssh -T + sudo-rs desktop channel (#431)",()=>{
  test("binary echo returns before close through the actual SSH + sudo + attach chain",async()=>{
    const endpoint=JSON.parse(liveEndpoint!) as VmEndpoint;
    const peer=`import os,socket,subprocess,tempfile\nwith tempfile.TemporaryDirectory(dir='/run/jit-desktop') as d:\n p=d+'/echo.sock';s=socket.socket(socket.AF_UNIX);s.bind(p);s.listen(1)\n child=os.fork()\n if child==0:\n  c,_=s.accept()\n  while True:\n   b=c.recv(65536)\n   if not b:break\n   c.sendall(b)\n  c.close();s.close();os._exit(0)\n s.close()\n try:subprocess.run(['python3','-I','-u','-c',${JSON.stringify(desktopCdpAttach)}.replace('/run/jit-desktop/cdp.sock',p)],check=True)\n finally:os.waitpid(child,0)\n`;
    const argv=[...vmSshArgs(endpoint),["sudo","-n","-u","jit-desktop","python3","-I","-u","-c",peer].map(vmQuote).join(" ")];
    const proc=Bun.spawn(argv,{stdin:"pipe",stdout:"pipe",stderr:"ignore"});cleanup.push(async()=>{proc.kill();await proc.exited;});
    const bytes=Buffer.from([0,13,10,3,4,65,0,255]);proc.stdin.write(bytes);proc.stdin.flush();let exited=false;void proc.exited.then(()=>{exited=true;});
    const reader=proc.stdout.getReader();let out=Buffer.alloc(0);const timer=setTimeout(()=>proc.kill(),10000);
    try {while(out.length<bytes.length){const n=await reader.read();if(n.done)break;out=Buffer.concat([out,n.value]);}expect(out.equals(bytes)).toBe(true);expect(exited).toBe(false);}finally{clearTimeout(timer);reader.releaseLock();proc.stdin.end();await proc.exited;}
  });
  test("actual relay handshake and version reply arrive without closing or restarting Chromium",async()=>{
    const stream=await vmDesktopCdpStream(JSON.parse(liveEndpoint!));const cdp=new CdpClient(stream);cleanup.push(()=>cdp.close());expect(await cdp.send("Browser.getVersion")).toHaveProperty("product");expect(cdp.closed).toBeNull();
  });
});

// The production relay is unmodified apart from file breadcrumbs after real pipe writes/disconnect.
// A child that does not read fd3 gives deterministic kernel-pipe backpressure (not mocked os.write).
test("real relay drains a partial frame, drops wholly unsent navigation and acknowledges before reattach",async()=>{
 const dir=directory(),release=join(dir,"release"),progress=join(dir,"progress"),disconnected=join(dir,"disconnected"),received=join(dir,"received");
 const stub=join(dir,"stub"),program=join(dir,"relay");
 writeFileSync(stub,`#!/usr/bin/python3\nimport os,json,time\nwhile not os.path.exists(${JSON.stringify(release)}):time.sleep(.001)\nb=b''\nwhile True:\n d=os.read(3,65536)\n if not d:break\n b+=d\n while b'\\0' in b:\n  frame,b=b.split(b'\\0',1);m=json.loads(frame)\n  with open(${JSON.stringify(received)},'a') as f:f.write(m['method']+'\\n')\n  os.write(4,json.dumps({'id':m['id'],'result':{}}).encode()+b'\\0')\n`);chmodSync(stub,0o700);
 const source=desktopCdpRelay.replace("D='/run/jit-desktop'",`D=${JSON.stringify(dir)}`).replace("pwd.getpwnam('jit-desktop').pw_uid","os.geteuid()")
 .replace("incoming=b'';outgoing=b'';draining=True",`incoming=b'';outgoing=b'';draining=True\n with open(${JSON.stringify(disconnected)},'w') as f:f.write(str(offset)+','+str(len(commands)))`)
 .replace("offset+=n",`offset+=n\n    with open(${JSON.stringify(progress)},'w') as f:f.write(str(offset))`);
 writeFileSync(program,source);chmodSync(program,0o700);
 const proc=Bun.spawn([program,stub],{stdout:"ignore",stderr:"pipe"});cleanup.push(async()=>{proc.kill();await proc.exited;});
 await until(()=>existsSync(join(dir,"cdp.sock")));
 const socket=connect(join(dir,"cdp.sock"));socket.on("error",()=>{});cleanup.push(()=>{socket.destroy();});const next=frames(socket,"drain");await next();
 const first=JSON.stringify({id:1,method:"echo",params:{payload:"x".repeat(196608)}})+"\0";
 socket.write(first+JSON.stringify({id:2,method:"Page.navigate",params:{url:"https://public.org/late"}})+"\0");
 await until(()=>existsSync(progress)&&Number(readFileSync(progress,"utf8"))>0);
 expect(Number(readFileSync(progress,"utf8"))).toBeLessThan(Buffer.byteLength(first));
 socket.end();await until(()=>existsSync(disconnected));
 const [offset,queued]=readFileSync(disconnected,"utf8").split(",").map(Number);expect(offset).toBeGreaterThan(0);expect(queued).toBe(1);
 let settled=false;const ack=next().then(v=>{settled=true;return v;});await pause();expect(settled).toBe(false);expect(existsSync(received)).toBe(false);
 writeFileSync(release,"");expect(await ack).toBe('{"jit":"settled"}');expect(readFileSync(received,"utf8")).toBe("echo\n");
 const again=connect(join(dir,"cdp.sock"));again.on("error",()=>{});cleanup.push(()=>{again.destroy();});const reply=frames(again,"next controller");expect(await reply()).toBe('{"jit":"attached"}');
 again.write('{"id":1,"method":"after","params":{}}\0');expect(JSON.parse(await reply())).toEqual({id:1,result:{}});
 expect(readFileSync(received,"utf8")).toBe("echo\nafter\n");
});

test("real relay does not acknowledge a fully sent in-flight command until its reply settles",async()=>{
 const dir=directory(),entered=join(dir,"entered"),release=join(dir,"release"),stub=join(dir,"stub"),program=join(dir,"relay");
 writeFileSync(stub,`#!/usr/bin/python3\nimport os,json,time\nb=b''\nwhile b'\\0' not in b:b+=os.read(3,65536)\nm=json.loads(b.split(b'\\0')[0]);open(${JSON.stringify(entered)},'w').close()\nwhile not os.path.exists(${JSON.stringify(release)}):time.sleep(.001)\nos.write(4,json.dumps({'id':m['id'],'result':{}}).encode()+b'\\0')\nwhile os.read(3,65536):pass\n`);chmodSync(stub,0o700);
 writeFileSync(program,desktopCdpRelay.replace("D='/run/jit-desktop'",`D=${JSON.stringify(dir)}`).replace("pwd.getpwnam('jit-desktop').pw_uid","os.geteuid()"));chmodSync(program,0o700);
 const proc=Bun.spawn([program,stub],{stdout:"ignore",stderr:"pipe"});cleanup.push(async()=>{proc.kill();await proc.exited;});await until(()=>existsSync(join(dir,"cdp.sock")));
 const socket=connect(join(dir,"cdp.sock"));socket.on("error",()=>{});cleanup.push(()=>{socket.destroy();});const next=frames(socket,"inflight");await next();
 socket.write('{"id":1,"method":"Runtime.evaluate","params":{}}\0');await until(()=>existsSync(entered));socket.end();
 let settled=false;const ack=next().then(v=>{settled=true;return v;});await pause();expect(settled).toBe(false);
 writeFileSync(release,"");expect(await ack).toBe('{"jit":"settled"}');
});


test("real relay stops a navigation's delayed load and waits for stop acknowledgement before owner settlement",async()=>{
 const dir=directory(),entered=join(dir,"entered"),release=join(dir,"release"),stub=join(dir,"stub"),program=join(dir,"relay");
 writeFileSync(stub,`#!/usr/bin/python3\nimport os,json,time\nb=b''\nwhile True:\n d=os.read(3,65536)\n if not d:break\n b+=d\n while b'\\0' in b:\n  frame,b=b.split(b'\\0',1);m=json.loads(frame)\n  if m['method']=='Page.stopLoading':\n   assert m['sessionId']=='page-session'\n   open(${JSON.stringify(entered)},'w').close()\n   while not os.path.exists(${JSON.stringify(release)}):time.sleep(.001)\n  os.write(4,json.dumps({'id':m['id'],'result':{'loaderId':'still-loading'}}).encode()+b'\\0')\n`);chmodSync(stub,0o700);
 writeFileSync(program,desktopCdpRelay.replace("D='/run/jit-desktop'",`D=${JSON.stringify(dir)}`).replace("pwd.getpwnam('jit-desktop').pw_uid","os.geteuid()"));chmodSync(program,0o700);
 const proc=Bun.spawn([program,stub],{stdout:"ignore",stderr:"pipe"});cleanup.push(async()=>{proc.kill();await proc.exited;});await until(()=>existsSync(join(dir,"cdp.sock")));
 const socket=connect(join(dir,"cdp.sock"));socket.on("error",()=>{});cleanup.push(()=>{socket.destroy();});const next=frames(socket,"stop loading");await next();
 socket.write('{"id":1,"method":"Page.navigate","params":{"url":"https://public.org/"},"sessionId":"page-session"}\0');expect(JSON.parse(await next()).result.loaderId).toBe("still-loading");socket.end();
 await until(()=>existsSync(entered));let settled=false;const ack=next().then(v=>{settled=true;return v;});await pause();expect(settled).toBe(false);
 writeFileSync(release,"");expect(await ack).toBe('{"jit":"settled"}');
});

test("attach EOF without the relay drain acknowledgement is not a successful settlement",async()=>{
 const dir=directory(),path=join(dir,"no-ack.sock"),server=createServer(socket=>socket.on("end",()=>socket.end()));
 await new Promise<void>(resolve=>server.listen(path,resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const program=desktopCdpAttach.replace("'/run/jit-desktop/cdp.sock'",JSON.stringify(path));
 const proc=Bun.spawn(["python3","-I","-u","-c",program],{stdin:"pipe",stdout:"ignore",stderr:"ignore"});cleanup.push(async()=>{proc.kill();await proc.exited;});
 proc.stdin.end();expect(await proc.exited).toBe(1);
});

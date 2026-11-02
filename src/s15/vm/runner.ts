/**
 * Credential-free Linux helper delivered over a host-initiated SSH channel. Root can replace/forge it;
 * it supplies bounded file/process observations, never protected policy or hypervisor attestations.
 */
export const vmRunnerSource = String.raw`
import os,sys,json,base64,hashlib,stat,tempfile,subprocess,selectors,time,signal,errno
MAX=16777216
r=json.loads(sys.stdin.buffer.read(MAX+1)); op=r['op']; root=r['root']; tmp=r['tmp']; cap=r['cap']
def fail(code): raise OSError(getattr(errno,code,errno.EIO),code)
def path(p):
 if not isinstance(p,str) or len(p.encode())>4096 or any(ord(c)<32 for c in p) or any(c in ('.','..') for c in p.split('/')) or not any(p==x or p.startswith(x+'/') for x in (root,tmp)): fail('EACCES')
 return p
def parent(p,create=False):
 path(p); parts=p.strip('/').split('/'); fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in parts[:-1]:
   if create:
    try: os.mkdir(part,0o700,dir_fd=fd)
    except FileExistsError: pass
   new=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=new
  return fd,parts[-1]
 except: os.close(fd); raise
def filedata(p):
 fd,name=parent(p)
 try:
  f=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=fd)
  try:
   s=os.fstat(f)
   if not stat.S_ISREG(s.st_mode): fail('EACCES')
   if s.st_size>cap: fail('EFBIG')
   data=os.read(f,cap+1)
   if len(data)>cap: fail('EFBIG')
   return data
  finally: os.close(f)
 finally: os.close(fd)
def observe(p):
 fd,name=parent(p)
 try:
  try: s=os.stat(name,dir_fd=fd,follow_symlinks=False)
  except FileNotFoundError: return None
  if not stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode): fail('EACCES')
  b=os.readlink(name,dir_fd=fd).encode() if stat.S_ISLNK(s.st_mode) else filedata(p)
  return hashlib.sha256(('%s:%s:%s:%s:%s:'%(s.st_dev,s.st_ino,s.st_mode,s.st_mtime_ns,s.st_size)).encode()+b).hexdigest()
 finally: os.close(fd)
def listing(p,recursive=False):
 path(p); out=[]; deadline=time.monotonic()+10
 def walk(d):
  fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   for name in sorted(os.listdir(fd)):
    if len(out)>=10000 or time.monotonic()>deadline: fail('EFBIG')
    s=os.stat(name,dir_fd=fd,follow_symlinks=False); full=d+'/'+name
    kind='symlink' if stat.S_ISLNK(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'other'
    out.append({'name':full[len(p)+1:] if recursive else name,'type':kind})
    if recursive and kind=='directory': walk(full)
  finally: os.close(fd)
 walk(p); return out
try:
 if op=='init':
  for p in (root,tmp):
   fd,name=parent(p,True)
   try:
    try: os.mkdir(name,0o700,dir_fd=fd)
    except FileExistsError: pass
    f=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(f)
   finally: os.close(fd)
  result={}
 elif op=='realpath':
  p=path(r['path']); fd,name=parent(p)
  try: os.stat(name,dir_fd=fd,follow_symlinks=False)
  finally: os.close(fd)
  real=path(os.path.realpath(p)); result={'path':real}
 elif op=='stat':
  fd,name=parent(r['path'])
  try: s=os.stat(name,dir_fd=fd,follow_symlinks=False)
  finally: os.close(fd)
  if stat.S_ISLNK(s.st_mode): fail('EACCES')
  result={'type':'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'other'}
 elif op=='read': result={'data':base64.b64encode(filedata(r['path'])).decode()}
 elif op=='observe':
  p=path(r['path']); token=observe(p)
  result={'token':token,'data':base64.b64encode(filedata(p)).decode() if token and r['content'] else None}
 elif op in ('write','private'):
  p=path(r['path']); data=base64.b64decode(r['data'],validate=True)
  if len(data)>cap: fail('EFBIG')
  fd,name=parent(p,r.get('createParents',False)); staged=None
  try:
   if 'observed' in r and observe(p)!=r['observed']: raise RuntimeError('ECHANGED')
   staged='.jit-'+os.urandom(16).hex(); f=os.open(staged,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
   try:
    with os.fdopen(f,'wb') as stream: stream.write(data); stream.flush(); os.fsync(stream.fileno())
    if 'observed' in r and observe(p)!=r['observed']: raise RuntimeError('ECHANGED')
    os.replace(staged,name,src_dir_fd=fd,dst_dir_fd=fd); staged=None; os.fsync(fd)
   finally:
    if staged: os.unlink(staged,dir_fd=fd)
  finally: os.close(fd)
  result={}
 elif op=='list': result={'entries':listing(r['path'],r.get('recursive',False))}
 elif op in ('spawn','search'):
  path(r['cwd']); environment={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':root,'LANG':'C.UTF-8','TZ':'UTC'}; environment.update(r.get('env',{}))
  if op=='search':
   path(r['path']);command=['/usr/bin/rg','--json','--no-follow','--max-count',str(r['limit'])]+(['--ignore-case'] if r['ignoreCase'] else [])+(['--glob',r['glob']] if r['glob'] is not None else [])+['--',r['pattern'],r['path']]
  else: command=['/bin/bash','--noprofile','--norc','-c',r['command']]
  proc=subprocess.Popen(command,cwd=r['cwd'],env=environment,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  sel=selectors.DefaultSelector(); sel.register(proc.stdout,selectors.EVENT_READ,'stdout'); sel.register(proc.stderr,selectors.EVENT_READ,'stderr'); out={'stdout':bytearray(),'stderr':bytearray()}; end=time.monotonic()+r['timeoutMs']/1000; timed=False; truncated=False; total=0
  while sel.get_map():
   if time.monotonic()>=end:
    timed=True
    try: os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    break
   for key,_ in sel.select(min(.1,max(0,end-time.monotonic()))):
    b=os.read(key.fileobj.fileno(),65536)
    if not b: sel.unregister(key.fileobj); key.fileobj.close(); continue
    total+=len(b); keep=min(len(b),max(0,cap-sum(len(v) for v in out.values()))); out[key.data].extend(b[:keep]); truncated=truncated or keep<len(b)
  if timed:
   for key in list(sel.get_map().values()): key.fileobj.close()
  sel.close(); code=proc.wait(timeout=2)
  result={k:base64.b64encode(v).decode() for k,v in out.items()}; result.update({'exitCode':code if code>=0 and not timed else None,'timedOut':timed,'truncated':truncated,'totalBytes':total})
 else: fail('EINVAL')
 response={'v':1,'id':r['id'],'ok':True,'result':result}
except Exception as e:
 code='ECHANGED' if str(e)=='ECHANGED' else errno.errorcode.get(getattr(e,'errno',None),'EIO')
 response={'v':1,'id':r['id'],'ok':False,'code':code}
sys.stdout.write(json.dumps(response,sort_keys=True,separators=(',',':'),ensure_ascii=False))
`;

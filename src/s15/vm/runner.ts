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
def anchored(p,directory=False):
 fd,name=parent(p)
 try: return os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW|(os.O_DIRECTORY if directory else 0),dir_fd=fd)
 finally: os.close(fd)
def listing(p,recursive=False):
 out=[]; deadline=time.monotonic()+10
 def walk(fd,prefix):
  try:
   for name in sorted(os.listdir(fd)):
    if len(out)>=10000 or time.monotonic()>deadline: fail('EFBIG')
    s=os.stat(name,dir_fd=fd,follow_symlinks=False); relative=prefix+name
    kind='symlink' if stat.S_ISLNK(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'other'
    out.append({'name':relative if recursive else name,'type':kind})
    if recursive and kind=='directory': walk(os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd),relative+'/')
  finally: os.close(fd)
 walk(anchored(p,True),''); return out
def portable_data(p):
 f=anchored(p)
 try:
  before=os.fstat(f)
  if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>1048576: fail('EACCES')
  data=bytearray()
  while len(data)<=1048576:
   b=os.read(f,min(65536,1048577-len(data)))
   if not b: break
   data.extend(b)
  after=os.fstat(f)
  if len(data)!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise RuntimeError('ECHANGED')
  return bytes(data)
 finally: os.close(f)
def portable_manifest():
 files=r['files']; seen=set(); total=0
 if not isinstance(files,list) or not 1<=len(files)<=64: fail('E2BIG')
 for item in files:
  p=item['path']; parts=p.split('/')
  if not p or len(p.encode())>240 or len(parts)>16 or any(not x or x in ('.','..') or x.startswith('.') for x in parts) or '\\' in p or ':' in p or '%' in p or any(ord(c)<=32 or ord(c)==127 for c in p): fail('EACCES')
  if p.lower() in seen or not isinstance(item['bytes'],int) or not 0<=item['bytes']<=1048576: fail('E2BIG')
  seen.add(p.lower()); total+=item['bytes']
 if total>16777216: fail('E2BIG')
 text=json.dumps({'contract':'s16-working-tree/v1','files':files},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
 if hashlib.sha256(text).hexdigest()!=r['treeSha256']: raise RuntimeError('ECHANGED')
 return files
def portable_location(committed=False):
 ident=r['importId']
 if len(ident)!=32 or any(c not in '0123456789abcdef' for c in ident): fail('EINVAL')
 return path(root+('/restored-' if committed else '/.jit-import-')+ident)
def portable_verify(folder,files):
 expected={'.jit-manifest':'file'}
 for item in files:
  pieces=item['path'].split('/')
  for i in range(1,len(pieces)): expected['/'.join(pieces[:i])]='directory'
  expected[item['path']]='file'
 entries=listing(folder,True)
 if {item['name']:item['type'] for item in entries}!=expected: raise RuntimeError('ECHANGED')
 for item in files:
  data=portable_data(folder+'/'+item['path'])
  if len(data)!=item['bytes'] or hashlib.sha256(data).hexdigest()!=item['sha256']: raise RuntimeError('ECHANGED')
 for entry in entries:
  if entry['type']=='directory':
   f=anchored(folder+'/'+entry['name'],True)
   try: os.fsync(f)
   finally: os.close(f)
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
 elif op=='portable_read': result={'data':base64.b64encode(portable_data(path(r['path']))).decode()}
 elif op in ('portable_begin','portable_put','portable_commit','portable_inspect'):
  files=portable_manifest(); stage=portable_location(); target=portable_location(True)
  manifest=json.dumps({'contract':'s16-working-tree/v1','importId':r['importId'],'treeSha256':r['treeSha256'],'files':files},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
  if op=='portable_begin':
   f=anchored(root,True)
   try:
    if set(os.listdir(f))!={os.path.basename(tmp)}: fail('EACCES')
    os.mkdir(os.path.basename(stage),0o700,dir_fd=f); os.fsync(f)
   finally: os.close(f)
   fd,name=parent(stage+'/.jit-manifest')
   try:
    f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    with os.fdopen(f,'wb') as stream: stream.write(manifest); stream.flush(); os.fsync(stream.fileno())
    os.fsync(fd)
   finally: os.close(fd)
   result={}
  elif op=='portable_put':
   if portable_data(stage+'/.jit-manifest')!=manifest: raise RuntimeError('ECHANGED')
   chosen=next((item for item in files if item['path']==r['relative']),None); data=base64.b64decode(r['data'],validate=True)
   if not chosen or len(data)!=chosen['bytes'] or hashlib.sha256(data).hexdigest()!=chosen['sha256']: raise RuntimeError('ECHANGED')
   fd,name=parent(stage+'/'+chosen['path'],True)
   try:
    f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    with os.fdopen(f,'wb') as stream: stream.write(data); stream.flush(); os.fsync(stream.fileno())
    os.fsync(fd)
   finally: os.close(fd)
   result={}
  elif op=='portable_commit':
   if portable_data(stage+'/.jit-manifest')!=manifest: raise RuntimeError('ECHANGED')
   portable_verify(stage,files)
   import ctypes
   libc=ctypes.CDLL(None,use_errno=True); rename=libc.renameat2
   rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]; rename.restype=ctypes.c_int
   fd=anchored(root,True)
   try:
    if rename(fd,os.path.basename(stage).encode(),fd,os.path.basename(target).encode(),1)!=0: raise OSError(ctypes.get_errno(),'renameat2')
    os.fsync(fd)
   finally: os.close(fd)
   result={'path':target}
  else:
   try:
    if portable_data(target+'/.jit-manifest')!=manifest: raise RuntimeError('ECHANGED')
    portable_verify(target,files); result={'path':target}
   except FileNotFoundError: result={'path':None}
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
  opened=[]; searchDirectory=False
  if op=='search':
   try:
    cwdFd=anchored(r['cwd'],True);opened.append(cwdFd)
    targetFd=anchored(r['path']);opened.append(targetFd);targetStat=os.fstat(targetFd);searchDirectory=stat.S_ISDIR(targetStat.st_mode)
    if not searchDirectory and not stat.S_ISREG(targetStat.st_mode): fail('EACCES')
    cwdFd=targetFd if searchDirectory else cwdFd
    command=['/usr/bin/rg','--json','--no-follow','--max-count',str(r['limit'])]+(['--ignore-case'] if r['ignoreCase'] else [])+(['--glob',r['glob']] if r['glob'] is not None else [])+['--',r['pattern'],'.' if searchDirectory else '-']
    proc=subprocess.Popen(command,preexec_fn=lambda:os.fchdir(cwdFd),pass_fds=(cwdFd,),env=environment,stdin=subprocess.DEVNULL if searchDirectory else targetFd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
   finally:
    for fd in opened: os.close(fd)
  else: command=['/bin/bash','--noprofile','--norc','-c',r['command']]
  if op=='spawn': proc=subprocess.Popen(command,cwd=r['cwd'],env=environment,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
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
  if op=='search' and not timed and not truncated:
   rewritten=bytearray()
   for line in out['stdout'].splitlines():
    event=json.loads(line); item=event.get('data',{}).get('path',{})
    if isinstance(item.get('text'),str):
     if searchDirectory and item['text'].startswith('./'): item['text']=r['path']+'/'+item['text'][2:]
     elif not searchDirectory and item['text']=='<stdin>': item['text']=r['path']
    data=(json.dumps(event,separators=(',',':'),ensure_ascii=False)+'\n').encode();budget=max(0,cap-len(out['stderr'])-len(rewritten));rewritten.extend(data[:budget])
    if len(data)>budget: truncated=True;break
   out['stdout']=rewritten;total=len(rewritten)+len(out['stderr'])+(1 if truncated else 0)
  result={k:base64.b64encode(v).decode() for k,v in out.items()}; result.update({'exitCode':code if code>=0 and not timed else None,'timedOut':timed,'truncated':truncated,'totalBytes':total})
 else: fail('EINVAL')
 response={'v':1,'id':r['id'],'ok':True,'result':result}
except Exception as e:
 code='ECHANGED' if str(e)=='ECHANGED' else errno.errorcode.get(getattr(e,'errno',None),'EIO')
 response={'v':1,'id':r['id'],'ok':False,'code':code}
sys.stdout.write(json.dumps(response,sort_keys=True,separators=(',',':'),ensure_ascii=False))
`;

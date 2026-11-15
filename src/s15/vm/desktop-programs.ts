/** Fixed guest programs for the watched desktop browser (ADR 0092). No TCP DevTools listener. */
export const desktopSessionRevision = "cdp-1";

/** The session loop runs this, not Chromium directly. A disconnect never ends the browser. */
export const desktopCdpRelay = String.raw`#!/usr/bin/python3 -Iu
import json,os,pwd,select,signal,socket,stat,subprocess,sys
D='/run/jit-desktop';P=D+'/cdp.sock';LIMIT=1048576
s=os.lstat(D);uid=pwd.getpwnam('jit-desktop').pw_uid
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid or stat.S_IMODE(s.st_mode)!=0o700:sys.exit(1)
chrome=None;listener=None;client=None;fds=[]
incoming=b'';outgoing=b'';commands=b'';messages=b'';pending={};sequence=0
def stop(*_):raise SystemExit(0)
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
def disconnect():
 global client,incoming,outgoing
 if client:client.close()
 client=None;incoming=b'';outgoing=b'';pending.clear()
try:
 try:os.unlink(P)
 except FileNotFoundError:pass
 listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 listener.bind(P);os.chmod(P,0o600);listener.listen(4);listener.setblocking(False)
 r,w=os.pipe();o,i=os.pipe();fds=[r,w,o,i]
 for fd in (w,o):os.set_blocking(fd,False)
 def child():
  a,b=os.dup(r),os.dup(i)
  os.dup2(a,3);os.dup2(b,4)
 chrome=subprocess.Popen(sys.argv[1:]+['--remote-debugging-pipe'],preexec_fn=child,close_fds=False,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 os.close(r);fds.remove(r);os.close(i);fds.remove(i)
 while chrome.poll() is None:
  reads=[listener,o]+([client] if client else [])
  writes=([w] if commands else [])+([client] if client and outgoing else [])
  ready,writable,_=select.select(reads,writes,[],0.2)
  if listener in ready:
   c,_=listener.accept();c.settimeout(1)
   try:c.sendall(b'{"jit":"busy"}\0' if client else b'{"jit":"attached"}\0')
   except OSError:c.close();continue
   if client:c.close()
   else:c.setblocking(False);client=c
  if client and client in ready:
   try:data=client.recv(65536)
   except BlockingIOError:continue
   except OSError:data=b''
   if not data:disconnect()
   else:
    incoming+=data
    while b'\0' in incoming:
     frame,incoming=incoming.split(b'\0',1)
     if len(frame)>LIMIT:disconnect();break
     try:
      message=json.loads(frame)
      if not isinstance(message,dict) or not isinstance(message.get('id'),int) or not isinstance(message.get('method'),str):raise ValueError()
      sequence+=1
      if len(pending)>=1024:raise ValueError()
      original=message['id'];message['id']=sequence
      frame=json.dumps(message,separators=(',',':')).encode()
      if len(frame)>LIMIT or len(commands)+len(frame)+1>2*LIMIT:raise ValueError()
      pending[sequence]=original;commands+=frame+b'\0'
     except (ValueError,TypeError):disconnect();break
    if len(incoming)>LIMIT:disconnect()
  if w in writable and commands:
   try:n=os.write(w,commands);commands=commands[n:]
   except BlockingIOError:pass
  if o in ready:
   try:data=os.read(o,65536)
   except BlockingIOError:continue
   if not data:break
   messages+=data
   while b'\0' in messages:
    frame,messages=messages.split(b'\0',1)
    if len(frame)>LIMIT:raise SystemExit(1)
    try:
     message=json.loads(frame)
     if 'id' in message:
      original=pending.pop(message['id'],None)
      if original is None:continue
      message['id']=original;frame=json.dumps(message,separators=(',',':')).encode()
    except (ValueError,TypeError,KeyError):raise SystemExit(1)
    if client:
     if len(outgoing)+len(frame)+1>2*LIMIT:disconnect()
     else:outgoing+=frame+b'\0'
   if len(messages)>LIMIT:raise SystemExit(1)
  if client and client in writable:
   try:n=client.send(outgoing);outgoing=outgoing[n:]
   except BlockingIOError:pass
   except OSError:disconnect()
finally:
 disconnect()
 if listener:listener.close()
 for fd in fds:os.close(fd)
 try:os.unlink(P)
 except FileNotFoundError:pass
 if chrome:
  if chrome.poll() is None:
   os.killpg(chrome.pid,signal.SIGTERM)
   try:chrome.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(chrome.pid,signal.SIGKILL)
  chrome.wait()

`;

/** Bidirectional, unbuffered byte copier. stdout contains only relay bytes, including its first handshake. */
export const desktopCdpAttach = String.raw`#!/usr/bin/python3 -Iu
import os,select,socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect('/run/jit-desktop/cdp.sock')
def write(fd,data):
 while data:
  n=os.write(fd,data);data=data[n:]
try:
 while True:
  ready,_,_=select.select([0,s],[],[])
  if 0 in ready:
   data=os.read(0,65536)
   if not data:break
   s.sendall(data)
  if s in ready:
   data=s.recv(65536)
   if not data:break
   write(1,data)
finally:s.close()
`;

import type { VmSshTransport } from "./transport";
import { vmFail, vmRecord } from "./validation";

/** Fixed direct-egress probe. Success is a refusal signal; guest-reported failure alone never proves external isolation. */
export async function probeVmDirectEgress(transport: VmSshTransport): Promise<boolean> {
  const source = `import socket,json,concurrent.futures\ntargets=[(socket.AF_INET,socket.SOCK_STREAM,'1.1.1.1',443),(socket.AF_INET,socket.SOCK_STREAM,'1.1.1.1',80),(socket.AF_INET6,socket.SOCK_STREAM,'2606:4700:4700::1111',443),(socket.AF_INET,socket.SOCK_DGRAM,'1.1.1.1',53),(socket.AF_INET,socket.SOCK_STREAM,'169.254.169.254',80),(socket.AF_INET,socket.SOCK_STREAM,'192.168.5.2',22)]\ndef check(t):\n s=socket.socket(t[0],t[1]);s.settimeout(1)\n try:\n  s.connect((t[2],t[3]))\n  if t[1]==socket.SOCK_DGRAM:\n   s.send(bytes.fromhex('123401000001000000000000076578616d706c6503636f6d0000010001'));s.recv(512)\n  return True\n except OSError:return False\n finally:s.close()\nwith concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:print(json.dumps({'reachable':list(pool.map(check,targets))},separators=(',',':')))\n`;
  let result: unknown;
  try { result = JSON.parse(await transport.control(["sudo", "-n", "python3", "-I", "-c", source], { timeoutMs: 6000, maxBytes: 1024 })); }
  catch { vmFail("vm_network_unproven"); }
  const r = vmRecord(result, ["reachable"]);
  if (!Array.isArray(r.reachable) || r.reachable.length !== 6 || r.reachable.some(v => typeof v !== "boolean")) vmFail("vm_network_unproven");
  return r.reachable.every(v => v === false);
}

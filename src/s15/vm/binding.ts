import type { VmEndpoint, VmMachineState } from "./types";
import type { VmSshTransport } from "./transport";

/** Matches the pinned SSH guest to the protected hypervisor NIC, including Lima's host-forward endpoint. */
export async function vmIdentityMatches(transport: VmSshTransport, machine: VmMachineState, endpoint: VmEndpoint): Promise<boolean> {
  if (machine.state !== "running" || !machine.nicMac || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(machine.nicMac) || machine.nicMac === "00:00:00:00:00:00" || (parseInt(machine.nicMac.slice(0, 2), 16) & 1)) return false;
  if (machine.sshEndpoint && (endpoint.host !== machine.sshEndpoint.host || endpoint.port !== machine.sshEndpoint.port)) return false;
  try {
    const output = await transport.control(["sudo", "-n", "python3", "-I", "-c",
      "import glob,json;print(json.dumps({'nicMacs':[open(p).read().strip().lower() for p in glob.glob('/sys/class/net/*/address')]},separators=(',',':')))"]);
    const value = JSON.parse(output);
    return Object.keys(value).length === 1 && Array.isArray(value.nicMacs) && value.nicMacs.length <= 64 &&
      value.nicMacs.every((mac: unknown) => typeof mac === "string" && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) && value.nicMacs.includes(machine.nicMac);
  } catch { return false; }
}

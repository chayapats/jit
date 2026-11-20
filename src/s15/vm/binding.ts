import type { VmEndpoint, VmMachineState, VmPhysicalBinding } from "./types";
import type { VmSshTransport } from "./transport";

type RegisteredBinding = { bindingMac?: string; binding?: VmPhysicalBinding };
const mac = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(value) && value !== "00:00:00:00:00:00" && !(parseInt(value.slice(0, 2), 16) & 1);
const port = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 0xffffffff;
/** Reads a closed protected binding, retaining format-1 NIC rows without manufacturing a dummy MAC. */
export function vmPhysicalBinding(row: RegisteredBinding): VmPhysicalBinding | null {
  if (row.binding === undefined) return mac(row.bindingMac) ? { kind: "nic", mac: row.bindingMac } : null;
  if (row.bindingMac !== undefined || !row.binding || typeof row.binding !== "object" || Array.isArray(row.binding)) return null;
  const binding = row.binding;
  if (binding.kind === "nic") return Object.keys(binding).sort().join() === "kind,mac" && mac(binding.mac) ? { ...binding } : null;
  if (binding.kind !== "firecracker-vsock" || Object.keys(binding).sort().join() !== "guestCid,guestPort,instanceId,kind,selectionSha256" ||
    typeof binding.instanceId !== "string" || !/^jit-work(?:-[a-z0-9-]{1,54})?$/.test(binding.instanceId) || !port(binding.guestCid) || binding.guestCid < 3 || !port(binding.guestPort) ||
    typeof binding.selectionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(binding.selectionSha256)) return null;
  return { ...binding };
}
/** An absent, malformed or ambiguous binding never admits work or protected lifecycle operations. */
export function vmHasBinding(row: RegisteredBinding): boolean { return vmPhysicalBinding(row) !== null; }
const observed = (machine: VmMachineState): VmPhysicalBinding | null => vmPhysicalBinding({ ...(machine.nicMac === undefined ? {} : { bindingMac: machine.nicMac }), ...(machine.binding === undefined ? {} : { binding: machine.binding }) });
const same = (a: VmPhysicalBinding, b: VmPhysicalBinding) => a.kind === "nic" ? b.kind === "nic" && a.mac === b.mac : b.kind === "firecracker-vsock" && a.instanceId === b.instanceId && a.guestCid === b.guestCid && a.guestPort === b.guestPort && a.selectionSha256 === b.selectionSha256;
/** Checks stable protected management identity across stops/starts; running connections are checked separately. */
export function vmManagementMatches(row: RegisteredBinding & { machineIdentity: string | null }, machine: VmMachineState): boolean {
  const expected = vmPhysicalBinding(row);
  if (!expected || machine.identity !== row.machineIdentity) return false;
  // Existing Lima/Proxmox stopped reports may omit their NIC. Preserve that exact legacy stop contract.
  if (expected.kind === "nic" && machine.state === "stopped" && machine.nicMac === undefined && machine.binding === undefined) return true;
  const actual = observed(machine); return actual !== null && same(expected, actual);
}
/** Matches pinned SSH to a protected NIC or the exact verified NIC-free host forwarder; never a guest echo. */
export async function vmIdentityMatches(transport: VmSshTransport, machine: VmMachineState, endpoint: VmEndpoint): Promise<boolean> {
  const binding = observed(machine);
  if (machine.state !== "running" || !binding) return false;
  if (machine.sshEndpoint && (endpoint.host !== machine.sshEndpoint.host || endpoint.port !== machine.sshEndpoint.port)) return false;
  if (binding.kind === "firecracker-vsock") return !!machine.sshEndpoint && endpoint.host === "127.0.0.1" && Number.isSafeInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535 &&
    (["host", "port", "user", "identityFile", "knownHostsFile"] as const).every(key => transport.endpoint[key] === endpoint[key]);
  try {
    const output = await transport.control(["sudo", "-n", "python3", "-I", "-c",
      "import glob,json;print(json.dumps({'nicMacs':[open(p).read().strip().lower() for p in glob.glob('/sys/class/net/*/address')]},separators=(',',':')))"]);
    const value = JSON.parse(output);
    return Object.keys(value).length === 1 && Array.isArray(value.nicMacs) && value.nicMacs.length <= 64 &&
      value.nicMacs.every((mac: unknown) => typeof mac === "string" && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) && value.nicMacs.includes(binding.mac);
  } catch { return false; }
}

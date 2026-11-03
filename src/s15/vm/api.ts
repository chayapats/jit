import { AppError } from "../../errors";
import { vmRecord } from "./validation";
import type { VmManagers, VmManagerInput } from "./managers";
import type { WorkingVmService } from "./service";
import type { VmEnrollment } from "./enrollment";

/** Protected JSON API only. Authentication/CSRF/Host checks run at the owning ingress before issuing an actor. */
export function createVmApi(enrollment: VmEnrollment, authenticate: (request: Request) => Promise<object>, options: { managers?: VmManagers; service?: WorkingVmService } = {}): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const actor = await authenticate(request), url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/s15/vm/registries") return Response.json({ hosts: enrollment.registryHosts(actor) });
      if (request.method === "GET" && url.pathname === "/s15/vm/status") return Response.json(enrollment.status(actor, url.searchParams.get("id") ?? ""));
      if (request.method === "GET" && url.pathname === "/s15/vm/resources" && options.managers) return Response.json(options.managers.resources(actor, url.searchParams.get("managerId") ?? ""), { headers: { "Cache-Control": "no-store" } });
      if (request.method !== "POST" || !request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "vm_invalid_setup" }, { status: 400 });
      const reader = request.body?.getReader(); let body = Buffer.alloc(0);
      if (reader) try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (body.length + value.length > 16384) throw new AppError("vm_invalid_setup", 413); body = Buffer.concat([body, value]); } } finally { await reader.cancel(); }
      let data: unknown; try { data = JSON.parse(body.toString("utf8")); } catch { throw new AppError("vm_invalid_setup", 400); }
      if (url.pathname === "/s15/vm/management" && options.managers) return Response.json(options.managers.register(actor, data as VmManagerInput));
      if (url.pathname === "/s15/vm/resources" && options.managers) {
        const input = vmRecord(data, ["managerId", "cpus", "memoryMiB", "diskGiB"]), { managerId, ...resources } = input;
        return Response.json(options.managers.setResources(actor, managerId as string, resources));
      }
      if (url.pathname === "/s15/vm/start" && options.service) { const input = vmRecord(data, ["vmId"]); await options.service.start(actor, input.vmId as string); return Response.json({ state: "ready" }); }
      if (url.pathname === "/s15/vm/recover" && options.service) {
        vmRecord(data, ["vmId"], ["snapshotId"]); await options.service.recover(actor, data as Parameters<WorkingVmService["recover"]>[1]); return Response.json({ state: "stopped" });
      }
      if (url.pathname === "/s15/vm/snapshots/retire" && options.service) {
        vmRecord(data, ["vmId", "snapshotId"]); await options.service.retireSnapshot(actor, data as Parameters<WorkingVmService["retireSnapshot"]>[1]); return Response.json({ state: "retired" });
      }
      if (url.pathname === "/s15/vm/setup") { vmRecord(data, []); return Response.json(await enrollment.begin(actor)); }
      if (url.pathname === "/s15/vm/check") {
        vmRecord(data, ["setupId", "host"], ["port", "user", "managerId"]);
        return Response.json(await enrollment.checkMachine(actor, data as Parameters<VmEnrollment["checkMachine"]>[1]));
      }
      if (url.pathname === "/s15/vm/enroll") {
        vmRecord(data, ["id", "checkId", "fingerprint", "transportProfile"], ["maxSessions"]);
        return Response.json(await enrollment.useMachine(actor, data as Parameters<VmEnrollment["useMachine"]>[1]));
      }
      if (url.pathname === "/s15/vm/registries") { const input = vmRecord(data, ["hosts"]); return Response.json({ hosts: enrollment.setRegistryHosts(actor, input.hosts as string[]) }); }
      if (url.pathname === "/s15/vm/settings") {
        const input = vmRecord(data, ["id", "maxSessions"]); return Response.json(enrollment.setMaxSessions(actor, input.id as string, input.maxSessions as number));
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) { return Response.json({ error: error instanceof AppError ? error.code : "vm_connection_failed" }, { status: error instanceof AppError ? error.status : 503 }); }
  };
}

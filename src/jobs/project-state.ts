import type { TransactionStore } from "../store";
import type { WorkDefinition } from "./types";

/** Registers a bounded service-owned project inspection with no model, tool loop or external request. */
export function projectStateWork(store: TransactionStore): WorkDefinition {
  return {
    id: "project.status", title: "ตรวจสถานะโครงการ", revision: 1,
    route: { provider: "jit-service", model: null, authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: (input, scope) => !!input && typeof input === "object" && !Array.isArray(input) && !Object.keys(input).length && scope.inputRevision === scope.projectRevision,
    run: ({ job, signal }) => {
      if (signal.aborted) return { state: "failed", reason: "worker_failed" };
      const project = store.read(tx => tx.get<{ name: string; revision: number }>("SELECT name, revision FROM projects WHERE id = ? AND revision = ?", job.projectId, job.inputRevision));
      return project ? { state: "succeeded", evidence: `โครงการ: ${project.name}\nRevision: ${project.revision}\nอ่านสถานะโครงการที่บันทึกแล้วสำเร็จ` }
        : { state: "failed", reason: "worker_failed" };
    },
  };
}

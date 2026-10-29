import { assertExecutionAllowed } from "../exec/access";
import type { AppTransaction } from "../store";
import type { ApplicationRunRequest } from "../team/types";

/** Common service-state fence, independent of web settings and box grants; halt, stop, owner reset and retirement refuse calls. */
export function serviceToolCurrent(tx: AppTransaction, request: ApplicationRunRequest): boolean {
  const authority = tx.get<{ generation: number; reason: string | null }>("SELECT generation, reason FROM job_authority WHERE job_id = ?", request.fence.jobId);
  if (!authority || authority.generation !== request.fence.generation || authority.reason !== null) return false;
  if (tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation !== request.fence.ownerGeneration) return false;
  if (tx.get<{ state: string }>("SELECT state FROM jobs WHERE id = ?", request.fence.jobId)?.state !== "admitted") return false;
  if (tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", request.context.id, request.context.generation)?.state !== "active") return false;
  try { assertExecutionAllowed(tx, request.projectId, request.roleId, "read"); } catch { return false; }
  return true;
}

import { hostCapabilities, type HostImageProbeRecord } from "schway/host";
import type { AppTransaction } from "../store";

/** Credential-free receipt of one explicitly confirmed, exact-route/model Web probe. Pending/crashed actions never authorize images. */
export interface ImageProbeReceipt { imageProbe: { state: "running" | "complete" | "failed"; record: HostImageProbeRecord } }

/** Read the latest result per exact route/model, validating through Schway's public capability API; a new pin requires fresh evidence. */
export function readImageProbes(tx: AppTransaction, revision: string): readonly HostImageProbeRecord[] {
  const rows = tx.all<{ record: string }>(`SELECT c.result_json AS record FROM command_receipts c JOIN audit a
    ON a.actor_id = c.actor_id AND a.request_id = c.request_id WHERE a.command_kind = 'attachments.image_probe'
    ORDER BY a.id DESC LIMIT 256`);
  const seen = new Set<string>(), records: HostImageProbeRecord[] = [];
  for (const row of rows) {
    try {
      const probe = (JSON.parse(row.record) as ImageProbeReceipt).imageProbe;
      const record = probe.record, key = `${record.route}/${record.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!["complete", "failed"].includes(probe.state) || (probe.state !== "complete" && record.verdict === "pass") || record.revision !== revision) continue;
      hostCapabilities([record]); // invokes imageProbeRecords validation without private Schway imports
      records.push(record);
    } catch { return []; /* Unidentifiable/corrupt latest evidence cannot reinstate an older pass. */ }
  }
  return records;
}

/** True only for an advertised exact route/model with explicit passing evidence; never infers support from login or text success. */
export function imageRoutePassed(records: readonly HostImageProbeRecord[], route: { provider: string; model: string }): boolean {
  const capabilities = hostCapabilities(records);
  return capabilities.imageInputContract === "schway.host.image-input/v1" && capabilities.imageInputRoutes.some(item => item.route === route.provider && item.passedModels.includes(route.model));
}

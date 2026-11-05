import type { HostImageProbeRecord } from "schway/host";
import { AppError } from "../../errors";
import { pinnedImagePattern } from "../../exec/box-runtime";
import { SCHWAY_PINNED_REVISION } from "../../schway-version";

/** Owner-controlled, credential-free opt-in. Probes describe the configured live account/route. */
export interface BinaryFileConfig { parserImage: string; imageProbes: HostImageProbeRecord[] }
/** Dependency-free installer validation; the runtime additionally validates through Schway's public API. */
export function validateBinaryFileConfig(raw: unknown): asserts raw is BinaryFileConfig {
  const value = raw as BinaryFileConfig;
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "imageProbes,parserImage" || typeof value.parserImage !== "string" || !pinnedImagePattern.test(value.parserImage) || !Array.isArray(value.imageProbes) || value.imageProbes.length > 32) throw new AppError("invalid_s15_config");
  for (const probe of value.imageProbes) {
    if (!probe || typeof probe !== "object" || Object.keys(probe).sort().join() !== "contract,model,revision,route,testedAt,verdict" || probe.contract !== "schway.host.image-input/v1" || !["codex", "grok"].includes(probe.route) || typeof probe.model !== "string" || !probe.model.trim() || probe.model.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(probe.model) || probe.revision !== SCHWAY_PINNED_REVISION || typeof probe.testedAt !== "string" || probe.testedAt.length > 64 || !Number.isFinite(Date.parse(probe.testedAt)) || !["pass", "unsupported", "inconclusive"].includes(probe.verdict)) throw new AppError("invalid_s15_config");
  }
  if (new Set(value.imageProbes.map(p => `${p.route}/${p.model}`)).size !== value.imageProbes.length) throw new AppError("invalid_s15_config");
}

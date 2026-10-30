import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHost, hostCapabilities, RELEASE_CONTRACT } from "schway/host";
import { AppError } from "../errors";
import { s14CredentialLifecycle } from "./lifecycle";
import type { NativeIntent, NativeRecoveryPort } from "./recovery-types";
import { identity } from "./validation";
import { nativeSessionDirectory } from "./ops-state";

/** Derives a service-owned correlation workspace and shared native store from a persisted opaque intent. */
export function nativeIntentPaths(directory: string, intent: NativeIntent): { workspaceRoot: string; homeDirectory: string; sessionDirectory: string } {
  identity(intent.id);
  const paths = { workspaceRoot: join(directory, "contexts", intent.id), homeDirectory: join(directory, "home"), sessionDirectory: nativeSessionDirectory(directory) };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
  return paths;
}

/** Creates metadata-only public hosts with the shared process lifecycle and no inference or tool capability. */
export function schwayRecovery(directory: string, sessionDirectory?: string): NativeRecoveryPort {
  return { async open(intent) {
    if (hostCapabilities().releaseContract !== RELEASE_CONTRACT || hostCapabilities().sessionInventoryContract !== "schway.host.session-inventory/v1") throw new AppError("s14_recovery_host_unsupported", 503);
    return createHost({ ...nativeIntentPaths(directory, intent), ...(sessionDirectory ? { sessionDirectory } : {}),
      context: { policy: "strict", systemPrompt: "Metadata-only recovery; no inference or tools.", sections: [] },
      tools: { policy: "exact", hostedLookup: "off", definitions: [] },
      limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 },
      auth: { lifecycle: s14CredentialLifecycle(), route: intent.route.provider, model: intent.route.model },
    });
  } };
}

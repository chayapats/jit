import { hostCapabilities, SNAPSHOT_CONTRACT, SNAPSHOT_NATIVE_FORMAT_VERSION, type HostRuntime, type HostSessionSnapshot } from "schway/host";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { schwayRecovery } from "./native-recovery";
import type { NativeIntent } from "./recovery-types";
import type { OpsNativePort } from "./ops-types";

/** Creates metadata-only public snapshot hosts using the same stable workspace and process credential lifecycle as REC14. */
export function schwayOpsNative(directory: string): OpsNativePort {
  return {
    supported: () => hostCapabilities().snapshotContract === SNAPSHOT_CONTRACT,
    async open(intent, sessionDirectory) {
      // schwayRecovery constructs a full public host; its ordinary return type deliberately exposes less.
      return await schwayRecovery(directory, sessionDirectory).open(intent) as HostRuntime;
    },
  };
}
/** Validates only the public envelope and opaque bytes; credential detection never parses or rewrites native records. */
export function validateOpsSnapshot(host: Pick<HostRuntime, "validateSessionSnapshot">, snapshot: unknown, intent: NativeIntent): asserts snapshot is HostSessionSnapshot {
  const verdict = host.validateSessionSnapshot(snapshot);
  if (verdict.status !== "valid" || verdict.sessions.length !== 1 || !intent.reference || verdict.sessions[0]!.id !== intent.reference.id || verdict.sessions[0]!.branchId !== intent.reference.branchId) throw new AppError("s14_ops_native_invalid", 409);
  const value = snapshot as HostSessionSnapshot;
  if (value.snapshotContract !== SNAPSHOT_CONTRACT || value.nativeFormatVersion !== SNAPSHOT_NATIVE_FORMAT_VERSION) throw new AppError("s14_ops_native_unsupported", 409);
  if (containsCredential(JSON.stringify(value))) throw new AppError("s14_ops_credential_excluded", 409);
  for (const session of value.sessions) for (const artifact of session.artifacts) {
    if (containsCredential(Buffer.from(artifact.dataBase64, "base64").toString("utf8"))) throw new AppError("s14_ops_credential_excluded", 409);
  }
}
